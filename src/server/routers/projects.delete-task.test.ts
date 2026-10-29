import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

import { projectsRouter } from './projects';

const taskFindUnique = vi.fn();
const taskDelete = vi.fn();
const taskDeleteMany = vi.fn();
const membershipFindUnique = vi.fn();
const db = {
  task: { findUnique: taskFindUnique, delete: taskDelete, deleteMany: taskDeleteMany },
  projectMember: { findUnique: membershipFindUnique },
};

function caller(role = 'EMPLOYEE') {
  return projectsRouter.createCaller({
    db,
    session: {
      expires: 'later',
      user: {
        id: 'user_1',
        role,
        department: 'ENGINEERING',
        status: 'ACTIVE',
        organizationId: 'org_1',
      },
    },
    organization: { id: 'org_1' },
    entitlements: { organizationId: 'org_1', enabledModules: [], modules: [], limits: {} },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

describe('projects.deleteTask authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskFindUnique.mockResolvedValue({ column: { board: { projectId: 'project_1' } } });
    taskDelete.mockResolvedValue({ id: 'task_1' });
  });

  it('forbids a project MEMBER before deleting the task', async () => {
    membershipFindUnique.mockResolvedValue({ role: 'MEMBER' });

    await expect(caller().deleteTask({ id: 'task_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(taskDelete).not.toHaveBeenCalled();
  });

  it('allows a project LEAD to delete the task', async () => {
    membershipFindUnique.mockResolvedValue({ role: 'LEAD' });

    await expect(caller().deleteTask({ id: 'task_1' })).resolves.toEqual({ id: 'task_1' });
    expect(taskDelete).toHaveBeenCalledWith({ where: { id: 'task_1' } });
  });

  it('allows an ADMIN without requiring project membership', async () => {
    await expect(caller('ADMIN').deleteTask({ id: 'task_1' })).resolves.toEqual({ id: 'task_1' });
    expect(membershipFindUnique).not.toHaveBeenCalled();
  });
});

describe('projects.bulkDeleteTasks authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskFindUnique.mockResolvedValue({ column: { board: { projectId: 'project_1' } } });
    taskDeleteMany.mockResolvedValue({ count: 2 });
  });

  it.each([null, { role: 'MEMBER' }])(
    'denies insufficient membership %j before deleting any task',
    async (membership) => {
      membershipFindUnique.mockResolvedValue(membership);
      await expect(
        caller().bulkDeleteTasks({ taskIds: ['task_1', 'task_2'] })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(taskDeleteMany).not.toHaveBeenCalled();
    }
  );

  it('checks every selected task before deleting a mixed-project selection', async () => {
    taskFindUnique
      .mockResolvedValueOnce({ column: { board: { projectId: 'project_1' } } })
      .mockResolvedValueOnce({ column: { board: { projectId: 'project_2' } } });
    membershipFindUnique
      .mockResolvedValueOnce({ role: 'LEAD' })
      .mockResolvedValueOnce({ role: 'MEMBER' });
    await expect(caller().bulkDeleteTasks({ taskIds: ['task_1', 'task_2'] })).rejects.toMatchObject(
      { code: 'FORBIDDEN' }
    );
    expect(taskDeleteMany).not.toHaveBeenCalled();
  });

  it.each(['LEAD', 'ADMIN'])('preserves %s bulk deletion', async (role) => {
    membershipFindUnique.mockResolvedValue({ role: 'LEAD' });
    await expect(
      caller(role === 'ADMIN' ? role : 'EMPLOYEE').bulkDeleteTasks({
        taskIds: ['task_1', 'task_2'],
      })
    ).resolves.toEqual({ success: true });
    expect(taskDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ['task_1', 'task_2'] } } });
    if (role === 'ADMIN') expect(membershipFindUnique).not.toHaveBeenCalled();
  });
});
