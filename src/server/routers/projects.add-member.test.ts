import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('../activity', () => ({ logActivity: vi.fn() }));

import { projectsRouter } from './projects';

const projectMemberFindFirst = vi.fn();
const projectMemberCount = vi.fn();
const projectMemberUpsert = vi.fn();
const userFindMany = vi.fn();

const db = {
  $queryRaw: vi.fn(async () => [{ id: 'project_1' }]),
  $transaction: vi.fn(async (callback: (tx: never) => Promise<unknown>) => callback(db as never)),
  projectMember: {
    findFirst: projectMemberFindFirst,
    count: projectMemberCount,
    upsert: projectMemberUpsert,
  },
  user: {
    findMany: userFindMany,
    findFirst: vi.fn(async () => null),
  },
  project: { findFirst: vi.fn(async () => null) },
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
    userFindMany.mockResolvedValue([{ id: 'lead_1' }]);
    projectMemberCount.mockResolvedValue(1);
    projectMemberUpsert.mockResolvedValue({
      projectId: 'project_1',
      userId: 'lead_1',
      role: 'MEMBER',
    });
  });

  it('rejects an admin project ID from another organization before membership reads', async () => {
    db.$queryRaw.mockResolvedValueOnce([]);

    await expect(
      caller('ADMIN').addMember({ projectId: 'other_org_project', userId: 'lead_1', role: 'MEMBER' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Project not found.' });
    expect(projectMemberFindFirst).not.toHaveBeenCalled();
    expect(projectMemberUpsert).not.toHaveBeenCalled();
  });

  it('rejects demoting the last lead through the existing-member upsert path', async () => {
    projectMemberFindFirst.mockResolvedValue({
      projectId: 'project_1',
      userId: 'lead_1',
      role: 'LEAD',
    });

    await expect(
      caller().addMember({ projectId: 'project_1', userId: 'lead_1', role: 'MEMBER' })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Cannot demote the last lead. Promote another member first.',
    });
    expect(projectMemberUpsert).not.toHaveBeenCalled();
    expect(db.$queryRaw).toHaveBeenCalledOnce();
  });

  it('preserves role updates when another project lead remains', async () => {
    projectMemberFindFirst.mockResolvedValue({
      projectId: 'project_1',
      userId: 'lead_1',
      role: 'LEAD',
    });
    projectMemberCount.mockResolvedValue(2);

    await expect(
      caller().addMember({ projectId: 'project_1', userId: 'lead_1', role: 'MEMBER' })
    ).resolves.toMatchObject({ role: 'MEMBER' });
    expect(db.$queryRaw.mock.invocationCallOrder[0]!).toBeLessThan(
      projectMemberFindFirst.mock.invocationCallOrder[0]!
    );
    expect(projectMemberUpsert).toHaveBeenCalledWith({
      where: { projectId_userId: { projectId: 'project_1', userId: 'lead_1' } },
      create: {
        projectId: 'project_1',
        userId: 'lead_1',
        organizationId: 'org_1',
        role: 'MEMBER',
      },
      update: { role: 'MEMBER' },
    });
    expect(db.$transaction).toHaveBeenCalledOnce();
  });

  it('keeps re-adding an existing member idempotent', async () => {
    projectMemberFindFirst
      .mockResolvedValueOnce({ projectId: 'project_1', userId: 'lead_1', role: 'LEAD' })
      .mockResolvedValueOnce({ projectId: 'project_1', userId: 'member_1', role: 'MEMBER' });
    projectMemberUpsert.mockResolvedValueOnce({
      projectId: 'project_1',
      userId: 'member_1',
      role: 'MEMBER',
    });

    await expect(
      caller().addMember({ projectId: 'project_1', userId: 'member_1', role: 'MEMBER' })
    ).resolves.toMatchObject({ role: 'MEMBER' });
    expect(projectMemberUpsert).toHaveBeenCalledOnce();
  });

  it('allows promoting an existing member', async () => {
    projectMemberFindFirst.mockResolvedValueOnce({
      projectId: 'project_1',
      userId: 'lead_1',
      role: 'LEAD',
    });
    projectMemberUpsert.mockResolvedValueOnce({
      projectId: 'project_1',
      userId: 'member_1',
      role: 'LEAD',
    });

    await expect(
      caller().addMember({ projectId: 'project_1', userId: 'member_1', role: 'LEAD' })
    ).resolves.toMatchObject({ role: 'LEAD' });
    expect(projectMemberCount).not.toHaveBeenCalled();
    expect(projectMemberUpsert).toHaveBeenCalledOnce();
  });
});
