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
const membershipUpsert = vi.fn();
const userFindMany = vi.fn();
const userFindUnique = vi.fn();
const projectFindUnique = vi.fn();
const activityCreate = vi.fn();

const db = {
  projectMember: { findUnique: membershipFindUnique, upsert: membershipUpsert },
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
    userFindMany.mockResolvedValue([{ id: 'lead_1' }]);
    projectFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue(null);
    activityCreate.mockResolvedValue({});
  });

  it('does not demote an existing lead when called with the MEMBER role', async () => {
    const existingLead = { projectId: 'project_1', userId: 'lead_1', role: 'LEAD' };
    membershipUpsert.mockResolvedValue(existingLead);

    await expect(
      caller().addMember({ projectId: 'project_1', userId: 'lead_1', role: 'MEMBER' })
    ).resolves.toEqual(existingLead);

    expect(membershipUpsert).toHaveBeenCalledWith({
      where: { projectId_userId: { projectId: 'project_1', userId: 'lead_1' } },
      create: { projectId: 'project_1', userId: 'lead_1', role: 'MEMBER' },
      update: {},
    });
  });

  it('still creates a new membership with the requested role', async () => {
    const newLead = { projectId: 'project_1', userId: 'user_2', role: 'LEAD' };
    userFindMany.mockResolvedValue([{ id: 'user_2' }]);
    membershipUpsert.mockResolvedValue(newLead);

    await expect(
      caller().addMember({ projectId: 'project_1', userId: 'user_2', role: 'LEAD' })
    ).resolves.toEqual(newLead);

    expect(membershipUpsert).toHaveBeenCalledWith({
      where: { projectId_userId: { projectId: 'project_1', userId: 'user_2' } },
      create: { projectId: 'project_1', userId: 'user_2', role: 'LEAD' },
      update: {},
    });
  });
});
