import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDatabase = DATABASE_URL ? describe : describe.skip;
const schema = `task_label_race_${randomUUID().replaceAll('-', '')}`;
const migration = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261026120000_task_label_board_invariant/migration.sql'
  ),
  'utf8'
);
const setup = DATABASE_URL ? new pg.Client({ connectionString: DATABASE_URL }) : null;
const mover = DATABASE_URL ? new pg.Client({ connectionString: DATABASE_URL }) : null;
const attacher = DATABASE_URL ? new pg.Client({ connectionString: DATABASE_URL }) : null;

async function expectAttachBlocked(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const activity = await setup!.query<{ wait_event_type: string | null }>(
      `SELECT wait_event_type
         FROM pg_stat_activity
        WHERE pid = $1`,
      [attacher!.processID]
    );
    if (activity.rows[0]?.wait_event_type === 'Lock') return;
    if (settled) throw new Error('Attachment completed instead of waiting for the concurrent move');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('Attachment did not reach the expected row-lock wait');
}

async function expectRejectedAttachAfterMove(move: string) {
  await mover!.query('BEGIN');
  await attacher!.query('BEGIN');
  await mover!.query(move);

  const attach = attacher!.query(
    `INSERT INTO "task_labels" ("id", "organizationId", "taskId", "labelId")
     VALUES ('tl', 'org', 'task', 'label')`
  );
  await expectAttachBlocked(attach);

  await mover!.query('COMMIT');
  await expect(attach).rejects.toMatchObject({ code: '23514' });
  await attacher!.query('ROLLBACK');

  const invalid = await setup!.query(
    `SELECT 1
       FROM "task_labels" tl
       JOIN "tasks" t ON t.id = tl."taskId"
       JOIN "columns" c ON c.id = t."columnId"
       JOIN "labels" l ON l.id = tl."labelId"
      WHERE c."boardId" <> l."boardId"`
  );
  expect(invalid.rowCount).toBe(0);
}

describeIfDatabase('task-label board invariant concurrency', () => {
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(DATABASE_URL!).hostname)) {
      throw new Error('Refusing to run task-label concurrency probes against a non-local database.');
    }
    await Promise.all([setup!.connect(), mover!.connect(), attacher!.connect()]);
    await setup!.query(`CREATE SCHEMA "${schema}"`);
    for (const client of [setup!, mover!, attacher!]) {
      await client.query(`SET search_path TO "${schema}"`);
    }
    await setup!.query(`
      CREATE TABLE "boards" (id text PRIMARY KEY, "organizationId" text NOT NULL);
      CREATE TABLE "columns" (
        id text PRIMARY KEY, "boardId" text NOT NULL, "organizationId" text NOT NULL
      );
      CREATE TABLE "tasks" (id text PRIMARY KEY, "columnId" text NOT NULL, "organizationId" text NOT NULL);
      CREATE TABLE "labels" (id text PRIMARY KEY, "boardId" text NOT NULL, "organizationId" text NOT NULL);
      CREATE TABLE "task_labels" (
        id text PRIMARY KEY, "taskId" text NOT NULL, "labelId" text NOT NULL,
        "organizationId" text NOT NULL, UNIQUE ("taskId", "labelId")
      );
      ${migration}
      INSERT INTO "boards" VALUES
        ('board_a', 'org'), ('board_b', 'org'), ('board_other_org', 'other_org');
      INSERT INTO "columns" VALUES
        ('column_a', 'board_a', 'org'), ('column_b', 'board_b', 'org');
      INSERT INTO "tasks" VALUES ('task', 'column_a', 'org');
      INSERT INTO "labels" VALUES ('label', 'board_a', 'org');
    `);
  });

  afterAll(async () => {
    await Promise.allSettled([mover?.query('ROLLBACK'), attacher?.query('ROLLBACK')]);
    await setup?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await Promise.allSettled([setup?.end(), mover?.end(), attacher?.end()]);
  });

  it('removes existing attachments when their column moves to another board', async () => {
    await setup!.query(
      `INSERT INTO "task_labels" ("id", "organizationId", "taskId", "labelId")
       VALUES ('existing_tl', 'org', 'task', 'label')`
    );
    await setup!.query(`UPDATE "columns" SET "boardId" = 'board_b' WHERE id = 'column_a'`);

    const remaining = await setup!.query(
      `SELECT 1 FROM "task_labels" WHERE id = 'existing_tl'`
    );
    expect(remaining.rowCount).toBe(0);
    await setup!.query(`UPDATE "columns" SET "boardId" = 'board_a' WHERE id = 'column_a'`);
  });

  it('removes existing attachments when their column moves to another organization board', async () => {
    await setup!.query(
      `INSERT INTO "task_labels" ("id", "organizationId", "taskId", "labelId")
       VALUES ('existing_org_tl', 'org', 'task', 'label')`
    );
    await setup!.query(
      `UPDATE "columns" SET "boardId" = 'board_other_org' WHERE id = 'column_a'`
    );

    const remaining = await setup!.query(
      `SELECT 1 FROM "task_labels" WHERE id = 'existing_org_tl'`
    );
    expect(remaining.rowCount).toBe(0);
    await setup!.query(`UPDATE "columns" SET "boardId" = 'board_a' WHERE id = 'column_a'`);
  });

  it('serializes attachment with a task move and rejects the stale attachment', async () => {
    await expectRejectedAttachAfterMove(
      `UPDATE "tasks" SET "columnId" = 'column_b' WHERE id = 'task'`
    );
    await setup!.query(`UPDATE "tasks" SET "columnId" = 'column_a' WHERE id = 'task'`);
  });

  it('serializes attachment with a label move and rejects the stale attachment', async () => {
    await expectRejectedAttachAfterMove(
      `UPDATE "labels" SET "boardId" = 'board_b' WHERE id = 'label'`
    );
    await setup!.query(`UPDATE "labels" SET "boardId" = 'board_a' WHERE id = 'label'`);
  });

  it('serializes attachment with a column move and rejects the stale attachment', async () => {
    await expectRejectedAttachAfterMove(
      `UPDATE "columns" SET "boardId" = 'board_b' WHERE id = 'column_a'`
    );
  });
});
