// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;
// The schema owner builds the fixture and applies the migration; every checked
// behaviour runs on the restricted runtime connection (`url`) under forced RLS.
const ownerUrl = process.env.OWNER_DATABASE_URL;
const migration = readFileSync(
  'prisma/migrations/20261115120000_task_completion_timestamp/migration.sql',
  'utf8'
);

(url ? describe : describe.skip)('task completion migration and model invariant', () => {
  it('tracks every writer, preserves edits, clears reopenings and never backfills from updatedAt', async () => {
    const db = new Client({ connectionString: url });
    const owner = ownerUrl ? new Client({ connectionString: ownerUrl }) : db;
    const schema = `task_completion_${randomUUID().replaceAll('-', '')}`;
    await db.connect();
    if (owner !== db) await owner.connect();
    try {
      const {
        rows: [role],
      } = await db.query(
        'SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      expect({ rolsuper: role.rolsuper, rolbypassrls: role.rolbypassrls }).toEqual({
        rolsuper: false,
        rolbypassrls: false,
      });
      await owner.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
      await owner.query(`
        CREATE TABLE columns (id text PRIMARY KEY, "organizationId" text, name text);
        CREATE TABLE tasks (id text PRIMARY KEY, "organizationId" text, "columnId" text REFERENCES columns,
          title text, "order" int DEFAULT 0, "updatedAt" timestamp(3) DEFAULT now());
      `);
      // The production tenant boundary on both tables the migration touches.
      for (const table of ['columns', 'tasks']) {
        await owner.query(`
          ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
          ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
          CREATE POLICY tenant_isolation ON ${table}
            USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
            WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))`);
      }
      await owner.query('BEGIN');
      await owner.query("SELECT set_config('app.current_organization_id', 'org', true)");
      await owner.query(`
        INSERT INTO columns VALUES ('todo', 'org', 'To Do'), ('done', 'org', 'Done'), ('done2', 'org', 'Done');
        INSERT INTO tasks (id, "organizationId", "columnId") VALUES ('legacy', 'org', 'done');
      `);
      await owner.query('COMMIT');
      await owner.query(migration);
      if (owner !== db) {
        const runtime = `"${String(role.name).replaceAll('"', '""')}"`;
        await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${runtime};
          GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${runtime}`);
      }
      await db.query(`SET search_path TO "${schema}"`);
      await db.query("SELECT set_config('app.current_organization_id', 'org', false)");
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
      await owner.query(migration);
      expect(await completion('moved')).toEqual(before);
      expect(await completion('legacy')).toBeNull();
      await db.query(`UPDATE columns SET name = 'Reopened' WHERE id = 'done'`);
      expect(await completion('moved')).toBeNull();
      await db.query(`UPDATE columns SET name = 'Done' WHERE id = 'done'`);
      expect(await completion('moved')).toBeInstanceOf(Date);
    } finally {
      await db.query('ROLLBACK');
      if (owner !== db) await owner.query('ROLLBACK');
      await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.end();
      if (owner !== db) await owner.end();
    }
  });
});

(url ? describe : describe.skip)('task completion invariant on the migrated tables', () => {
  it('records and clears completion for the restricted runtime role', async () => {
    const client = new Client({ connectionString: url });
    const id = (name: string) => `${name}_${randomUUID().replaceAll('-', '')}`;
    const [org, user, project, board, todo, done, task] = [
      'org',
      'user',
      'project',
      'board',
      'todo',
      'done',
      'task',
    ].map(id);
    const completion = async () =>
      (await client.query('SELECT "completedAt" FROM tasks WHERE id = $1', [task])).rows[0]
        .completedAt;
    const move = (column: string) =>
      client.query('UPDATE tasks SET "columnId" = $1 WHERE id = $2', [column, task]);
    await client.connect();
    try {
      const {
        rows: [role],
      } = await client.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path TO public');
      // Only creating the organization row needs platform scope.
      await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
      await client.query(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", "updatedAt")
         VALUES ($1, $1, 'Task completion test', 'Task completion test', now())`,
        [org]
      );
      await client.query("SELECT set_config('app.is_platform_admin', '', true)");
      await client.query("SELECT set_config('app.current_organization_id', $1, true)", [org]);
      await client.query(
        `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
         VALUES ($1, $2, 'ENGINEERING', 'Engineering', now())`,
        [id('department'), org]
      );
      await client.query(
        `INSERT INTO users (id, "organizationId", name, email, department, title, "updatedAt")
         VALUES ($1, $2, 'Actor', $3, 'ENGINEERING', 'Tester', now())`,
        [user, org, `${user}@example.test`]
      );
      await client.query(
        `INSERT INTO projects (id, "organizationId", name, type, "updatedAt")
         VALUES ($1, $2, 'Project', 'INTERNAL', now())`,
        [project, org]
      );
      await client.query(
        `INSERT INTO boards (id, "organizationId", name, "projectId", "updatedAt")
         VALUES ($1, $2, 'Board', $3, now())`,
        [board, org, project]
      );
      for (const [column, name, order] of [
        [todo, 'To Do', 0],
        [done, 'Done', 1],
      ]) {
        await client.query(
          `INSERT INTO columns (id, "organizationId", name, "boardId", "order", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, now())`,
          [column, org, name, board, order]
        );
      }
      await client.query(
        `INSERT INTO tasks (id, "organizationId", title, "columnId", "order", "createdById", "updatedAt")
         VALUES ($1, $2, 'Task', $3, 0, $4, now())`,
        [task, org, todo, user]
      );

      expect(await completion()).toBeNull();
      await move(done);
      expect(await completion()).toBeInstanceOf(Date);
      await move(todo);
      expect(await completion()).toBeNull();
      await move(done);
      await client.query(`UPDATE columns SET name = 'Reopened' WHERE id = $1`, [done]);
      expect(await completion()).toBeNull();
      await client.query(`UPDATE columns SET name = 'Done' WHERE id = $1`, [done]);
      expect(await completion()).toBeInstanceOf(Date);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
});
