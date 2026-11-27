/**
 * DEV-1055: projects.createTask adds a column's default assignees only while they
 * may still work on the project (administrators or current members), through the
 * same shared filter moveTask and the assistant use (`task-rules.ts`).
 */
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
vi.mock('../authz', () => ({
  assertProjectAccess: vi.fn(),
  assertBoardAccess: vi.fn(),
  assertColumnAccess: vi.fn(async () => undefined),
  assertTaskAccess: vi.fn(async () => undefined),
}));
vi.mock('../activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/lib/webhooks', () => ({ emitEvent: vi.fn() }));
vi.mock('@/lib/email', () => ({
  appUrl: vi.fn(() => ''),
  templates: { taskAssigned: vi.fn(() => ({})) },
}));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));

import { projectsRouter } from './projects';

const projectMembers = new Set(['actor', 'user_member']);
const workspaceAdmins = new Set(['user_admin_default']);
/** A current member, someone since removed from the project, and an administrator. */
const columnDefaults = ['user_member', 'user_removed', 'user_admin_default'];

type ColumnDefaultWhere = {
  columnId: string;
  user?: { OR: [{ role: 'ADMIN' }, { projectMembers: { some: { projectId: string } } }] };
};

const taskCreate = vi.fn(async ({ data }: { data: { title: string } }) => ({
  id: 'task_new',
  title: data.title,
  priority: 'MEDIUM',
  dueDate: null,
  description: null,
  column: {
    board: { id: 'board_1', name: 'Launch', project: { id: 'project_1', name: 'Website' } },
  },
  assignees: [],
  labels: [],
  _count: { comments: 0, attachments: 0, checklists: 0 },
}));

const db = {
  user: {
    findUnique: vi.fn(async () => ({ id: 'actor', name: 'Asha Actor' })),
    findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id) => ({ id }))
    ),
  },
  column: { findUnique: vi.fn(async () => ({ board: { projectId: 'project_1' } })) },
  projectMember: {
    count: vi.fn(
      async ({ where }: { where: { userId: { in: string[] } } }) =>
        where.userId.in.filter((id) => projectMembers.has(id)).length
    ),
  },
  columnDefaultAssignee: {
    // Honours the filter as the database would: with no `user` filter every
    // default comes back, removed members included.
    findMany: vi.fn(async ({ where }: { where: ColumnDefaultWhere }) =>
      columnDefaults
        .filter((userId) => {
          if (!where.user) return true;
          const projectId = where.user.OR[1].projectMembers.some.projectId;
          return (
            workspaceAdmins.has(userId) || (projectId === 'project_1' && projectMembers.has(userId))
          );
        })
        .map((userId) => ({ userId }))
    ),
  },
  task: { aggregate: vi.fn(async () => ({ _max: { order: 0 } })), create: taskCreate },
};

const caller = () =>
  projectsRouter.createCaller({
    db,
    session: { user: { id: 'actor', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org_1' } },
    organization: { id: 'org_1' },
    entitlements: { enabledModules: ['projects'] },
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);

beforeEach(() => vi.clearAllMocks());

describe('DEV-1055: projects.createTask column default assignees', () => {
  it('adds only administrators and current project members from the column defaults', async () => {
    await caller().createTask({ title: 'Draft copy', columnId: 'column_1' });

    expect(db.columnDefaultAssignee.findMany).toHaveBeenCalledWith({
      where: {
        columnId: 'column_1',
        user: {
          OR: [{ role: 'ADMIN' }, { projectMembers: { some: { projectId: 'project_1' } } }],
        },
      },
      select: { userId: true },
    });
    expect(taskCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assignees: { create: [{ userId: 'user_member' }, { userId: 'user_admin_default' }] },
        }),
      })
    );
  });

  it('still refuses an explicitly named assignee who is not a project member', async () => {
    await expect(
      caller().createTask({
        title: 'Draft copy',
        columnId: 'column_1',
        assigneeIds: ['user_removed'],
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'All assignees must be members of the project.',
    });
    expect(taskCreate).not.toHaveBeenCalled();
  });
});
