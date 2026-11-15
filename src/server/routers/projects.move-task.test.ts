import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertTaskAccess: vi.fn(async () => undefined),
  assertColumnAccess: vi.fn(async () => undefined),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('../authz', () => ({
  assertProjectAccess: vi.fn(),
  assertBoardAccess: vi.fn(),
  assertColumnAccess: mocks.assertColumnAccess,
  assertTaskAccess: mocks.assertTaskAccess,
}));
vi.mock('../activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/lib/webhooks', () => ({ emitEvent: vi.fn() }));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(() => ''), templates: {} }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));

import { projectsRouter } from './projects';

const taskUpdate = vi.fn(async () => ({}));
const assigneeDeleteMany = vi.fn(async () => ({ count: 1 }));
const defaultAssigneeFindMany = vi.fn(async (): Promise<{ userId: string }[]> => []);

const tx = {
  task: {
    findMany: vi
      .fn()
      .mockResolvedValueOnce([{ id: 'task-1' }])
      .mockResolvedValueOnce([]),
    update: taskUpdate,
    findUnique: vi.fn(async () => ({ columnId: 'source-column' })),
  },
  $queryRaw: vi.fn(async () => []),
  column: {
    findUnique: vi.fn(async () => ({ board: { projectId: 'destination-project' } })),
  },
  taskAssignee: { deleteMany: assigneeDeleteMany, createMany: vi.fn() },
  columnDefaultAssignee: { findMany: defaultAssigneeFindMany },
};

const db = {
  task: {
    findUnique: vi.fn(async () => ({
      id: 'task-1',
      title: 'Private task',
      columnId: 'source-column',
      column: { name: 'To Do', board: { projectId: 'source-project' } },
    })),
  },
  column: { findUnique: vi.fn(async () => null) },
  $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
};

const caller = () =>
  projectsRouter.createCaller({
    db,
    session: { user: { id: 'actor', role: 'ADMIN', status: 'ACTIVE' } },
    entitlements: { enabledModules: ['projects'] },
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  tx.task.findMany.mockResolvedValueOnce([{ id: 'task-1' }]).mockResolvedValueOnce([]);
});

describe('projects.moveTask', () => {
  it('keeps admins and destination members while removing unauthorized assignees', async () => {
    await caller().moveTask({ taskId: 'task-1', targetColumnId: 'target-column', newOrder: 0 });

    expect(assigneeDeleteMany).toHaveBeenCalledWith({
      where: {
        taskId: 'task-1',
        user: {
          role: { not: 'ADMIN' },
          projectMembers: { none: { projectId: 'destination-project' } },
        },
      },
    });
    expect(defaultAssigneeFindMany).toHaveBeenCalledWith({
      where: {
        columnId: 'target-column',
        user: {
          OR: [
            { role: 'ADMIN' },
            { projectMembers: { some: { projectId: 'destination-project' } } },
          ],
        },
      },
      select: { userId: true },
    });
  });

  it('does not change assignees when moving between boards in the same project', async () => {
    tx.column.findUnique.mockResolvedValueOnce({ board: { projectId: 'source-project' } });

    await caller().moveTask({ taskId: 'task-1', targetColumnId: 'target-column', newOrder: 0 });

    expect(assigneeDeleteMany).not.toHaveBeenCalled();
  });

  it('removes unauthorized assignees from every cross-project bulk move', async () => {
    tx.task.findMany
      .mockReset()
      .mockResolvedValueOnce([
        { id: 'task-1', columnId: 'source-column' },
        { id: 'task-2', columnId: 'other-column' },
      ])
      .mockResolvedValueOnce([
        { id: 'task-1', columnId: 'source-column' },
        { id: 'task-2', columnId: 'other-column' },
      ])
      .mockResolvedValueOnce([
        { id: 'task-1', column: { board: { projectId: 'source-project' } } },
        { id: 'task-2', column: { board: { projectId: 'destination-project' } } },
      ])
      .mockResolvedValueOnce([]);

    await caller().bulkMoveTasks({
      taskIds: ['task-1', 'task-2'],
      targetColumnId: 'target-column',
    });

    expect(assigneeDeleteMany).toHaveBeenCalledWith({
      where: {
        taskId: { in: ['task-1'] },
        user: {
          role: { not: 'ADMIN' },
          projectMembers: { none: { projectId: 'destination-project' } },
        },
      },
    });
    expect(defaultAssigneeFindMany).toHaveBeenCalledWith({
      where: {
        columnId: 'target-column',
        user: {
          OR: [
            { role: 'ADMIN' },
            { projectMembers: { some: { projectId: 'destination-project' } } },
          ],
        },
      },
      select: { userId: true },
    });
  });
});

describe('projects.moveTask concurrency', () => {
  it('locks the columns and refuses a task that moved since the access check', async () => {
    tx.task.findUnique.mockResolvedValueOnce({ columnId: 'elsewhere' });
    await expect(
      caller().moveTask({ taskId: 'task-1', targetColumnId: 'target-column', newOrder: 0 })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(taskUpdate).not.toHaveBeenCalled();
  });
});

describe('projects.bulkMoveTasks concurrency', () => {
  it('locks destination and source columns in sorted order and refuses concurrent moves', async () => {
    tx.task.findMany
      .mockReset()
      .mockResolvedValueOnce([{ id: 'task-1', columnId: 'z-source' }])
      .mockResolvedValueOnce([{ id: 'task-1', columnId: 'moved-away' }]);

    await expect(
      caller().bulkMoveTasks({ taskIds: ['task-1'], targetColumnId: 'a-target' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const lockCall = tx.$queryRaw.mock.calls[0] as unknown[];
    expect(lockCall[1]).toEqual(['a-target', 'z-source']);
    expect(taskUpdate).not.toHaveBeenCalled();
    expect(assigneeDeleteMany).not.toHaveBeenCalled();
  });
});

describe('column defaults on task moves', () => {
  it.each(['single', 'bulk'] as const)(
    'adds admin and member defaults without replacing existing assignees on a %s move',
    async (mode) => {
      defaultAssigneeFindMany.mockResolvedValueOnce([
        { userId: 'admin-without-membership' },
        { userId: 'destination-member' },
      ]);
      tx.task.findMany.mockReset();
      if (mode === 'bulk') {
        tx.task.findMany
          .mockResolvedValueOnce([{ id: 'task-1', columnId: 'source-column' }])
          .mockResolvedValueOnce([{ id: 'task-1', columnId: 'source-column' }])
          .mockResolvedValueOnce([
            { id: 'task-1', column: { board: { projectId: 'source-project' } } },
          ])
          .mockResolvedValueOnce([]);
        await caller().bulkMoveTasks({ taskIds: ['task-1'], targetColumnId: 'target-column' });
      } else {
        tx.task.findMany.mockResolvedValueOnce([{ id: 'task-1' }]).mockResolvedValueOnce([]);
        await caller().moveTask({ taskId: 'task-1', targetColumnId: 'target-column', newOrder: 0 });
      }

      expect(defaultAssigneeFindMany).toHaveBeenCalledWith({
        where: {
          columnId: 'target-column',
          user: {
            OR: [
              { role: 'ADMIN' },
              { projectMembers: { some: { projectId: 'destination-project' } } },
            ],
          },
        },
        select: { userId: true },
      });
      expect(tx.taskAssignee.createMany).toHaveBeenCalledExactlyOnceWith({
        data: [
          { taskId: 'task-1', userId: 'admin-without-membership' },
          { taskId: 'task-1', userId: 'destination-member' },
        ],
        skipDuplicates: true,
      });
      expect(mocks.assertTaskAccess).toHaveBeenCalledWith(expect.anything(), 'task-1');
      expect(mocks.assertColumnAccess).toHaveBeenCalledWith(expect.anything(), 'target-column');
    }
  );
});
