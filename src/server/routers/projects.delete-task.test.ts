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
const membershipFindUnique = vi.fn();
const db = {
  task: { findUnique: taskFindUnique, delete: taskDelete },
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
    expect(membershipFindUnique).toHaveBeenCalledWith({
      where: { projectId_userId: { projectId: 'project_1', userId: 'user_1' } },
      select: { role: true },
    });
  });

  it('forbids an employee who is not a project member before deleting the task', async () => {
    membershipFindUnique.mockResolvedValue(null);

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

  it('keeps ADMIN all-capability access without requiring project membership', async () => {
    await expect(caller('ADMIN').deleteTask({ id: 'task_1' })).resolves.toEqual({ id: 'task_1' });
    expect(membershipFindUnique).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND without attempting deletion when the task does not exist', async () => {
    taskFindUnique.mockResolvedValue(null);

    await expect(caller().deleteTask({ id: 'missing_task' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(membershipFindUnique).not.toHaveBeenCalled();
    expect(taskDelete).not.toHaveBeenCalled();
  });
});
