// @vitest-environment node
/**
 * #410 migration: `tasks.completedAt` backfill and the trigger that maintains it.
 *
 * The backfill must not turn `updatedAt` into a completion time (an edit moves
 * updatedAt, which is exactly the false completion the issue reports). It takes a
 * Done task's most recent `task_completed` activity, or leaves NULL. The trigger
 * stamps the move into Done and clears completedAt anywhere else, whatever writes
 * the row.
 *
 * Each case runs as the restricted runtime role under forced row-level security,
 * inside one transaction that is rolled back.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const sql = readFileSync(
  'prisma/migrations/20261023091000_task_completed_at/migration.sql',
  'utf8'
);

// Statements without comments, keeping quoted text and $$-bodies intact.
function statements(source: string): string[] {
  const out: string[] = [];
  let current = '';
  const tokens =
    source.match(/\$\$[\s\S]*?\$\$|'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\r\n]*|;|[^'"$;-]+|./g) ?? [];
  for (const token of tokens) {
    if (token.startsWith('--')) current += ' ';
    else if (token === ';') {
      if (current.trim()) out.push(current.trim());
      current = '';
    } else current += token;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

const backfill = statements(sql).find((s) => s.startsWith('UPDATE "tasks"'));
const DAY = 86_400_000;
const utc = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '');
const parse = (value: string | null) => (value ? new Date(`${value.replace(' ', 'T')}Z`) : null);

async function withTenantFixture(
  run: (ctx: {
    client: Client;
    org: string;
    done: string;
    todo: string;
    task: (opts: { columnId: string; createdAt: Date; updatedAt: Date }) => Promise<string>;
    activity: (opts: { taskId: string; at: Date; org?: string; type?: string }) => Promise<void>;
    completedAt: (taskId: string) => Promise<Date | null>;
  }) => Promise<void>
) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const suffix = randomBytes(6).toString('hex');
  const id = (name: string) => `t410_${name}_${suffix}`;
  let sequence = 0;
  try {
    const {
      rows: [role],
    } = await client.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });

    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const at = utc(new Date());
    for (const org of [id('org'), id('other')]) {
      await client.query(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", "updatedAt")
         VALUES ($1, $1, $1, $1, $2::timestamp)`,
        [org, at]
      );
      await client.query(
        `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
         VALUES ($1, $2, 'OPS', 'Operations', $3::timestamp)`,
        [`${org}_dept`, org, at]
      );
      await client.query(
        `INSERT INTO users (id, "organizationId", name, email, role, department, title, "updatedAt")
         VALUES ($1, $2, 'U', $1 || '@test.invalid', 'ADMIN', 'OPS', 'Lead', $3::timestamp)`,
        [`${org}_user`, org, at]
      );
    }
    const org = id('org');
    await client.query(
      `INSERT INTO projects (id, "organizationId", name, type, "updatedAt")
       VALUES ($1, $2, 'P', 'INTERNAL', $3::timestamp)`,
      [id('project'), org, at]
    );
    await client.query(
      `INSERT INTO boards (id, "organizationId", name, "projectId", "updatedAt")
       VALUES ($1, $2, 'B', $3, $4::timestamp)`,
      [id('board'), org, id('project'), at]
    );
    await client.query(
      `INSERT INTO columns (id, "organizationId", name, "boardId", "order", "updatedAt")
       VALUES ($1, $3, 'Done', $4, 1, $5::timestamp), ($2, $3, 'To Do', $4, 0, $5::timestamp)`,
      [id('done'), id('todo'), org, id('board'), at]
    );

    await run({
      client,
      org,
      done: id('done'),
      todo: id('todo'),
      task: async ({ columnId, createdAt, updatedAt }) => {
        const taskId = id(`task${++sequence}`);
        await client.query(
          `INSERT INTO tasks (id, "organizationId", title, "columnId", "order", "createdById",
             "createdAt", "updatedAt")
           VALUES ($1, $2, $1, $3, 0, $4, $5::timestamp, $6::timestamp)`,
          [taskId, org, columnId, `${org}_user`, utc(createdAt), utc(updatedAt)]
        );
        return taskId;
      },
      activity: async ({ taskId, at: when, org: activityOrg = org, type = 'task_completed' }) => {
        await client.query(
          `INSERT INTO activities (id, "organizationId", type, message, "userId", "entityType",
             "entityId", "createdAt")
           VALUES ($1, $2, $3, 'm', $4, 'Task', $5, $6::timestamp)`,
          [id(`activity${++sequence}`), activityOrg, type, `${activityOrg}_user`, taskId, utc(when)]
        );
      },
      completedAt: async (taskId) =>
        parse(
          (
            await client.query<{ value: string | null }>(
              `SELECT "completedAt"::text AS value FROM tasks WHERE id = $1`,
              [taskId]
            )
          ).rows[0].value
        ),
    });
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

(databaseUrl ? describe : describe.skip)('tasks.completedAt migration (#410)', () => {
  it('backfills only from task_completed evidence and never from updatedAt', async () => {
    expect(backfill).toBeDefined();
    await withTenantFixture(async ({ client, org, done, todo, task, activity, completedAt }) => {
      const now = Date.now();
      const editedToday = new Date(now - 60_000);
      // Done, edited today, completed (per its activity log) twelve days ago.
      const evidenced = await task({
        columnId: done,
        createdAt: new Date(now - 30 * DAY),
        updatedAt: editedToday,
      });
      await activity({ taskId: evidenced, at: new Date(now - 25 * DAY) });
      await activity({ taskId: evidenced, at: new Date(now - 12 * DAY) });
      await activity({ taskId: evidenced, at: new Date(now - 2 * DAY), type: 'task_updated' });
      // Done, edited today, no record of the completion: stays unknown.
      const unrecorded = await task({
        columnId: done,
        createdAt: new Date(now - 90 * DAY),
        updatedAt: editedToday,
      });
      // Completed once, reopened: not in Done any more.
      const reopened = await task({
        columnId: todo,
        createdAt: new Date(now - 30 * DAY),
        updatedAt: editedToday,
      });
      await activity({ taskId: reopened, at: new Date(now - 5 * DAY) });
      // Evidence that predates the task, or belongs to another tenant, is ignored.
      const implausible = await task({
        columnId: done,
        createdAt: new Date(now - 3 * DAY),
        updatedAt: editedToday,
      });
      await activity({ taskId: implausible, at: new Date(now - 4 * DAY) });
      await activity({
        taskId: implausible,
        at: new Date(now - DAY),
        org: `${org}`.replace('_org_', '_other_'),
      });

      // The state before the migration: no completion times at all.
      await client.query(`UPDATE tasks SET "completedAt" = NULL WHERE "organizationId" = $1`, [
        org,
      ]);
      await client.query(backfill!);

      expect((await completedAt(evidenced))?.getTime()).toBe(now - 12 * DAY);
      expect(await completedAt(unrecorded)).toBeNull();
      expect(await completedAt(reopened)).toBeNull();
      expect(await completedAt(implausible)).toBeNull();
    });
  });

  it('keeps completedAt consistent on every direct write to tasks', async () => {
    await withTenantFixture(async ({ client, done, todo, task, completedAt }) => {
      const now = Date.now();
      const sql = (text: string, values: unknown[]) => client.query(text, values);
      // now() is the transaction's start time, which the trigger uses too; the
      // column is timestamp(3), so compare at the same (rounded) precision.
      const before = await client.query<{ now: string }>(
        `SELECT timezone('UTC', now())::timestamp(3)::text AS now`
      );
      const writeTime = parse(before.rows[0].now)!;

      // Created in Done: stamped with the write time; anywhere else: none.
      const created = await task({
        columnId: done,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      });
      expect(await completedAt(created)).toEqual(writeTime);
      const open = await task({
        columnId: todo,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      });
      expect(await completedAt(open)).toBeNull();

      // A completion time can't be set on a task outside Done.
      await sql(`UPDATE tasks SET "completedAt" = $2::timestamp WHERE id = $1`, [
        open,
        utc(new Date(now)),
      ]);
      expect(await completedAt(open)).toBeNull();

      // Moving in stamps it, moving out clears it, an unrelated edit leaves it alone.
      await sql(`UPDATE tasks SET "columnId" = $2 WHERE id = $1`, [open, done]);
      expect(await completedAt(open)).toEqual(writeTime);
      await sql(`UPDATE tasks SET title = 'edited', "updatedAt" = $2::timestamp WHERE id = $1`, [
        open,
        utc(new Date(now + DAY)),
      ]);
      expect(await completedAt(open)).toEqual(writeTime);
      await sql(`UPDATE tasks SET "columnId" = $2 WHERE id = $1`, [open, todo]);
      expect(await completedAt(open)).toBeNull();

      // A writer may record an explicit completion time for a task in Done.
      const historical = new Date(now - 40 * DAY);
      await sql(`UPDATE tasks SET "completedAt" = $2::timestamp WHERE id = $1`, [
        created,
        utc(historical),
      ]);
      expect(await completedAt(created)).toEqual(historical);
    });
  });

  it('tracks column renames under tenant RLS and rolls them back with the rename', async () => {
    await withTenantFixture(async ({ client, org, done, todo, task, completedAt }) => {
      const now = Date.now();
      const open = await task({
        columnId: todo,
        createdAt: new Date(now - DAY),
        updatedAt: new Date(now - DAY),
      });
      const finished = await task({
        columnId: done,
        createdAt: new Date(now - 30 * DAY),
        updatedAt: new Date(now - 20 * DAY),
      });
      const historical = new Date(now - 20 * DAY);
      await client.query(`UPDATE tasks SET "completedAt" = $2::timestamp WHERE id = $1`, [
        finished,
        utc(historical),
      ]);
      await client.query(
        `SELECT set_config('app.is_platform_admin', 'false', true),
                set_config('app.current_organization_id', $1, true)`,
        [org]
      );
      const { rows } = await client.query<{ now: string }>(
        `SELECT timezone('UTC', now())::timestamp(3)::text AS now`
      );
      const writeTime = parse(rows[0].now);

      await client.query('SAVEPOINT before_rename');
      await client.query(`UPDATE columns SET name = 'Done' WHERE id = $1`, [todo]);
      expect(await completedAt(open)).toEqual(writeTime);
      expect(await completedAt(finished)).toEqual(historical);

      // Re-saving the same name and changing unrelated column metadata keep the time.
      await client.query(`UPDATE columns SET name = 'Done', "order" = 3 WHERE id = $1`, [done]);
      expect(await completedAt(finished)).toEqual(historical);
      await client.query(`UPDATE columns SET name = 'Archived' WHERE id = $1`, [done]);
      expect(await completedAt(finished)).toBeNull();
      expect(await completedAt(open)).toEqual(writeTime);
      await client.query(`UPDATE columns SET name = 'Done' WHERE id = $1`, [done]);
      expect(await completedAt(finished)).toEqual(writeTime);

      await client.query('ROLLBACK TO SAVEPOINT before_rename');
      expect(await completedAt(open)).toBeNull();
      expect(await completedAt(finished)).toEqual(historical);
      const names = await client.query<{ name: string }>(`SELECT name FROM columns WHERE id = $1`, [
        todo,
      ]);
      expect(names.rows).toEqual([{ name: 'To Do' }]);
    });
  });
});
