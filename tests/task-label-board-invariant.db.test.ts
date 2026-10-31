// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
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
let attacherPid: number | null = null;

async function backendPid(client: pg.Client): Promise<number> {
  const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return result.rows[0]!.pid;
}

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
      [attacherPid]
    );
    if (activity.rows[0]?.wait_event_type === 'Lock') return;
    if (settled) throw new Error('Attachment completed instead of waiting for the concurrent move');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('Attachment did not reach the expected row-lock wait');
}

async function expectRejectedAttachAfterMove(move: string, afterAttachBlocked?: string) {
  await mover!.query('BEGIN');
  await attacher!.query('BEGIN');
  await mover!.query(move);

  const attach = attacher!.query(
    `INSERT INTO "task_labels" ("id", "organizationId", "taskId", "labelId")
     VALUES ('tl', 'org', 'task', 'label')`
  );
  await expectAttachBlocked(attach);

  if (afterAttachBlocked) await mover!.query(afterAttachBlocked);
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
    attacherPid = await backendPid(attacher!);
    await setup!.query(`
      CREATE TABLE "boards" (id text PRIMARY KEY, "organizationId" text NOT NULL);
      CREATE TABLE "columns" (
        id text PRIMARY KEY, "boardId" text NOT NULL, "organizationId" text NOT NULL
      );
      CREATE TABLE "tasks" (
        id text PRIMARY KEY, "columnId" text NOT NULL, "organizationId" text NOT NULL,
        "order" integer NOT NULL DEFAULT 0
      );
      CREATE TABLE "labels" (id text PRIMARY KEY, "boardId" text NOT NULL, "organizationId" text NOT NULL);
      CREATE TABLE "task_labels" (
        id text PRIMARY KEY, "taskId" text NOT NULL, "labelId" text NOT NULL,
        "organizationId" text NOT NULL, UNIQUE ("taskId", "labelId")
      );
      ${migration}
      INSERT INTO "boards" VALUES
        ('board_a', 'org'), ('board_b', 'org'), ('board_other_org', 'other_org');
      INSERT INTO "columns" VALUES
        ('column_a', 'board_a', 'org'),
        ('column_b', 'board_b', 'org'),
        ('column_wrong_org', 'board_a', 'other_org');
      INSERT INTO "tasks" (id, "columnId", "organizationId") VALUES ('task', 'column_a', 'org');
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

  it('removes existing attachments when their board moves to another organization', async () => {
    await setup!.query(
      `INSERT INTO "task_labels" ("id", "organizationId", "taskId", "labelId")
       VALUES ('board_move_org_tl', 'org', 'task', 'label')`
    );
    await setup!.query(
      `UPDATE "boards" SET "organizationId" = 'other_org' WHERE id = 'board_a'`
    );

    const remaining = await setup!.query(
      `SELECT 1 FROM "task_labels" WHERE id = 'board_move_org_tl'`
    );
    expect(remaining.rowCount).toBe(0);
    await setup!.query(`UPDATE "boards" SET "organizationId" = 'org' WHERE id = 'board_a'`);
  });

  it('preserves attachments on a no-op board organization update', async () => {
    await setup!.query(
      `INSERT INTO "task_labels" ("id", "organizationId", "taskId", "labelId")
       VALUES ('board_noop_tl', 'org', 'task', 'label')`
    );
    await setup!.query(`UPDATE "boards" SET "organizationId" = 'org' WHERE id = 'board_a'`);

    const remaining = await setup!.query(
      `SELECT 1 FROM "task_labels" WHERE id = 'board_noop_tl'`
    );
    expect(remaining.rowCount).toBe(1);
    await setup!.query(`DELETE FROM "task_labels" WHERE id = 'board_noop_tl'`);
  });

  it('serializes attachment with a task move and rejects the stale attachment', async () => {
    await expectRejectedAttachAfterMove(
      `UPDATE "tasks" SET "columnId" = 'column_b' WHERE id = 'task'`
    );
    await setup!.query(`UPDATE "tasks" SET "columnId" = 'column_a' WHERE id = 'task'`);
  });

  // moveTask/moveTasks lock columns FOR UPDATE and then update tasks. The guard
  // must take the column before the task, otherwise an attachment holding the
  // task lock and waiting for the column deadlocks with the reorder.
  it('does not deadlock with a same-column reorder that already holds the column lock', async () => {
    await mover!.query('BEGIN');
    await attacher!.query('BEGIN');
    await mover!.query(`SELECT id FROM "columns" WHERE id = 'column_a' FOR UPDATE`);

    const attach = attacher!.query(
      `INSERT INTO "task_labels" ("id", "organizationId", "taskId", "labelId")
       VALUES ('reorder_tl', 'org', 'task', 'label')`
    );
    await expectAttachBlocked(attach);

    // With task-before-column locking this update waits on the attachment and
    // PostgreSQL aborts one side with a deadlock (40P01).
    await mover!.query(`UPDATE "tasks" SET "order" = "order" + 1 WHERE id = 'task'`);
    await mover!.query('COMMIT');
    await attach;
    await attacher!.query('COMMIT');

    const linked = await setup!.query(`SELECT 1 FROM "task_labels" WHERE id = 'reorder_tl'`);
    expect(linked.rowCount).toBe(1);
    await setup!.query(`DELETE FROM "task_labels" WHERE id = 'reorder_tl'`);
    await setup!.query(`UPDATE "tasks" SET "order" = 0 WHERE id = 'task'`);
  });

  it('rejects an attachment racing a column-locked cross-board move without deadlock', async () => {
    await expectRejectedAttachAfterMove(
      `SELECT id FROM "columns" WHERE id IN ('column_a', 'column_b') ORDER BY id FOR UPDATE`,
      `UPDATE "tasks" SET "columnId" = 'column_b', "order" = 0 WHERE id = 'task'`
    );
    await setup!.query(`UPDATE "tasks" SET "columnId" = 'column_a' WHERE id = 'task'`);
  });

  it('removes attachments when a task moves to a column from another organization', async () => {
    await setup!.query(
      `INSERT INTO "task_labels" ("id", "organizationId", "taskId", "labelId")
       VALUES ('task_move_org_tl', 'org', 'task', 'label')`
    );
    await setup!.query(
      `UPDATE "tasks" SET "columnId" = 'column_wrong_org' WHERE id = 'task'`
    );

    const remaining = await setup!.query(
      `SELECT 1 FROM "task_labels" WHERE id = 'task_move_org_tl'`
    );
    expect(remaining.rowCount).toBe(0);
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

  it('serializes attachment with a board organization move and rejects the stale attachment', async () => {
    await setup!.query(`UPDATE "columns" SET "boardId" = 'board_a' WHERE id = 'column_a'`);
    await expectRejectedAttachAfterMove(
      `UPDATE "boards" SET "organizationId" = 'other_org' WHERE id = 'board_a'`
    );
  });
});

const baseTables = `
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
`;

describeIfDatabase('task-label board invariant migration', () => {
  it('cleans every tenant under forced RLS without retaining platform-admin context', async () => {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    const migrationSchema = `task_label_rls_${randomUUID().replaceAll('-', '')}`;

    await client.connect();
    try {
      const role = await client.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      await client.query(`CREATE SCHEMA "${migrationSchema}"`);
      await client.query(`SET search_path TO "${migrationSchema}"`);
      await client.query(`
        ${baseTables}
        INSERT INTO "boards" VALUES
          ('board_a', 'org_a'), ('other_board_a', 'org_a'),
          ('board_b', 'org_b'), ('other_board_b', 'org_b');
        INSERT INTO "columns" VALUES
          ('column_a', 'board_a', 'org_a'), ('column_b', 'board_b', 'org_b');
        INSERT INTO "tasks" VALUES
          ('task_a', 'column_a', 'org_a'), ('task_b', 'column_b', 'org_b');
        INSERT INTO "labels" VALUES
          ('valid_a', 'board_a', 'org_a'), ('invalid_a', 'other_board_a', 'org_a'),
          ('valid_b', 'board_b', 'org_b'), ('invalid_b', 'other_board_b', 'org_b');
        INSERT INTO "task_labels" VALUES
          ('keep_a', 'task_a', 'valid_a', 'org_a'),
          ('remove_a', 'task_a', 'invalid_a', 'org_a'),
          ('keep_b', 'task_b', 'valid_b', 'org_b'),
          ('remove_b', 'task_b', 'invalid_b', 'org_b');
      `);
      for (const table of ['boards', 'columns', 'tasks', 'labels', 'task_labels']) {
        await client.query(`
          ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;
          ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;
          CREATE POLICY tenant_isolation ON "${table}"
            USING (current_setting('app.is_platform_admin', true) = 'true'
              OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
            WITH CHECK (current_setting('app.is_platform_admin', true) = 'true'
              OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
        `);
      }
      await client.query("SELECT set_config('app.is_platform_admin', 'false', false)");
      expect((await client.query('SELECT id FROM "task_labels"')).rows).toEqual([]);

      await client.query(migration);

      const context = await client.query("SELECT current_setting('app.is_platform_admin') AS admin");
      expect(context.rows[0].admin).toBe('false');
      await client.query("SELECT set_config('app.is_platform_admin', 'true', false)");
      const remaining = await client.query('SELECT id FROM "task_labels" ORDER BY id');
      expect(remaining.rows).toEqual([{ id: 'keep_a' }, { id: 'keep_b' }]);
      await client.query("SELECT set_config('app.is_platform_admin', 'false', false)");
      await client.query("SELECT set_config('app.current_organization_id', 'org_a', false)");
      await expect(
        client.query(`INSERT INTO "task_labels" VALUES ('rejected', 'task_a', 'invalid_a', 'org_a')`)
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.query('ROLLBACK');
      await client.query(`DROP SCHEMA IF EXISTS "${migrationSchema}" CASCADE`);
      await client.end();
    }
  });

  it('removes legacy links with mismatched column or board organizations', async () => {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    const migrationSchema = `task_label_cleanup_${randomUUID().replaceAll('-', '')}`;

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${migrationSchema}"`);
      await client.query(`SET search_path TO "${migrationSchema}"`);
      await client.query(`
        ${baseTables}
        INSERT INTO "boards" VALUES ('board_column', 'org'), ('board_wrong_org', 'other_org');
        INSERT INTO "columns" VALUES
          ('column_wrong_org', 'board_column', 'other_org'),
          ('column_wrong_board_org', 'board_wrong_org', 'org');
        INSERT INTO "tasks" VALUES
          ('task_bad_column', 'column_wrong_org', 'org'),
          ('task_bad_board', 'column_wrong_board_org', 'org');
        INSERT INTO "labels" VALUES
          ('label_column', 'board_column', 'org'),
          ('label_board', 'board_wrong_org', 'org');
        INSERT INTO "task_labels" VALUES
          ('link_bad_column', 'task_bad_column', 'label_column', 'org'),
          ('link_bad_board', 'task_bad_board', 'label_board', 'org');
        ${migration}
      `);

      const remaining = await client.query(`SELECT id FROM "task_labels"`);
      expect(remaining.rows).toEqual([]);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${migrationSchema}" CASCADE`);
      await client.end();
    }
  });

  it('serializes an old-application insert with cleanup and guard installation', async () => {
    const migrationClient = new pg.Client({ connectionString: DATABASE_URL });
    const writer = new pg.Client({ connectionString: DATABASE_URL });
    const observer = new pg.Client({ connectionString: DATABASE_URL });
    const blocker = new pg.Client({ connectionString: DATABASE_URL });
    const migrationSchema = `task_label_install_${randomUUID().replaceAll('-', '')}`;
    const advisoryKey = 880506;

    await Promise.all([
      migrationClient.connect(),
      writer.connect(),
      observer.connect(),
      blocker.connect(),
    ]);
    try {
      await observer.query(`CREATE SCHEMA "${migrationSchema}"`);
      await observer.query(`SET search_path TO "${migrationSchema}"`);
      await observer.query(`
        ${baseTables}
        INSERT INTO "boards" VALUES ('board_a', 'org'), ('board_b', 'org');
        INSERT INTO "columns" VALUES ('column_a', 'board_a', 'org');
        INSERT INTO "tasks" VALUES ('task', 'column_a', 'org');
        INSERT INTO "labels" VALUES ('wrong_label', 'board_b', 'org');
      `);
      for (const client of [migrationClient, writer, blocker]) {
        await client.query(`SET search_path TO "${migrationSchema}"`);
      }
      const migrationPid = await backendPid(migrationClient);
      const writerPid = await backendPid(writer);

      await blocker.query(`SELECT pg_advisory_lock(${advisoryKey})`);
      const instrumentedMigration = migration.replace(
        'IN SHARE ROW EXCLUSIVE MODE;',
        `IN SHARE ROW EXCLUSIVE MODE; SELECT pg_advisory_xact_lock(${advisoryKey});`
      );
      const applying = migrationClient.query(instrumentedMigration);

      await waitForLock(observer, migrationPid);
      const inserting = writer.query(
        `INSERT INTO "task_labels" VALUES ('racing_link', 'task', 'wrong_label', 'org')`
      );
      await waitForLock(observer, writerPid);

      await blocker.query(`SELECT pg_advisory_unlock(${advisoryKey})`);
      await applying;
      await expect(inserting).rejects.toMatchObject({ code: '23514' });
      const remaining = await observer.query(`SELECT id FROM "task_labels"`);
      expect(remaining.rows).toEqual([]);
    } finally {
      await blocker.query(`SELECT pg_advisory_unlock(${advisoryKey})`).catch(() => undefined);
      await observer.query(`DROP SCHEMA IF EXISTS "${migrationSchema}" CASCADE`);
      await Promise.allSettled([
        migrationClient.end(),
        writer.end(),
        observer.end(),
        blocker.end(),
      ]);
    }
  });
});

async function waitForLock(observer: pg.Client, processID: number) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const activity = await observer.query<{ wait_event_type: string | null }>(
      `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
      [processID]
    );
    if (activity.rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Database process ${processID} did not reach the expected lock wait`);
}
