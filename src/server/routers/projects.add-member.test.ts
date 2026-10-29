import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

import { projectsRouter } from './projects';

const membershipFindUnique = vi.fn();
const membershipCreate = vi.fn();
const membershipUpdate = vi.fn();
const membershipCount = vi.fn();
const userFindMany = vi.fn();
const userFindUnique = vi.fn();
const projectFindUnique = vi.fn();
const activityCreate = vi.fn();
const executeRaw = vi.fn();

const db = {
  $executeRawUnsafe: executeRaw,
  $transaction: vi.fn(async (run: (tx: typeof db) => Promise<unknown>) => run(db)),
  projectMember: {
    findUnique: membershipFindUnique,
    create: membershipCreate,
    update: membershipUpdate,
    count: membershipCount,
  },
  user: { findMany: userFindMany, findUnique: userFindUnique },
  project: { findUnique: projectFindUnique },
  activity: { create: activityCreate },
};

function caller() {
  return projectsRouter.createCaller({
    db,
    session: {
      expires: 'later',
      user: {
        id: 'lead_1',
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

describe('projects.addMember role invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    membershipFindUnique.mockResolvedValue({
      projectId: 'project_1',
      userId: 'lead_1',
      role: 'LEAD',
    });
    membershipCount.mockResolvedValue(1);
    userFindMany.mockResolvedValue([{ id: 'lead_1' }]);
    projectFindUnique.mockResolvedValue({ name: 'Project' });
    userFindUnique.mockResolvedValue({ name: 'Person' });
    activityCreate.mockResolvedValue({});
    executeRaw.mockResolvedValue(0);
  });

  it('refuses to demote the last lead', async () => {
    await expect(
      caller().addMember({ projectId: 'project_1', userId: 'lead_1', role: 'MEMBER' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(membershipUpdate).not.toHaveBeenCalled();
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it('promotes an existing member without recording a false add activity', async () => {
    const member = { projectId: 'project_1', userId: 'user_2', role: 'MEMBER' };
    const promoted = { ...member, role: 'LEAD' };
    membershipFindUnique
      .mockResolvedValueOnce({ projectId: 'project_1', userId: 'lead_1', role: 'LEAD' })
      .mockResolvedValueOnce(member);
    userFindMany.mockResolvedValue([{ id: 'user_2' }]);
    membershipUpdate.mockResolvedValue(promoted);

    await expect(
      caller().addMember({ projectId: 'project_1', userId: 'user_2', role: 'LEAD' })
    ).resolves.toEqual(promoted);
    expect(membershipUpdate).toHaveBeenCalledWith({
      where: { projectId_userId: { projectId: 'project_1', userId: 'user_2' } },
      data: { role: 'LEAD' },
    });
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it('keeps an existing role idempotently without recording add activity', async () => {
    const lead = { projectId: 'project_1', userId: 'lead_1', role: 'LEAD' };
    await expect(
      caller().addMember({ projectId: 'project_1', userId: 'lead_1', role: 'LEAD' })
    ).resolves.toEqual(lead);
    expect(membershipUpdate).not.toHaveBeenCalled();
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it('creates a new membership and records the add activity once', async () => {
    const newLead = { projectId: 'project_1', userId: 'user_2', role: 'LEAD' };
    membershipFindUnique
      .mockResolvedValueOnce({ projectId: 'project_1', userId: 'lead_1', role: 'LEAD' })
      .mockResolvedValueOnce(null);
    userFindMany.mockResolvedValue([{ id: 'user_2' }]);
    membershipCreate.mockResolvedValue(newLead);

    await expect(
      caller().addMember({ projectId: 'project_1', userId: 'user_2', role: 'LEAD' })
    ).resolves.toEqual(newLead);
    expect(membershipCreate).toHaveBeenCalledWith({
      data: { projectId: 'project_1', userId: 'user_2', role: 'LEAD' },
    });
    expect(activityCreate).toHaveBeenCalledOnce();
  });
});
