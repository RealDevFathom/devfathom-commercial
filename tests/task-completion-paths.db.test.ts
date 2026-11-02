/**
 * @vitest-environment node
 *
 * DEV-250 / #450: every write path that creates a task, moves it, or renames its
 * column keeps `Task.completedAt` true to "when did this task enter done", against
 * a REAL migrated PostgreSQL — the in-app tRPC board (create, move, bulk move,
 * edit, column rename, Trello import), the REST API (POST / PATCH) and the AI
 * assistant tools (create, move, edit, column rename).
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

const rest = vi.hoisted(() => ({ ctx: null as unknown }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
  recordRestAudit: vi.fn(),
  recordAudit: vi.fn(),
}));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(() => ''), sendEmail: vi.fn(), templates: {} }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/lib/webhooks', () => ({ emitEvent: vi.fn() }));
// REST handlers run with a real tenant client; only token authentication is stubbed.
vi.mock('@/lib/api-auth', () => ({
  withApiAuth:
    (_scope: string, handler: (...args: unknown[]) => unknown) =>
    (request: Request, context?: unknown) =>
      handler(rest.ctx, request, context),
}));

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const ORG = `dev250_paths_${suffix}`;
const id = (name: string) => `dev250_${name}_${suffix}`;
const ADMIN = id('admin');
const PROJECT = id('project');
// Unique per run through the organization; no shared tokens with the Trello
// project so the assistant's fuzzy project match stays unambiguous.
const PROJECT_NAME = 'Completion paths';
const BOARD = id('board');
const TODO = id('col_todo');
const PROGRESS = id('col_progress');
const DONE = id('col_done');
const SHIPPED = id('col_shipped');
const QA = id('col_qa');
const LONG_AGO = new Date('2026-09-01T10:00:00.000Z');

let client: pg.Client;
let seq = 0;

type Caller = {
  projects: {
    createTask: (input: { title: string; columnId: string }) => Promise<{ id: string }>;
    updateTask: (input: { id: string; title?: string; priority?: 'HIGH' }) => Promise<unknown>;
    moveTask: (input: {
      taskId: string;
      targetColumnId: string;
      newOrder: number;
    }) => Promise<unknown>;
    bulkMoveTasks: (input: { taskIds: string[]; targetColumnId: string }) => Promise<unknown>;
    updateColumn: (input: { id: string; name: string }) => Promise<unknown>;
  };
  trelloImport: {
    importBoard: (input: Record<string, unknown>) => Promise<{ boardId: string }>;
  };
};
let trpc: Caller;
type Tool = { execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>> };
let ai: Record<string, Tool>;
let restTasks: typeof import('@/app/api/v1/tasks/route');
let restTask: typeof import('@/app/api/v1/tasks/[id]/route');

/** Insert a task straight into a column, optionally already completed at `completedAt`. */
async function seedTask(columnId: string, completedAt: Date | null = null): Promise<string> {
  const taskId = id(`task_${++seq}`);
  await client.query(
    `INSERT INTO tasks (id, "organizationId", title, "columnId", "order", "createdById", "completedAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [taskId, ORG, `Seeded task ${seq}`, columnId, 100 + seq, ADMIN, completedAt, LONG_AGO]
  );
  return taskId;
}

async function stateOf(taskId: string) {
  const { rows } = await client.query<{
    completedAt: Date | null;
    updatedAt: Date;
    columnId: string;
  }>(`SELECT "completedAt", "updatedAt", "columnId" FROM tasks WHERE id = $1`, [taskId]);
  return rows[0]!;
}

/** Run `act` and assert it stamped `completedAt` with the time it ran. */
async function expectStampedNow(taskId: () => string, act: () => Promise<unknown>) {
  const before = Date.now();
  await act();
  const after = Date.now();
  const { completedAt } = await stateOf(taskId());
  expect(completedAt).toBeInstanceOf(Date);
  expect(completedAt!.getTime()).toBeGreaterThanOrEqual(before - 5);
  expect(completedAt!.getTime()).toBeLessThanOrEqual(after + 5);
}

/** The `task_completed` activity is fire-and-forget outside a tenant request: poll for it. */
async function expectCompletionLogged(taskId: string) {
  await vi.waitFor(
    async () => {
      const { rows } = await client.query(
        `SELECT 1 FROM activities WHERE "entityId" = $1 AND type = 'task_completed'`,
        [taskId]
      );
      expect(rows).toHaveLength(1);
    },
    { timeout: 5_000, interval: 50 }
  );
}

function jsonRequest(method: string, path: string, body: unknown) {
  return new Request(`https://example.test/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describeIfDatabase('task completedAt across every write path, against PostgreSQL', () => {
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
       VALUES ($1, $2, 'Admin', $1 || '@test.invalid', 'ADMIN', 'OPS', 'Lead', now())`,
      [ADMIN, ORG]
    );
    await client.query(
      `INSERT INTO projects (id, "organizationId", name, type, "updatedAt")
       VALUES ($1, $2, $3, 'INTERNAL', now())`,
      [PROJECT, ORG, PROJECT_NAME]
    );
    await client.query(
      `INSERT INTO project_members (id, "organizationId", "projectId", "userId", role)
       VALUES ($1, $2, $3, $4, 'LEAD')`,
      [id('pm'), ORG, PROJECT, ADMIN]
    );
    await client.query(
      `INSERT INTO boards (id, "organizationId", name, "projectId", "updatedAt")
       VALUES ($1, $2, 'Board', $3, now())`,
      [BOARD, ORG, PROJECT]
    );
    await client.query(
      `INSERT INTO columns (id, "organizationId", name, "boardId", "order", "updatedAt")
       VALUES ($1, $7, 'To Do', $8, 0, now()), ($2, $7, 'In Progress', $8, 1, now()),
              ($3, $7, 'Done', $8, 2, now()), ($4, $7, 'Shipped', $8, 3, now()),
              ($5, $7, 'QA', $8, 4, now()), ($6, $7, 'Review', $8, 5, now())`,
      [TODO, PROGRESS, DONE, SHIPPED, QA, id('col_review'), ORG, BOARD]
    );

    const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
    const { router } = await import('@/server/trpc');
    const { projectsRouter } = await import('@/server/routers/projects');
    const { trelloImportRouter } = await import('@/server/routers/trello-import');
    const app = router({ projects: projectsRouter, trelloImport: trelloImportRouter });
    trpc = app.createCaller({
      db: createTenantDb(ORG, ADMIN),
      entitlements: {
        organizationId: ORG,
        enabledModules: ['projects'],
        modules: [{ key: 'projects', name: 'Projects', enabled: true }],
        activeSeats: 1,
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

    rest.ctx = {
      db: createTenantDb(ORG, ADMIN),
      userId: ADMIN,
      userRole: 'ADMIN',
      organizationId: ORG,
      tokenId: id('token'),
    };
    restTasks = await import('@/app/api/v1/tasks/route');
    restTask = await import('@/app/api/v1/tasks/[id]/route');

    const { createAssistantHelpers } = await import('@/lib/ai/context');
    const { buildTasksTools } = await import('@/lib/ai/tools/tasks');
    const { buildProjectsTools } = await import('@/lib/ai/tools/projects');
    const helpers = createAssistantHelpers(
      {
        organizationId: ORG,
        userId: ADMIN,
        role: 'ADMIN',
        name: 'Admin',
        enabledModules: ['projects'],
      },
      createTenantDb(ORG, ADMIN)
    );
    ai = { ...buildTasksTools(helpers), ...buildProjectsTools(helpers) } as unknown as Record<
      string,
      Tool
    >;
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

  describe('tRPC board', () => {
    it('createTask stamps a task created straight into Done and leaves others open', async () => {
      let doneId = '';
      await expectStampedNow(
        () => doneId,
        async () => {
          doneId = (await trpc.projects.createTask({ title: 'Born done', columnId: DONE })).id;
        }
      );
      const open = await trpc.projects.createTask({ title: 'Born open', columnId: TODO });
      expect((await stateOf(open.id)).completedAt).toBeNull();
    });

    it('moveTask into Done stamps completedAt and logs one completion', async () => {
      const taskId = await seedTask(PROGRESS);
      await expectStampedNow(
        () => taskId,
        () => trpc.projects.moveTask({ taskId, targetColumnId: DONE, newOrder: 0 })
      );
      await expectCompletionLogged(taskId);
    });

    it('editing a Done task never touches completedAt (the reported bug)', async () => {
      const taskId = await seedTask(DONE, LONG_AGO);
      await trpc.projects.updateTask({ id: taskId, title: 'Typo fixed', priority: 'HIGH' });
      const after = await stateOf(taskId);
      expect(after.updatedAt.getTime()).toBeGreaterThan(LONG_AGO.getTime());
      expect(after.completedAt).toEqual(LONG_AGO);
    });

    it('keeps the original completion on a reorder inside Done and a move Done → Shipped', async () => {
      const taskId = await seedTask(DONE, LONG_AGO);
      await trpc.projects.moveTask({ taskId, targetColumnId: DONE, newOrder: 0 });
      expect((await stateOf(taskId)).completedAt).toEqual(LONG_AGO);
      await trpc.projects.moveTask({ taskId, targetColumnId: SHIPPED, newOrder: 0 });
      expect(await stateOf(taskId)).toMatchObject({ columnId: SHIPPED, completedAt: LONG_AGO });
    });

    it('moveTask out of Done clears completedAt; re-entering stamps a new completion', async () => {
      const taskId = await seedTask(DONE, LONG_AGO);
      await trpc.projects.moveTask({ taskId, targetColumnId: PROGRESS, newOrder: 0 });
      expect((await stateOf(taskId)).completedAt).toBeNull();
      await expectStampedNow(
        () => taskId,
        () => trpc.projects.moveTask({ taskId, targetColumnId: DONE, newOrder: 0 })
      );
    });

    it('bulkMoveTasks applies the transition per task', async () => {
      const open = await seedTask(TODO);
      const done = await seedTask(DONE, LONG_AGO);
      const before = Date.now();
      await trpc.projects.bulkMoveTasks({ taskIds: [open, done], targetColumnId: SHIPPED });
      const opened = await stateOf(open);
      expect(opened.completedAt!.getTime()).toBeGreaterThanOrEqual(before - 5);
      expect((await stateOf(done)).completedAt).toEqual(LONG_AGO);

      await trpc.projects.bulkMoveTasks({ taskIds: [open, done], targetColumnId: TODO });
      expect((await stateOf(open)).completedAt).toBeNull();
      expect((await stateOf(done)).completedAt).toBeNull();
    });

    it('updateColumn renaming into a done name completes its tasks; renaming away reopens them', async () => {
      const taskId = await seedTask(QA);
      await expectStampedNow(
        () => taskId,
        () => trpc.projects.updateColumn({ id: QA, name: 'Closed' })
      );
      const stamped = (await stateOf(taskId)).completedAt;
      // A rename that keeps the column done (Closed → Complete) keeps the time.
      await trpc.projects.updateColumn({ id: QA, name: 'Complete' });
      expect((await stateOf(taskId)).completedAt).toEqual(stamped);
      await trpc.projects.updateColumn({ id: QA, name: 'QA' });
      expect((await stateOf(taskId)).completedAt).toBeNull();
    });

    it('Trello import completes cards routed to the done column and nothing else', async () => {
      const before = Date.now();
      const result = await trpc.trelloImport.importBoard({
        newProjectName: 'Trello import',
        memberMapping: {},
        trelloJson: {
          id: `trello_${suffix}`,
          name: `Imported board ${suffix}`,
          lists: [
            { id: 'l_todo', name: 'Doing', pos: 1 },
            { id: 'l_done', name: 'Done', pos: 2 },
          ],
          cards: [
            { id: 'c_open', name: 'Still open', idList: 'l_todo', pos: 1 },
            { id: 'c_due', name: 'Due complete', idList: 'l_todo', pos: 2, dueComplete: true },
            { id: 'c_done', name: 'Already done', idList: 'l_done', pos: 3 },
          ],
        },
      });
      const { rows } = await client.query<{ title: string; completedAt: Date | null }>(
        `SELECT t.title, t."completedAt" FROM tasks t JOIN columns c ON c.id = t."columnId"
          WHERE c."boardId" = $1 ORDER BY t.title`,
        [result.boardId]
      );
      const byTitle = Object.fromEntries(rows.map((row) => [row.title, row.completedAt]));
      expect(byTitle['Still open']).toBeNull();
      expect(byTitle['Due complete']!.getTime()).toBeGreaterThanOrEqual(before - 5);
      expect(byTitle['Already done']!.getTime()).toBeGreaterThanOrEqual(before - 5);
    });
  });

  describe('REST API', () => {
    it('POST /tasks into Done stamps completedAt; into To Do leaves it null', async () => {
      const before = Date.now();
      const done = await restTasks.POST(
        jsonRequest('POST', '/tasks', { title: 'REST born done', columnId: DONE })
      );
      expect(done.status).toBe(201);
      const doneBody = (await done.json()) as { data: { id: string } };
      expect((await stateOf(doneBody.data.id)).completedAt!.getTime()).toBeGreaterThanOrEqual(
        before - 5
      );

      const open = await restTasks.POST(
        jsonRequest('POST', '/tasks', { title: 'REST born open', columnId: TODO })
      );
      const openBody = (await open.json()) as { data: { id: string } };
      expect((await stateOf(openBody.data.id)).completedAt).toBeNull();
    });

    it('PATCH /tasks/:id moves into and out of Done, and a plain edit keeps completedAt', async () => {
      const taskId = await seedTask(PROGRESS);
      const params = { params: Promise.resolve({ id: taskId }) };
      await expectStampedNow(
        () => taskId,
        async () => {
          const res = await restTask.PATCH(
            jsonRequest('PATCH', `/tasks/${taskId}`, { columnId: DONE }),
            params
          );
          expect(res.status).toBe(200);
        }
      );
      const stamped = (await stateOf(taskId)).completedAt;
      await expectCompletionLogged(taskId);

      await restTask.PATCH(
        jsonRequest('PATCH', `/tasks/${taskId}`, { title: 'Edited over REST' }),
        { params: Promise.resolve({ id: taskId }) }
      );
      expect((await stateOf(taskId)).completedAt).toEqual(stamped);

      await restTask.PATCH(jsonRequest('PATCH', `/tasks/${taskId}`, { columnId: SHIPPED }), {
        params: Promise.resolve({ id: taskId }),
      });
      expect((await stateOf(taskId)).completedAt).toEqual(stamped);

      await restTask.PATCH(jsonRequest('PATCH', `/tasks/${taskId}`, { columnId: TODO }), {
        params: Promise.resolve({ id: taskId }),
      });
      expect((await stateOf(taskId)).completedAt).toBeNull();
    });

    it('ignores a client-supplied completedAt', async () => {
      const taskId = await seedTask(TODO);
      await restTask.PATCH(
        jsonRequest('PATCH', `/tasks/${taskId}`, { completedAt: LONG_AGO.toISOString() }),
        { params: Promise.resolve({ id: taskId }) }
      );
      expect((await stateOf(taskId)).completedAt).toBeNull();
    });
  });

  describe('AI assistant tools', () => {
    it('createTask into the Done column stamps completedAt', async () => {
      const before = Date.now();
      const created = await ai.createTask.execute({
        projectId: PROJECT,
        title: 'Assistant born done',
        columnName: 'Done',
      });
      expect((await stateOf(created.id as string)).completedAt!.getTime()).toBeGreaterThanOrEqual(
        before - 5
      );
      const open = await ai.createTask.execute({ projectId: PROJECT, title: 'Assistant open' });
      expect((await stateOf(open.id as string)).completedAt).toBeNull();
    });

    it('moveTask into Done stamps it, updateTask keeps it, moving out clears it', async () => {
      const taskId = await seedTask(PROGRESS);
      let result: Record<string, unknown> = {};
      await expectStampedNow(
        () => taskId,
        async () => {
          result = await ai.moveTask.execute({ taskId, columnName: 'Done' });
        }
      );
      expect(result).toMatchObject({ success: true, completed: true });
      const stamped = (await stateOf(taskId)).completedAt;

      await ai.updateTask.execute({ taskId, title: 'Assistant edit', priority: 'HIGH' });
      expect((await stateOf(taskId)).completedAt).toEqual(stamped);

      await expect(ai.moveTask.execute({ taskId, columnName: 'Shipped' })).resolves.toMatchObject({
        completed: false,
      });
      expect((await stateOf(taskId)).completedAt).toEqual(stamped);

      await ai.moveTask.execute({ taskId, columnName: 'To Do' });
      expect((await stateOf(taskId)).completedAt).toBeNull();
    });

    it('updateColumn renaming into a done name completes the column’s tasks', async () => {
      const taskId = await seedTask(id('col_review'));
      await expectStampedNow(
        () => taskId,
        async () => {
          await expect(
            ai.updateColumn.execute({
              project: PROJECT_NAME,
              column: 'Review',
              newName: 'Completed',
            })
          ).resolves.toMatchObject({ renamed: 'Review', to: 'Completed' });
        }
      );
      await expect(
        ai.updateColumn.execute({ project: PROJECT_NAME, column: 'Completed', newName: 'Review' })
      ).resolves.toMatchObject({ to: 'Review' });
      expect((await stateOf(taskId)).completedAt).toBeNull();
    });
  });
});
