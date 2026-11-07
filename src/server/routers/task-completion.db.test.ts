/**
 * @vitest-environment node
 *
 * #410 — a task's completion time is when it ENTERED the Done column, kept in
 * `tasks.completedAt` by the database on every write path, and every completion
 * metric reads it instead of the mutable `updatedAt`.
 *
 * Runs against a REAL migrated PostgreSQL under forced row-level security and
 * drives each write path through its real code: the tRPC board (create, move,
 * bulk move, edit), the REST API (POST /tasks, PATCH /tasks/:id) and the
 * assistant's task tools; then /team/stats, the personal stats and the dashboard.
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the
 * restricted runtime role (neither SUPERUSER nor BYPASSRLS — asserted first).
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
vi.mock('@/lib/email', () => ({
  appUrl: vi.fn(() => 'https://app.test'),
  sendEmail: vi.fn(),
  templates: {},
}));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
// The REST handlers are exercised directly with a tenant transaction as context.
vi.mock('@/lib/api-auth', () => ({
  withApiAuth: (_scope: string, handler: unknown) => handler,
}));

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const ORG = `done410_${suffix}`;
const ADMIN = `done410_admin_${suffix}`;
const PROJECT = `done410_project_${suffix}`;
const TODO = `done410_todo_${suffix}`;
const DOING = `done410_doing_${suffix}`;
const DONE = `done410_done_${suffix}`;
/** A Done column on a second board of the same project. */
const DONE_ELSEWHERE = `done410_done2_${suffix}`;
let sequence = 0;
const newId = (kind: string) => `done410_${kind}_${suffix}_${++sequence}`;

const DAY = 86_400_000;
/** UTC wall-clock text for a `timestamp(3)` column (the server's TimeZone is not UTC). */
const utc = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '');

type Procedures = {
  projects: {
    createTask: (i: { title: string; columnId: string; assigneeIds?: string[] }) => Promise<{
      id: string;
    }>;
    moveTask: (i: { taskId: string; targetColumnId: string; newOrder: number }) => Promise<unknown>;
    bulkMoveTasks: (i: { taskIds: string[]; targetColumnId: string }) => Promise<unknown>;
    updateTask: (i: { id: string; title?: string }) => Promise<unknown>;
    updateColumn: (i: { id: string; name: string }) => Promise<unknown>;
  };
  teamStats: {
    getAll: () => Promise<{
      members: Array<{
        userId: string;
        completedThisWeek: number;
        completedLastWeek: number;
        avgCycleTimeDays: number | null;
        tasksDoneSparkline: number[];
      }>;
      velocity: Array<{ date: string; count: number }>;
    }>;
    getForUser: (i: { userId: string }) => Promise<{
      completedThisWeek: number;
      completedLastWeek: number;
      tasksDoneSparkline: number[];
    }>;
  };
  dashboard: { getStats: () => Promise<{ completedTasksThisWeek: number }> };
};

let client: pg.Client;
let api: () => Procedures;
let rest: {
  post: (body: unknown) => Promise<Response>;
  patch: (id: string, body: unknown) => Promise<Response>;
};
let assistant: {
  createTask: (i: { projectId: string; title: string; columnName: string }) => Promise<unknown>;
  moveTask: (i: { taskId: string; columnName: string }) => Promise<unknown>;
};

async function completedAt(taskId: string): Promise<Date | null> {
  const { rows } = await client.query<{ completedAt: string | null }>(
    `SELECT "completedAt"::text AS "completedAt" FROM tasks WHERE id = $1`,
    [taskId]
  );
  const value = rows[0]?.completedAt;
  return value ? new Date(`${value.replace(' ', 'T')}Z`) : null;
}

/** A task row written directly, as it would look before or outside the app. */
async function insertTask(opts: {
  columnId: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date | null;
}) {
  const id = newId('task');
  await client.query(
    `INSERT INTO tasks (id, "organizationId", title, "columnId", "order", "createdById",
       "createdAt", "updatedAt", "completedAt")
     VALUES ($1, $2, $1, $3, 0, $4, $5::timestamp, $6::timestamp, $7::timestamp)`,
    [
      id,
      ORG,
      opts.columnId,
      ADMIN,
      utc(opts.createdAt),
      utc(opts.updatedAt),
      opts.completedAt ? utc(opts.completedAt) : null,
    ]
  );
  if (opts.completedAt === null) {
    // Created in Done the trigger stamps "now"; a Done task with an UNKNOWN
    // completion time (what the conservative backfill leaves) is an explicit NULL.
    await client.query(`UPDATE tasks SET "completedAt" = NULL WHERE id = $1`, [id]);
  }
  await client.query(
    `INSERT INTO task_assignees (id, "organizationId", "taskId", "userId") VALUES ($1, $2, $3, $4)`,
    [newId('assignee'), ORG, id, ADMIN]
  );
  return id;
}

function expectRecent(at: Date | null) {
  expect(at).toBeInstanceOf(Date);
  expect(Math.abs(at!.getTime() - Date.now())).toBeLessThan(5 * 60_000);
}

describeIfDatabase('task completion time, against PostgreSQL (#410)', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);

    const at = utc(new Date());
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await client.query(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", "updatedAt")
       VALUES ($1, $1, $1, $1, $2::timestamp)`,
      [ORG, at]
    );
    await client.query(
      `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
       VALUES ($1, $2, 'OPS', 'Operations', $3::timestamp)`,
      [newId('dept'), ORG, at]
    );
    await client.query(
      `INSERT INTO users (id, "organizationId", name, email, role, department, title, status, "updatedAt")
       VALUES ($1, $2, 'Admin', $1 || '@test.invalid', 'ADMIN', 'OPS', 'Lead', 'ACTIVE', $3::timestamp)`,
      [ADMIN, ORG, at]
    );
    await client.query(
      `INSERT INTO projects (id, "organizationId", name, type, "updatedAt")
       VALUES ($1, $2, 'Delivery', 'INTERNAL', $3::timestamp)`,
      [PROJECT, ORG, at]
    );
    await client.query(
      `INSERT INTO project_members (id, "organizationId", "projectId", "userId") VALUES ($1, $2, $3, $4)`,
      [newId('member'), ORG, PROJECT, ADMIN]
    );
    const board = newId('board');
    const otherBoard = newId('board');
    await client.query(
      `INSERT INTO boards (id, "organizationId", name, "projectId", "updatedAt")
       VALUES ($1, $3, 'Main', $4, $5::timestamp), ($2, $3, 'Later', $4, $5::timestamp)`,
      [board, otherBoard, ORG, PROJECT, at]
    );
    await client.query(
      `INSERT INTO columns (id, "organizationId", name, "boardId", "order", "updatedAt") VALUES
         ($1, $5, 'To Do', $6, 0, $8::timestamp), ($2, $5, 'In Progress', $6, 1, $8::timestamp),
         ($3, $5, 'Done', $6, 2, $8::timestamp), ($4, $5, 'Done', $7, 0, $8::timestamp)`,
      [TODO, DOING, DONE, DONE_ELSEWHERE, ORG, board, otherBoard, at]
    );

    const { createTenantDb, withTenantDb } = await import('@/lib/tenancy/scoped-db');
    const { router } = await import('../trpc');
    const { projectsRouter } = await import('./projects');
    const { teamStatsRouter } = await import('./team-stats');
    const { dashboardRouter } = await import('./dashboard');
    const app = router({
      projects: projectsRouter,
      teamStats: teamStatsRouter,
      dashboard: dashboardRouter,
    });
    api = () =>
      app.createCaller({
        db: createTenantDb(ORG, ADMIN),
        entitlements: {
          organizationId: ORG,
          enabledModules: ['projects', 'hr', 'dashboard'],
          modules: [
            { key: 'projects', name: 'Projects', enabled: true },
            { key: 'hr', name: 'HR', enabled: true },
            { key: 'dashboard', name: 'Dashboard', enabled: true },
          ],
          activeSeats: 1,
          seatLimit: 5,
        },
        session: {
          expires: 'later',
          user: { id: ADMIN, role: 'ADMIN', status: 'ACTIVE', organizationId: ORG },
        },
        organization: { id: ORG, isDemo: false },
        support: null,
        requestMeta: { ip: null, userAgent: null },
        audit: { detail: {} },
      } as never) as unknown as Procedures;

    const tasksRoute = await import('@/app/api/v1/tasks/route');
    const taskRoute = await import('@/app/api/v1/tasks/[id]/route');
    type Handler = (auth: unknown, request: Request, ctx?: unknown) => Promise<Response>;
    const asApi = (run: (auth: unknown) => Promise<Response>) =>
      withTenantDb(
        ORG,
        async (db) => {
          const response = await run({ db, userId: ADMIN, userRole: 'ADMIN', organizationId: ORG });
          // Let the handler's fire-and-forget activity write land in this transaction.
          await new Promise((resolve) => setTimeout(resolve, 50));
          return response;
        },
        { userId: ADMIN }
      );
    rest = {
      post: (body) =>
        asApi((auth) =>
          (tasksRoute.POST as unknown as Handler)(
            auth,
            new Request('https://app.test/api/v1/tasks', {
              method: 'POST',
              body: JSON.stringify(body),
            })
          )
        ),
      patch: (id, body) =>
        asApi((auth) =>
          (taskRoute.PATCH as unknown as Handler)(
            auth,
            new Request(`https://app.test/api/v1/tasks/${id}`, {
              method: 'PATCH',
              body: JSON.stringify(body),
            }),
            { params: Promise.resolve({ id }) }
          )
        ),
    };

    const { createAssistantHelpers } = await import('@/lib/ai/context');
    const { buildTasksTools } = await import('@/lib/ai/tools/tasks');
    const tools = buildTasksTools(
      createAssistantHelpers(
        { organizationId: ORG, userId: ADMIN, role: 'ADMIN', name: 'Admin', status: 'ACTIVE' },
        createTenantDb(ORG, ADMIN)
      )
    ) as unknown as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
    assistant = {
      createTask: (input) => tools.createTask.execute(input),
      moveTask: (input) => tools.moveTask.execute(input),
    };
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    // Let fire-and-forget activity writes land before the tenant is removed.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await client.query(`DELETE FROM projects WHERE "organizationId" = $1`, [ORG]);
    await client.query(`DELETE FROM activities WHERE "organizationId" = $1`, [ORG]);
    await client.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await client.end();
  });

  it('stamps a task created in Done on every create path, and only there', async () => {
    const board = await api().projects.createTask({ title: 'Board, done', columnId: DONE });
    expectRecent(await completedAt(board.id));
    const open = await api().projects.createTask({ title: 'Board, open', columnId: TODO });
    expect(await completedAt(open.id)).toBeNull();

    const response = await rest.post({ title: 'REST, done', columnId: DONE });
    expect(response.status).toBe(201);
    const { data: viaRest } = (await response.json()) as { data: { id: string } };
    expectRecent(await completedAt(viaRest.id));

    await assistant.createTask({
      projectId: PROJECT,
      title: 'Assistant, done',
      columnName: 'Done',
    });
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM tasks WHERE title = 'Assistant, done' AND "organizationId" = $1`,
      [ORG]
    );
    expectRecent(await completedAt(rows[0].id));
  });

  it('stamps the move into Done and clears it on the way out, on every move path', async () => {
    // tRPC board: single move in, Done → Done keeps the time, move out clears it.
    const single = await api().projects.createTask({ title: 'Move me', columnId: TODO });
    await api().projects.moveTask({ taskId: single.id, targetColumnId: DONE, newOrder: 0 });
    const enteredDone = await completedAt(single.id);
    expectRecent(enteredDone);
    await api().projects.moveTask({
      taskId: single.id,
      targetColumnId: DONE_ELSEWHERE,
      newOrder: 0,
    });
    expect(await completedAt(single.id)).toEqual(enteredDone);
    await api().projects.moveTask({ taskId: single.id, targetColumnId: DOING, newOrder: 0 });
    expect(await completedAt(single.id)).toBeNull();

    // tRPC board: bulk move in and out.
    const a = await api().projects.createTask({ title: 'Bulk A', columnId: TODO });
    const b = await api().projects.createTask({ title: 'Bulk B', columnId: DOING });
    await api().projects.bulkMoveTasks({ taskIds: [a.id, b.id], targetColumnId: DONE });
    expectRecent(await completedAt(a.id));
    expectRecent(await completedAt(b.id));
    await api().projects.bulkMoveTasks({ taskIds: [a.id, b.id], targetColumnId: TODO });
    expect(await completedAt(a.id)).toBeNull();
    expect(await completedAt(b.id)).toBeNull();

    // REST: PATCH columnId in and out.
    const viaRest = await api().projects.createTask({ title: 'REST move', columnId: TODO });
    expect((await rest.patch(viaRest.id, { columnId: DONE })).status).toBe(200);
    expectRecent(await completedAt(viaRest.id));
    expect((await rest.patch(viaRest.id, { columnId: TODO })).status).toBe(200);
    expect(await completedAt(viaRest.id)).toBeNull();

    // Assistant: moveTask in and out.
    const viaAssistant = await api().projects.createTask({
      title: 'Assistant move',
      columnId: TODO,
    });
    await assistant.moveTask({ taskId: viaAssistant.id, columnName: 'Done' });
    expectRecent(await completedAt(viaAssistant.id));
    await assistant.moveTask({ taskId: viaAssistant.id, columnName: 'To Do' });
    expect(await completedAt(viaAssistant.id)).toBeNull();
  });

  it('never moves a completion on an ordinary edit', async () => {
    const finished = new Date(Date.now() - 20 * DAY);
    const task = await insertTask({
      columnId: DONE,
      createdAt: new Date(Date.now() - 40 * DAY),
      updatedAt: finished,
      completedAt: finished,
    });

    await api().projects.updateTask({ id: task, title: 'Renamed on the board' });
    expect((await rest.patch(task, { title: 'Renamed over REST' })).status).toBe(200);
    // The same task moved within Done keeps its completion too.
    await api().projects.moveTask({ taskId: task, targetColumnId: DONE, newOrder: 5 });

    expect((await completedAt(task))?.getTime()).toBe(finished.getTime());
  });

  it('includes tasks completed by a column rename and removes them when renamed away', async () => {
    await client.query(`DELETE FROM tasks WHERE "organizationId" = $1`, [ORG]);
    const task = await insertTask({
      columnId: TODO,
      createdAt: new Date(Date.now() - 2 * DAY),
      updatedAt: new Date(Date.now() - DAY),
    });
    await expect(api().dashboard.getStats()).resolves.toMatchObject({
      completedTasksThisWeek: 0,
    });

    await api().projects.updateColumn({ id: TODO, name: 'Done' });
    expectRecent(await completedAt(task));
    await expect(api().dashboard.getStats()).resolves.toMatchObject({
      completedTasksThisWeek: 1,
    });
    const all = await api().teamStats.getAll();
    expect(all.members.find((member) => member.userId === ADMIN)).toMatchObject({
      completedThisWeek: 1,
      avgCycleTimeDays: 2,
    });
    expect(all.velocity.reduce((sum, day) => sum + day.count, 0)).toBe(1);

    await api().projects.updateColumn({ id: TODO, name: 'To Do' });
    expect(await completedAt(task)).toBeNull();
    await expect(api().dashboard.getStats()).resolves.toMatchObject({
      completedTasksThisWeek: 0,
    });
    await expect(api().teamStats.getForUser({ userId: ADMIN })).resolves.toMatchObject({
      completedThisWeek: 0,
    });
  });

  it('counts completions by when tasks entered Done, never by their last edit', async () => {
    // Fresh tenant state for the metrics: drop the earlier tests' tasks.
    await client.query(`DELETE FROM tasks WHERE "organizationId" = $1`, [ORG]);
    const now = Date.now();
    // An old completion edited today: the issue's false positive.
    await insertTask({
      columnId: DONE,
      createdAt: new Date(now - 40 * DAY),
      updatedAt: new Date(now - 60_000),
      completedAt: new Date(now - 20 * DAY),
    });
    // Completed ten days ago: last week.
    await insertTask({
      columnId: DONE,
      createdAt: new Date(now - 12 * DAY),
      updatedAt: new Date(now - 10 * DAY),
      completedAt: new Date(now - 10 * DAY),
    });
    // In Done with no known completion time (a conservative backfill leaves NULL).
    await insertTask({
      columnId: DONE,
      createdAt: new Date(now - 90 * DAY),
      updatedAt: new Date(now - 60_000),
      completedAt: null,
    });
    // Completed just now through the board.
    const fresh = await insertTask({
      columnId: TODO,
      createdAt: new Date(now - 2 * DAY),
      updatedAt: new Date(now - 2 * DAY),
    });
    await api().projects.moveTask({ taskId: fresh, targetColumnId: DONE, newOrder: 0 });

    const all = await api().teamStats.getAll();
    const me = all.members.find((member) => member.userId === ADMIN)!;
    expect(me).toMatchObject({ completedThisWeek: 1, completedLastWeek: 1 });
    expect(me.tasksDoneSparkline.reduce((sum, n) => sum + n, 0)).toBe(1);
    expect(me.tasksDoneSparkline[6]).toBe(1);
    // Cycle time uses known completions only: (2 + 2 + 20) / 3 days → 8.0.
    expect(me.avgCycleTimeDays).toBeCloseTo(8, 0);

    const byDate = new Map(all.velocity.map((v) => [v.date, v.count]));
    const day = (offset: number) => new Date(now - offset * DAY).toISOString().slice(0, 10);
    expect(byDate.get(day(0))).toBe(1);
    expect(byDate.get(day(10))).toBe(1);
    expect(byDate.get(day(20))).toBe(1);
    expect(all.velocity.reduce((sum, v) => sum + v.count, 0)).toBe(3);

    await expect(api().teamStats.getForUser({ userId: ADMIN })).resolves.toMatchObject({
      completedThisWeek: 1,
      completedLastWeek: 1,
    });
    await expect(api().dashboard.getStats()).resolves.toMatchObject({
      completedTasksThisWeek: 1,
    });
  });
});
