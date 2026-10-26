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
const labelFindUnique = vi.fn();
const taskLabelCreate = vi.fn();
const membershipFindUnique = vi.fn();
const boardFindUnique = vi.fn();
const db = {
  task: { findUnique: taskFindUnique },
  label: { findUnique: labelFindUnique },
  taskLabel: { create: taskLabelCreate },
  projectMember: { findUnique: membershipFindUnique },
  board: { findUnique: boardFindUnique },
};

function caller() {
  return projectsRouter.createCaller({
    db,
    session: {
      expires: 'later',
      user: {
        id: 'user_1',
        role: 'EMPLOYEE',
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

describe('projects.addLabelToTask authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskFindUnique
      .mockResolvedValueOnce({ column: { board: { projectId: 'project-a' } } })
      .mockResolvedValueOnce({ column: { boardId: 'board-a' } });
    membershipFindUnique.mockResolvedValue({ role: 'MEMBER' });
    taskLabelCreate.mockResolvedValue({ id: 'task-label-1' });
  });

  it('rejects a label whose board the caller cannot access', async () => {
    labelFindUnique.mockResolvedValue({ boardId: 'board-b' });
    boardFindUnique.mockResolvedValue({ projectId: 'project-b' });
    membershipFindUnique.mockResolvedValueOnce({ role: 'MEMBER' }).mockResolvedValueOnce(null);

    await expect(
      caller().addLabelToTask({ taskId: 'task-a', labelId: 'label-b' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(taskLabelCreate).not.toHaveBeenCalled();
  });

  it('rejects an accessible label from a different board', async () => {
    labelFindUnique.mockResolvedValue({ boardId: 'board-b' });
    boardFindUnique.mockResolvedValue({ projectId: 'project-a' });

    await expect(
      caller().addLabelToTask({ taskId: 'task-a', labelId: 'label-b' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(taskLabelCreate).not.toHaveBeenCalled();
  });

  it('attaches a label from the task board', async () => {
    labelFindUnique.mockResolvedValue({ boardId: 'board-a' });
    boardFindUnique.mockResolvedValue({ projectId: 'project-a' });

    await expect(
      caller().addLabelToTask({ taskId: 'task-a', labelId: 'label-a' })
    ).resolves.toEqual({ id: 'task-label-1' });
    expect(taskLabelCreate).toHaveBeenCalledWith({
      data: { taskId: 'task-a', labelId: 'label-a' },
    });
  });
});
