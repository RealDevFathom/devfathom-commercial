// @vitest-environment node
/**
 * DEV-250 / #450: the `Task.completedAt` migration backfills each task already in
 * a done column from the best evidence of when it ENTERED done — completion
 * activity, recorded column moves, recorded creation straight into done — and
 * falls back to `updatedAt` only when there is none. Copying `updatedAt` for
 * every task would keep the exact false positive the fix removes (an old Done
 * task edited yesterday would still look completed yesterday).
 *
 * Runs the real migration file inside one transaction against a migrated
 * database (dropping the column first so the migration can add it again) and
 * rolls everything back. Requires OWNER_DATABASE_URL (the schema owner: the test
 * performs DDL). Without it the suite reports itself skipped.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

const url = process.env.OWNER_DATABASE_URL;
const client = new pg.Client({ connectionString: url });
const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
const org = `dev250_backfill_${suffix}`;
const otherOrg = `${org}_other`;
const id = (key: string) => `${org}_${key}`;
const migration = readFileSync(
  'prisma/migrations/20261102090300_task_completed_at/migration.sql',
  'utf8'
)
  .replace(/^BEGIN;$/m, '')
  .replace(/^COMMIT;$/m, '');

const at = (iso: string) => new Date(`2026-${iso}Z`);
const CREATOR = id('creator');
const TODO = id('col_todo');
const DONE = id('col_done');
const CLOSED = id('col_closed');

type Fixture = {
  key: string;
  column: string;
  createdAt: Date;
  updatedAt: Date;
  /** What the backfill must write. */
  expected: Date | null;
};

const fixtures: Fixture[] = [
  // Completed in-app on 09-10, then merely edited on 10-30: the reported bug.
  {
    key: 'edited',
    column: DONE,
    createdAt: at('09-01T09:00:00'),
    updatedAt: at('10-30T12:00:00'),
    expected: at('09-10T00:00:00.200'),
  },
  // Completed, reopened in-app, then bulk-moved back into done (bulk moves log no activity).
  {
    key: 'reopened',
    column: DONE,
    createdAt: at('09-01T09:00:00'),
    updatedAt: at('10-25T12:00:00'),
    expected: at('09-20T08:00:00'),
  },
  // Created straight into Done in-app, later only reordered inside it.
  {
    key: 'born_done',
    column: DONE,
    createdAt: at('09-03T10:00:00'),
    updatedAt: at('10-20T12:00:00'),
    expected: at('09-03T10:00:00'),
  },
  // Created straight into Done by the assistant.
  {
    key: 'born_done_ai',
    column: DONE,
    createdAt: at('09-04T10:00:00'),
    updatedAt: at('10-21T12:00:00'),
    expected: at('09-04T10:00:00'),
  },
  // Moved into "Closed" by the assistant (its audit row carries column names).
  {
    key: 'ai_move',
    column: CLOSED,
    createdAt: at('09-01T09:00:00'),
    updatedAt: at('10-22T12:00:00'),
    expected: at('09-08T15:00:00'),
  },
  // Two completions with an unrecorded (REST) exit between: the latest counts.
  {
    key: 'recompleted',
    column: DONE,
    createdAt: at('08-01T09:00:00'),
    updatedAt: at('10-28T12:00:00'),
    expected: at('09-25T11:00:00'),
  },
  // No evidence at all: last-resort updatedAt.
  {
    key: 'no_evidence',
    column: DONE,
    createdAt: at('08-01T09:00:00'),
    updatedAt: at('10-15T12:00:00'),
    expected: at('10-15T12:00:00'),
  },
  // A recorded exit with no recorded re-entry: last-resort updatedAt.
  {
    key: 'exit_only',
    column: DONE,
    createdAt: at('08-01T09:00:00'),
    updatedAt: at('10-10T12:00:00'),
    expected: at('10-10T12:00:00'),
  },
  // Not in a done column: stays NULL whatever its history.
  {
    key: 'open',
    column: TODO,
    createdAt: at('08-01T09:00:00'),
    updatedAt: at('10-11T12:00:00'),
    expected: null,
  },
  // Evidence later than updatedAt (a back-dated seed) is capped at updatedAt.
  {
    key: 'capped',
    column: DONE,
    createdAt: at('08-01T09:00:00'),
    updatedAt: at('10-01T12:00:00'),
    expected: at('10-01T12:00:00'),
  },
  // A move into a since-deleted column is an exit; the later move into done starts the stint.
  {
    key: 'gone_column',
    column: DONE,
    createdAt: at('08-01T09:00:00'),
    updatedAt: at('10-12T12:00:00'),
    expected: at('09-07T09:00:00'),
  },
  // A failed move is not an exit.
  {
    key: 'failed_move',
    column: DONE,
    createdAt: at('08-01T09:00:00'),
    updatedAt: at('10-13T12:00:00'),
    expected: at('09-02T09:00:00'),
  },
  // Another organization's rows never count as evidence.
  {
    key: 'foreign',
    column: DONE,
    createdAt: at('08-01T09:00:00'),
    updatedAt: at('10-14T12:00:00'),
    expected: at('10-14T12:00:00'),
  },
];

async function activity(key: string, createdAt: Date, organizationId = org, userId = CREATOR) {
  await client.query(
    `INSERT INTO activities (id, "organizationId", type, message, "userId", "entityType", "entityId", "createdAt")
     VALUES ($1, $2, 'task_completed', 'completed a task', $3, 'Task', $4, $5)`,
    [`${id(key)}_act_${createdAt.getTime()}`, organizationId, userId, id(key), createdAt]
  );
}

async function audit(
  key: string,
  createdAt: Date,
  row: {
    action: string;
    source?: 'TRPC' | 'SYSTEM';
    input?: unknown;
    changes?: unknown;
    metadata?: unknown;
    targetId?: string;
    outcome?: 'SUCCESS' | 'FAILURE';
  }
) {
  await client.query(
    `INSERT INTO audit_logs (id, "organizationId", "createdAt", "actorId", source, category, action,
                             "targetType", "targetId", input, changes, metadata, outcome)
     VALUES ($1, $2, $3, $4, $5::"AuditSource", 'TASK', $6, $7, $8, $9, $10, $11, $12::"AuditOutcome")`,
    [
      `${id(key)}_audit_${row.action}_${createdAt.getTime()}`,
      org,
      createdAt,
      CREATOR,
      row.source ?? 'TRPC',
      row.action,
      row.targetId ? 'Task' : null,
      row.targetId ?? null,
      row.input === undefined ? null : JSON.stringify(row.input),
      row.changes === undefined ? null : JSON.stringify(row.changes),
      row.metadata === undefined ? null : JSON.stringify(row.metadata),
      row.outcome ?? 'SUCCESS',
    ]
  );
}

const move = (key: string, targetColumnId: string, createdAt: Date, outcome?: 'FAILURE') =>
  audit(key, createdAt, {
    action: 'projects.moveTask',
    input: { taskId: id(key), targetColumnId, newOrder: 0 },
    outcome,
  });

(url ? describe : describe.skip)('Task.completedAt backfill (DEV-250)', () => {
  beforeAll(async () => {
    assertDisposableRlsDatabase(url!);
    await client.connect();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    // The database is already migrated: remove the column so the migration under
    // test adds and backfills it again. Rolled back with everything else.
    await client.query(`ALTER TABLE tasks DROP COLUMN IF EXISTS "completedAt"`);

    for (const organizationId of [org, otherOrg]) {
      await client.query(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", "updatedAt")
         VALUES ($1, $1, $1, $1, now())`,
        [organizationId]
      );
      await client.query(
        `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
         VALUES ($1, $2, 'OPS', 'Operations', now())`,
        [`${organizationId}_dept`, organizationId]
      );
    }
    await client.query(
      `INSERT INTO users (id, "organizationId", name, email, role, department, title, "updatedAt")
       VALUES ($1, $2, 'Creator', $1 || '@test.invalid', 'ADMIN', 'OPS', 'Lead', now()),
              ($3, $4, 'Other', $3 || '@test.invalid', 'ADMIN', 'OPS', 'Lead', now())`,
      [CREATOR, org, `${otherOrg}_user`, otherOrg]
    );
    await client.query(
      `INSERT INTO projects (id, "organizationId", name, type, "updatedAt")
       VALUES ($1, $2, 'Backfill', 'INTERNAL', now())`,
      [id('project'), org]
    );
    await client.query(
      `INSERT INTO boards (id, "organizationId", name, "projectId", "updatedAt")
       VALUES ($1, $2, 'Board', $3, now())`,
      [id('board'), org, id('project')]
    );
    await client.query(
      `INSERT INTO columns (id, "organizationId", name, "boardId", "order", "updatedAt")
       VALUES ($1, $4, 'To Do', $5, 0, now()), ($2, $4, 'Done', $5, 1, now()),
              ($3, $4, 'Closed', $5, 2, now())`,
      [TODO, DONE, CLOSED, org, id('board')]
    );
    for (const f of fixtures) {
      await client.query(
        `INSERT INTO tasks (id, "organizationId", title, "columnId", "order", "createdById", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 0, $5, $6, $7)`,
        [id(f.key), org, `Task ${f.key}`, f.column, CREATOR, f.createdAt, f.updatedAt]
      );
    }

    // edited: in-app move into Done (audit) + its completion activity.
    await move('edited', DONE, at('09-10T00:00:00.100'));
    await activity('edited', at('09-10T00:00:00.200'));
    // reopened: completed, moved back to To Do, bulk-moved into Done.
    await activity('reopened', at('09-05T08:00:00'));
    await move('reopened', TODO, at('09-12T08:00:00'));
    await audit('reopened', at('09-20T08:00:00'), {
      action: 'projects.bulkMoveTasks',
      input: { taskIds: [id('unrelated'), id('reopened')], targetColumnId: DONE },
    });
    // born_done: createTask into Done a second after the row, then a reorder.
    await audit('born_done', at('09-03T10:00:01'), {
      action: 'projects.createTask',
      input: { title: 'Task born_done', columnId: DONE, priority: 'MEDIUM' },
    });
    await move('born_done', DONE, at('09-15T10:00:00'));
    // born_done_ai: the assistant's create audit names the task and its column.
    await audit('born_done_ai', at('09-04T10:00:01'), {
      action: 'assistant.task.create',
      source: 'SYSTEM',
      targetId: id('born_done_ai'),
      metadata: { project: 'Backfill', column: 'Done', via: 'assistant' },
    });
    // ai_move
    await audit('ai_move', at('09-08T15:00:00'), {
      action: 'assistant.task.move',
      source: 'SYSTEM',
      targetId: id('ai_move'),
      changes: { column: { before: 'To Do', after: 'Closed' } },
    });
    // recompleted: two completion activities (REST logs no move audit).
    await activity('recompleted', at('08-20T11:00:00'));
    await activity('recompleted', at('09-25T11:00:00'));
    // exit_only
    await activity('exit_only', at('09-01T09:00:00'));
    await move('exit_only', TODO, at('09-09T09:00:00'));
    // open
    await activity('open', at('09-01T09:00:00'));
    // capped
    await activity('capped', at('10-05T09:00:00'));
    // gone_column
    await activity('gone_column', at('09-01T09:00:00'));
    await move('gone_column', id('deleted_column'), at('09-05T09:00:00'));
    await move('gone_column', DONE, at('09-07T09:00:00'));
    // failed_move
    await activity('failed_move', at('09-02T09:00:00'));
    await move('failed_move', TODO, at('09-06T09:00:00'), 'FAILURE');
    // foreign: a completion activity filed under another organization.
    await activity('foreign', at('09-30T09:00:00'), otherOrg, `${otherOrg}_user`);

    // The tenant FKs are DEFERRABLE INITIALLY DEFERRED; check them now so the
    // migration's ALTER TABLE does not meet pending trigger events (in a real
    // deploy the migration runs in its own transaction with none).
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query(migration);
  }, 60_000);

  afterAll(async () => {
    if (!url) return;
    await client.query('ROLLBACK');
    await client.end();
  });

  it('adds the nullable column and its tenant-scoped index', async () => {
    const column = await client.query(
      `SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_name = 'tasks' AND column_name = 'completedAt'`
    );
    expect(column.rows).toEqual([{ is_nullable: 'YES', data_type: 'timestamp without time zone' }]);
    const index = await client.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'tasks' AND indexname = 'tasks_organizationId_completedAt_idx'`
    );
    expect(index.rows[0]?.indexdef).toContain('("organizationId", "completedAt")');
  });

  it.each(fixtures.map((f) => [f.key, f] as const))(
    'backfills %s from the best evidence of entering done',
    async (_key, f) => {
      const { rows } = await client.query<{ completedAt: Date | null }>(
        `SELECT "completedAt" FROM tasks WHERE id = $1`,
        [id(f.key)]
      );
      expect(rows[0]!.completedAt).toEqual(f.expected);
    }
  );

  it('never leaves a done task without a completion or an open task with one', async () => {
    const { rows } = await client.query<{ mismatched: number }>(
      `SELECT count(*)::int AS mismatched FROM tasks t JOIN columns c ON c.id = t."columnId"
        WHERE t."organizationId" = $1
          AND (lower(c.name) IN ('done', 'complete', 'completed', 'shipped', 'closed')) <> (t."completedAt" IS NOT NULL)`,
      [org]
    );
    expect(rows[0]!.mismatched).toBe(0);
  });

  it('re-runs without changing any completedAt, including one the application set', async () => {
    await client.query('SAVEPOINT rerun');
    try {
      const appSet = at('10-31T08:00:00');
      await client.query(`UPDATE tasks SET "completedAt" = $2 WHERE id = $1`, [
        id('edited'),
        appSet,
      ]);
      await client.query(migration);
      const { rows } = await client.query<{ id: string; completedAt: Date | null }>(
        `SELECT id, "completedAt" FROM tasks WHERE "organizationId" = $1`,
        [org]
      );
      const byId = new Map(rows.map((row) => [row.id, row.completedAt]));
      for (const f of fixtures) {
        expect(byId.get(id(f.key))).toEqual(f.key === 'edited' ? appSet : f.expected);
      }
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT rerun');
    }
  });
});
