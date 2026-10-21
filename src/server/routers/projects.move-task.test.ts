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

const tx = {
  task: {
    findMany: vi
      .fn()
      .mockResolvedValueOnce([{ id: 'task-1' }])
      .mockResolvedValueOnce([]),
    update: taskUpdate,
  },
  column: {
    findUnique: vi.fn(async () => ({ board: { projectId: 'destination-project' } })),
  },
  taskAssignee: { deleteMany: assigneeDeleteMany, createMany: vi.fn() },
  columnDefaultAssignee: { findMany: vi.fn(async () => []) },
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
  tx.task.findMany
    .mockResolvedValueOnce([{ id: 'task-1' }])
    .mockResolvedValueOnce([]);
});

describe('projects.moveTask', () => {
  it('removes assignees who are not members of the destination project', async () => {
    await caller().moveTask({ taskId: 'task-1', targetColumnId: 'target-column', newOrder: 0 });

    expect(assigneeDeleteMany).toHaveBeenCalledWith({
      where: {
        taskId: 'task-1',
        user: {
          projectMembers: { none: { projectId: 'destination-project' } },
        },
      },
    });
  });

  it('does not change assignees when moving between boards in the same project', async () => {
    tx.column.findUnique.mockResolvedValueOnce({ board: { projectId: 'source-project' } });

    await caller().moveTask({ taskId: 'task-1', targetColumnId: 'target-column', newOrder: 0 });

    expect(assigneeDeleteMany).not.toHaveBeenCalled();
  });
});
