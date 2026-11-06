/**
 * @vitest-environment node
 *
 * DEV-250 / #450: /team/stats counts a completion by when the task ENTERED done
 * (`Task.completedAt`), not by its last edit. Editing an old Done task bumps its
 * `updatedAt`, which used to make it a "new" completion this week, today's
 * velocity and a stretched cycle time. Exercised through the real routers against
 * a REAL migrated PostgreSQL.
 *
 * Requires TEST_DATABASE_URL (a disposable, migrated database). Without it the
 * suite reports itself skipped rather than passing vacuously.
 */
import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
// `@/lib/db` reads DATABASE_URL on first use; everything that reaches it is
// imported inside the suite, after this line.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(() => ''), sendEmail: vi.fn(), templates: {} }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/lib/webhooks', () => ({ emitEvent: vi.fn() }));

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const DAY = 24 * 60 * 60 * 1000;
const suffix = randomBytes(6).toString('hex');
const ORG = `dev250_stats_${suffix}`;
const id = (name: string) => `dev250s_${name}_${suffix}`;
const ADMIN = id('admin');
const MEMBER = id('member');
const TODO = id('col_todo');
const DONE = id('col_done');
const SHIPPED = id('col_shipped');
const OLD_DONE = id('task_old_done');
const FRESH = id('task_fresh');

type MemberStats = {
  userId: string;
  openTasks: number;
  completedThisWeek: number;
  completedLastWeek: number;
  overdueTasks: number;
  avgCycleTimeDays: number | null;
  tasksDoneSparkline: number[];
};
type Caller = {
  teamStats: {
    getAll: () => Promise<{
      members: MemberStats[];
      velocity: { date: string; count: number }[];
      totals: { teamCompletedThisWeek: number; teamCompletedLastWeek: number };
    }>;
    getForUser: (input: { userId: string }) => Promise<MemberStats>;
  };
  projects: {
    updateTask: (input: { id: string; title: string }) => Promise<unknown>;
    moveTask: (input: {
      taskId: string;
      targetColumnId: string;
      newOrder: number;
    }) => Promise<unknown>;
  };
};

let client: pg.Client;
let caller: Caller;
const ago = (days: number) => new Date(Date.now() - days * DAY);

describeIfDatabase('team stats completions, against PostgreSQL', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await client.query(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", "updatedAt")
       VALUES ($1, $1, $1, $1, now())`,
      [ORG]
    );
    await client.query(
      `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
       VALUES ($1, $2, 'OPS', 'Operations', now())`,
      [id('dept'), ORG]
    );
    await client.query(
      `INSERT INTO users (id, "organizationId", name, email, role, department, title, "updatedAt")
       VALUES ($1, $3, 'Admin', $1 || '@test.invalid', 'ADMIN', 'OPS', 'Lead', now()),
              ($2, $3, 'Member', $2 || '@test.invalid', 'EMPLOYEE', 'OPS', 'Engineer', now())`,
      [ADMIN, MEMBER, ORG]
    );
    await client.query(
      `INSERT INTO projects (id, "organizationId", name, type, "updatedAt")
       VALUES ($1, $2, 'Stats project', 'INTERNAL', now())`,
      [id('project'), ORG]
    );
    await client.query(
      `INSERT INTO project_members (id, "organizationId", "projectId", "userId", role)
       VALUES ($1, $3, $4, $5, 'LEAD'), ($2, $3, $4, $6, 'MEMBER')`,
      [id('pm1'), id('pm2'), ORG, id('project'), ADMIN, MEMBER]
    );
    await client.query(
      `INSERT INTO boards (id, "organizationId", name, "projectId", "updatedAt")
       VALUES ($1, $2, 'Board', $3, now())`,
      [id('board'), ORG, id('project')]
    );
    await client.query(
      `INSERT INTO columns (id, "organizationId", name, "boardId", "order", "updatedAt")
       VALUES ($1, $4, 'To Do', $5, 0, now()), ($2, $4, 'Done', $5, 1, now()),
              ($3, $4, 'Shipped', $5, 2, now())`,
      [TODO, DONE, SHIPPED, ORG, id('board')]
    );
    // [id, column, createdAt, completedAt, dueDate] — every task assigned to MEMBER.
    const tasks: Array<[string, string, Date, Date | null, Date | null]> = [
      // Completed 40 days ago; it is edited today in the test below.
      [OLD_DONE, DONE, ago(45), ago(40), null],
      // Created 3 days ago, still open; moved into Done in the test below.
      [FRESH, TODO, ago(3), null, null],
      // Completed in the previous week.
      [id('task_last_week'), DONE, ago(12), ago(10), null],
      // Completed in the previous week in a done column not literally named "Done".
      [id('task_shipped'), SHIPPED, ago(11), ago(9), null],
      // Done long ago with a past due date: neither open nor overdue.
      [id('task_done_due'), DONE, ago(25), ago(20), ago(22)],
      // Open and overdue.
      [id('task_open'), TODO, ago(5), null, ago(1)],
    ];
    for (const [taskId, columnId, createdAt, completedAt, dueDate] of tasks) {
      // updatedAt = completedAt (or createdAt): the state right after the last move.
      await client.query(
        `INSERT INTO tasks (id, "organizationId", title, "columnId", "order", "createdById", "createdAt", "updatedAt", "completedAt", "dueDate")
         VALUES ($1, $2, $1, $3, 0, $4, $5, $6, $7, $8)`,
        [taskId, ORG, columnId, ADMIN, createdAt, completedAt ?? createdAt, completedAt, dueDate]
      );
      await client.query(
        `INSERT INTO task_assignees (id, "organizationId", "taskId", "userId") VALUES ($1, $2, $3, $4)`,
        [`${taskId}_assignee`, ORG, taskId, MEMBER]
      );
    }

    const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
    const { router } = await import('../trpc');
    const { teamStatsRouter } = await import('./team-stats');
    const { projectsRouter } = await import('./projects');
    const app = router({ teamStats: teamStatsRouter, projects: projectsRouter });
    caller = app.createCaller({
      db: createTenantDb(ORG, ADMIN),
      entitlements: {
        organizationId: ORG,
        enabledModules: ['hr', 'projects'],
        modules: [
          { key: 'hr', name: 'HR', enabled: true },
          { key: 'projects', name: 'Projects', enabled: true },
        ],
        activeSeats: 2,
        seatLimit: 50,
      },
      session: {
        expires: 'later',
        user: { id: ADMIN, name: 'Admin', role: 'ADMIN', status: 'ACTIVE', organizationId: ORG },
      },
      organization: { id: ORG, isDemo: false },
      support: null,
      requestMeta: { ip: null, userAgent: null },
      audit: { detail: {} },
    } as never) as unknown as Caller;

    // The reported bug: an ordinary edit of an old Done task...
    await caller.projects.updateTask({ id: OLD_DONE, title: 'Old done task, typo fixed' });
    // ...next to a genuine completion today.
    await caller.projects.moveTask({ taskId: FRESH, targetColumnId: DONE, newOrder: 0 });
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await client.query(`DELETE FROM activities WHERE "organizationId" = $1`, [ORG]);
    // Projects first: their tasks name a creator, which the users cascade cannot drop.
    await client.query(`DELETE FROM projects WHERE "organizationId" = $1`, [ORG]);
    await client.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await client.end();
  });

  it('the edit bumped updatedAt but left the old completion alone', async () => {
    const { rows } = await client.query<{ updatedAt: Date; completedAt: Date }>(
      `SELECT "updatedAt", "completedAt" FROM tasks WHERE id = $1`,
      [OLD_DONE]
    );
    expect(rows[0]!.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(rows[0]!.completedAt.getTime()).toBeLessThan(ago(39).getTime());
  });

  const expectMemberStats = (stats: MemberStats) => {
    // Only FRESH (moved today); the edited OLD_DONE is not a completion.
    expect(stats.completedThisWeek).toBe(1);
    // Both last-week completions, including the one in "Shipped".
    expect(stats.completedLastWeek).toBe(2);
    expect(stats.openTasks).toBe(1);
    expect(stats.overdueTasks).toBe(1);
    // Today: FRESH only.
    expect(stats.tasksDoneSparkline).toEqual([0, 0, 0, 0, 0, 0, 1]);
    // createdAt → completedAt: OLD_DONE 5d, FRESH 3d, last week 2d, Shipped 2d,
    // done-with-due 5d. Measured to its edit, OLD_DONE alone would be ~45d.
    expect(stats.avgCycleTimeDays).toBe(3.4);
  };

  it('getForUser counts completions by completedAt', async () => {
    expectMemberStats(await caller.teamStats.getForUser({ userId: MEMBER }));
  });

  it('getAll counts completions, velocity and cycle time by completedAt', async () => {
    const all = await caller.teamStats.getAll();
    expectMemberStats(all.members.find((m) => m.userId === MEMBER)!);
    expect(all.totals.teamCompletedThisWeek).toBe(1);
    expect(all.totals.teamCompletedLastWeek).toBe(2);

    const today = new Date().toISOString().slice(0, 10);
    const count = (date: string) => all.velocity.find((v) => v.date === date)?.count;
    // Only FRESH completed today — not the old task that was merely edited today.
    expect(count(today)).toBe(1);
    expect(count(ago(9).toISOString().slice(0, 10))).toBe(1);
    expect(count(ago(10).toISOString().slice(0, 10))).toBe(1);
    expect(count(ago(20).toISOString().slice(0, 10))).toBe(1);
    // OLD_DONE (40 days ago) falls outside the 30-day window entirely.
    expect(all.velocity.reduce((sum, v) => sum + v.count, 0)).toBe(4);
  });
});
