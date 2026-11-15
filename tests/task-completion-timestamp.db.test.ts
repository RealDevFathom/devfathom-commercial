// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;
const migration = readFileSync(
  'prisma/migrations/20261115120000_task_completion_timestamp/migration.sql',
  'utf8'
);

(url ? describe : describe.skip)('task completion migration and model invariant', () => {
  it('tracks every writer, preserves edits, clears reopenings and never backfills from updatedAt', async () => {
    const db = new Client({ connectionString: url });
    const schema = `task_completion_${randomUUID().replaceAll('-', '')}`;
    await db.connect();
    try {
      await db.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
      await db.query(`
        CREATE TABLE columns (id text PRIMARY KEY, "organizationId" text, name text);
        CREATE TABLE tasks (id text PRIMARY KEY, "organizationId" text, "columnId" text REFERENCES columns,
          title text, "order" int DEFAULT 0, "updatedAt" timestamp(3) DEFAULT now());
        INSERT INTO columns VALUES ('todo', 'org', 'To Do'), ('done', 'org', 'Done'), ('done2', 'org', 'Done');
        INSERT INTO tasks (id, "organizationId", "columnId") VALUES ('legacy', 'org', 'done');
      `);
      await db.query(migration);
      const completion = async (id: string) =>
        (await db.query('SELECT "completedAt" FROM tasks WHERE id = $1', [id])).rows[0].completedAt;
      expect(await completion('legacy')).toBeNull();
      await db.query(`UPDATE tasks SET title = 'Edited old Done task', "updatedAt" = now()`);
      expect(await completion('legacy')).toBeNull();

      // All interfaces issue these same INSERT/UPDATE operations, including bulk moves.
      await db.query(`INSERT INTO tasks (id, "organizationId", "columnId") VALUES
        ('created-done', 'org', 'done'), ('moved', 'org', 'todo'), ('bulk', 'org', 'todo')`);
      expect(await completion('created-done')).toBeInstanceOf(Date);
      expect(await completion('moved')).toBeNull();
      await db.query(`UPDATE tasks SET "columnId" = 'done' WHERE id IN ('moved', 'bulk')`);
      const first = await completion('moved');
      expect(first).toBeInstanceOf(Date);
      expect(await completion('bulk')).toEqual(first);
      await db.query(
        `UPDATE tasks SET title = 'Edit', "order" = 4, "updatedAt" = now() WHERE id = 'moved'`
      );
      await db.query(`UPDATE tasks SET "columnId" = 'done' WHERE id = 'moved'`);
      await db.query(`UPDATE tasks SET "columnId" = 'done2' WHERE id = 'moved'`);
      expect(await completion('moved')).toEqual(first);
      await db.query(`UPDATE tasks SET "columnId" = 'todo' WHERE id = 'moved'`);
      expect(await completion('moved')).toBeNull();
      await db.query(`UPDATE tasks SET "columnId" = 'done' WHERE id = 'moved'`);
      expect((await completion('moved')).getTime()).toBeGreaterThanOrEqual(first.getTime());

      // Idempotent deployment must preserve previously recorded completions.
      const before = await completion('moved');
      await db.query(migration);
      expect(await completion('moved')).toEqual(before);
      expect(await completion('legacy')).toBeNull();
      await db.query(`UPDATE columns SET name = 'Reopened' WHERE id = 'done'`);
      expect(await completion('moved')).toBeNull();
      await db.query(`UPDATE columns SET name = 'Done' WHERE id = 'done'`);
      expect(await completion('moved')).toBeInstanceOf(Date);
    } finally {
      await db.query('ROLLBACK');
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.end();
    }
  });
});
