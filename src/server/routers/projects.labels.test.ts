import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('../activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/lib/webhooks', () => ({ emitEvent: vi.fn() }));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(() => ''), templates: {} }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));

import { projectsRouter } from './projects';

type Where = { where: { id: string; boardId: string } };
type MemberWhere = { where: { projectId_userId: { projectId: string } } };

const db = {
  $queryRaw: vi.fn(async () => []),
  $transaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => callback(db),
  task: { findUnique: vi.fn() },
  projectMember: { findUnique: vi.fn() },
  label: { findFirst: vi.fn() },
  taskLabel: { create: vi.fn(async () => ({ taskId: 'task-a', labelId: 'label-a' })) },
};
const caller = () =>
  projectsRouter.createCaller({
    db,
    session: { user: { id: 'member', role: 'EMPLOYEE', status: 'ACTIVE' } },
    entitlements: { enabledModules: ['projects'] },
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  db.task.findUnique.mockResolvedValue({
    column: { boardId: 'board-a', board: { projectId: 'project-a' } },
  });
  db.projectMember.findUnique.mockImplementation(async ({ where }: MemberWhere) =>
    where.projectId_userId.projectId === 'project-a' ? { role: 'MEMBER' } : null
  );
  db.label.findFirst.mockImplementation(async ({ where }: Where) => {
    const labels = [
      { id: 'label-a', boardId: 'board-a' },
      { id: 'private-label', boardId: 'private-board' },
      { id: 'sibling-label', boardId: 'sibling-board-in-project-a' },
    ];
    return labels.find((label) => label.id === where.id && label.boardId === where.boardId) ?? null;
  });
});

describe('projects.addLabelToTask board boundary', () => {
  it.each(['private-label', 'sibling-label', 'missing'])(
    'rejects %s without writing a link',
    async (labelId) => {
      await expect(caller().addLabelToTask({ taskId: 'task-a', labelId })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(db.taskLabel.create).not.toHaveBeenCalled();
    }
  );

  it('allows a member to attach a label from the exact task board', async () => {
    await expect(
      caller().addLabelToTask({ taskId: 'task-a', labelId: 'label-a' })
    ).resolves.toEqual({ taskId: 'task-a', labelId: 'label-a' });
    expect(db.taskLabel.create).toHaveBeenCalledWith({
      data: { taskId: 'task-a', labelId: 'label-a' },
    });
  });

  it('still denies a task in an inaccessible project', async () => {
    db.projectMember.findUnique.mockResolvedValue(null);
    await expect(
      caller().addLabelToTask({ taskId: 'task-a', labelId: 'label-a' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.taskLabel.create).not.toHaveBeenCalled();
  });
});
