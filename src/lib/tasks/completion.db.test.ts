// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { AssistantHelpers } from '@/lib/ai/context';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;
const prefix = `completion_${randomUUID().replaceAll('-', '')}`;
const orgId = `${prefix}_org`;
const userId = `${prefix}_user`;
const projectId = `${prefix}_project`;
const boardId = `${prefix}_board`;
const closedId = `${prefix}_closed`;
const todoId = `${prefix}_todo`;
const doneId = `${prefix}_done`;
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let buildTasksTools: typeof import('@/lib/ai/tools/tasks').buildTasksTools;
let updateColumn: typeof import('./columns').updateColumnWithCompletion;
let patch: typeof import('@/app/api/v1/tasks/[id]/route').PATCH;
let restDb: ScopedDb;

vi.mock('server-only', () => ({}));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(), templates: {} }));
vi.mock('@/server/activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/lib/authz', () => ({
  projectIdOfTask: async () => projectId,
  canAccessProject: async () => true,
}));
vi.mock('@/lib/api-auth', () => ({
  withApiAuth:
    (_scope: string, handler: (...args: unknown[]) => unknown) =>
    (request: Request, context: unknown) =>
      handler({ db: restDb, userId, userRole: 'ADMIN' }, request, context),
}));

function helpers(db: ScopedDb): AssistantHelpers {
  return {
    db,
    taskVisibility: () => ({}),
    canAccessProject: async () => true,
    now: () => new Date(),
    DONE_COLUMNS: ['Done', 'Closed'],
    activity: vi.fn(),
    audit: vi.fn(),
  } as unknown as AssistantHelpers;
}

async function createTask(columnId = closedId) {
  return withTenantDb(orgId, (db) =>
    db.task.create({
      data: {
        title: 'Completion regression',
        columnId,
        order: 0,
        createdById: userId,
        completedAt: columnId === closedId ? new Date() : null,
      },
    })
  );
}

async function readTask(id: string) {
  return withTenantDb(orgId, (db) => db.task.findUniqueOrThrow({ where: { id } }));
}

beforeAll(async () => {
  if (!url) return;
  ({ withTenantDb, withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
  ({ buildTasksTools } = await import('@/lib/ai/tools/tasks'));
  ({ updateColumnWithCompletion: updateColumn } = await import('./columns'));
  ({ PATCH: patch } = await import('@/app/api/v1/tasks/[id]/route'));
  await withPlatformDb(async (db) => {
    await db.organization.create({
      data: { id: orgId, slug: orgId, legalName: orgId, displayName: orgId },
    });
  });
  await withTenantDb(orgId, async (db) => {
    await db.organizationDepartment.create({ data: { key: 'OPS', name: 'Operations' } });
    await db.user.create({
      data: {
        id: userId,
        email: `${userId}@test.invalid`,
        name: 'Tester',
        department: 'OPS',
        title: 'Staff',
      },
    });
    await db.project.create({ data: { id: projectId, name: 'Regression', type: 'INTERNAL' } });
    await db.board.create({ data: { id: boardId, name: 'Board', projectId } });
    for (const [order, [id, name]] of [
      [closedId, 'Closed'],
      [todoId, 'To Do'],
      [doneId, 'Done'],
    ].entries()) {
      await db.column.create({ data: { id, name, order, boardId } });
    }
  });
});

afterAll(async () => {
  if (!withPlatformDb) return;
  await withPlatformDb(async (db) => {
    await db.project.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
  });
});

suite('task completion persistence on PostgreSQL', () => {
  it.each(['REST', 'AI'] as const)('rejects a stale %s move after reopening', async (surface) => {
    const task = await createTask();
    let loaded!: () => void;
    let release!: () => void;
    const read = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = withTenantDb(orgId, async (db) => {
      let paused = false;
      const pausedDb = new Proxy(db, {
        get(target, key) {
          if (key !== 'task') return Reflect.get(target, key);
          return new Proxy(target.task, {
            get(delegate, operation) {
              const method = Reflect.get(delegate, operation);
              if (operation !== (surface === 'REST' ? 'findUnique' : 'findMany')) return method;
              return async (...args: unknown[]) => {
                const result = await Reflect.apply(method, delegate, args);
                if (!paused) {
                  paused = true;
                  loaded();
                  await gate;
                }
                return result;
              };
            },
          });
        },
      });
      if (surface === 'REST') {
        restDb = pausedDb;
        return patch(
          new Request('https://example.test/api/v1/tasks/' + task.id, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ columnId: doneId }),
          }),
          { params: Promise.resolve({ id: task.id }) }
        );
      }
      const tools = buildTasksTools(helpers(pausedDb));
      return (
        tools.moveTask as unknown as {
          execute: (input: { taskId: string; columnName: string }) => Promise<unknown>;
        }
      ).execute({ taskId: task.id, columnName: 'Done' });
    });
    await read;
    try {
      // A competing committed transaction reopens the task while the first
      // request still holds its original Closed snapshot.
      await withTenantDb(orgId, async (db) => {
        const ids = [closedId, todoId].sort();
        await db.$queryRaw`SELECT id FROM columns WHERE id = ANY(${ids}) ORDER BY id FOR UPDATE`;
        await db.task.update({
          where: { id: task.id },
          data: { columnId: todoId, completedAt: null },
        });
      });
    } finally {
      release();
    }
    const result = await pending;
    if (surface === 'REST') expect((result as Response).status).toBe(409);
    else expect(result).toMatchObject({ error: expect.stringContaining('concurrently') });
    expect(await readTask(task.id)).toMatchObject({ columnId: todoId, completedAt: null });
  });

  it('completes, preserves, and reopens existing tasks when a column is renamed', async () => {
    const task = await createTask(todoId);
    const now = new Date('2026-10-31T12:00:00.000Z');
    await withTenantDb(orgId, (db) => updateColumn(db, todoId, { name: 'Done' }, now));
    expect((await readTask(task.id)).completedAt).toEqual(now);
    await withTenantDb(orgId, (db) => updateColumn(db, todoId, { name: 'Closed' }));
    expect((await readTask(task.id)).completedAt).toEqual(now);
    await withTenantDb(orgId, (db) => updateColumn(db, todoId, { name: 'To Do' }));
    expect((await readTask(task.id)).completedAt).toBeNull();
  });

  it('rolls back column and task completion changes together', async () => {
    const task = await createTask(todoId);
    await expect(
      withTenantDb(orgId, async (db) => {
        await updateColumn(db, todoId, { name: 'Done' });
        throw new Error('rollback');
      })
    ).rejects.toThrow('rollback');
    expect((await readTask(task.id)).completedAt).toBeNull();
    expect(
      await withTenantDb(orgId, (db) => db.column.findUniqueOrThrow({ where: { id: todoId } }))
    ).toMatchObject({ name: 'To Do' });
  });
});
