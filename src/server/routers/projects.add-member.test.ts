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
const membershipDelete = vi.fn();
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
    delete: membershipDelete,
    count: membershipCount,
  },
  user: { findMany: userFindMany, findUnique: userFindUnique },
  project: { findUnique: projectFindUnique },
  activity: { create: activityCreate },
};

function caller(role = 'EMPLOYEE') {
  return projectsRouter.createCaller({
    db,
    session: {
      expires: 'later',
      user: {
        id: 'lead_1',
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

  it('rechecks the lead count after a removal waits for a concurrent demotion', async () => {
    membershipCount.mockResolvedValue(2);
    // The other transaction demotes a lead before releasing the project lock.
    executeRaw.mockImplementationOnce(async () => {
      membershipCount.mockResolvedValue(1);
      return 0;
    });

    await expect(
      caller().removeMember({ projectId: 'project_1', userId: 'lead_1' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(membershipDelete).not.toHaveBeenCalled();
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it.each(['addMember', 'setMemberRole'] as const)(
    '%s rechecks caller authority after waiting for a concurrent demotion',
    async (method) => {
      const lead = { projectId: 'project_1', userId: 'lead_1', role: 'LEAD' };
      membershipFindUnique.mockImplementation(async ({ where }) => ({
        ...lead,
        userId: where.projectId_userId.userId,
      }));
      userFindMany.mockResolvedValue([{ id: 'user_2' }]);
      executeRaw.mockImplementationOnce(async () => {
        membershipFindUnique.mockImplementation(async ({ where }) => ({
          ...lead,
          userId: where.projectId_userId.userId,
          role: 'MEMBER',
        }));
        return 0;
      });

      await expect(
        caller()[method]({ projectId: 'project_1', userId: 'user_2', role: 'LEAD' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(membershipUpdate).not.toHaveBeenCalled();
      expect(membershipCreate).not.toHaveBeenCalled();
    }
  );

  it('allows a member to leave while preserving lead and admin removal permissions', async () => {
    membershipFindUnique.mockResolvedValue({ role: 'MEMBER' });
    await expect(
      caller().removeMember({ projectId: 'project_1', userId: 'lead_1' })
    ).resolves.toEqual({ success: true });

    await expect(
      caller().removeMember({ projectId: 'project_1', userId: 'user_2' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(
      caller('ADMIN').removeMember({ projectId: 'project_1', userId: 'user_2' })
    ).resolves.toEqual({ success: true });

    membershipFindUnique.mockResolvedValue({ role: 'LEAD' });
    membershipCount.mockResolvedValue(2);
    await expect(
      caller().removeMember({ projectId: 'project_1', userId: 'user_2' })
    ).resolves.toEqual({ success: true });
    expect(membershipDelete).toHaveBeenCalledTimes(3);
  });
});
