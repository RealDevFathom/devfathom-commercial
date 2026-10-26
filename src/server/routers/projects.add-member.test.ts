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

const projectMemberFindUnique = vi.fn();
const projectMemberCount = vi.fn();
const projectMemberUpsert = vi.fn();
const userFindMany = vi.fn();

const db = {
  $queryRaw: vi.fn(async () => [{ id: 'project_1' }]),
  $transaction: vi.fn(async (callback: (tx: never) => Promise<unknown>) => callback(db as never)),
  projectMember: {
    findUnique: projectMemberFindUnique,
    count: projectMemberCount,
    upsert: projectMemberUpsert,
  },
  user: {
    findMany: userFindMany,
    findUnique: vi.fn(async () => null),
  },
  project: { findUnique: vi.fn(async () => null) },
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
    userFindMany.mockResolvedValue([{ id: 'lead_1' }]);
    projectMemberCount.mockResolvedValue(1);
    projectMemberUpsert.mockResolvedValue({
      projectId: 'project_1',
      userId: 'lead_1',
      role: 'MEMBER',
    });
  });

  it('rejects demoting the last lead through the existing-member upsert path', async () => {
    projectMemberFindUnique.mockResolvedValue({
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
    projectMemberFindUnique.mockResolvedValue({
      projectId: 'project_1',
      userId: 'lead_1',
      role: 'LEAD',
    });
    projectMemberCount.mockResolvedValue(2);

    await expect(
      caller().addMember({ projectId: 'project_1', userId: 'lead_1', role: 'MEMBER' })
    ).resolves.toMatchObject({ role: 'MEMBER' });
    expect(projectMemberUpsert).toHaveBeenCalledWith({
      where: { projectId_userId: { projectId: 'project_1', userId: 'lead_1' } },
      create: { projectId: 'project_1', userId: 'lead_1', role: 'MEMBER' },
      update: { role: 'MEMBER' },
    });
    expect(db.$transaction).toHaveBeenCalledOnce();
  });
});
