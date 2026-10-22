import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  memberCount: vi.fn(),
  memberUpsert: vi.fn(),
  userFindMany: vi.fn(),
}));

vi.mock('server-only', () => ({}));

import { projectsRouter } from './projects';
import type { TRPCContext } from '../trpc';

function caller() {
  return projectsRouter.createCaller({
    db: {
      projectMember: {
        findUnique: mocks.memberFindUnique,
        count: mocks.memberCount,
        upsert: mocks.memberUpsert,
      },
      project: { findUnique: vi.fn().mockResolvedValue(null) },
      user: { findMany: mocks.userFindMany, findUnique: vi.fn().mockResolvedValue(null) },
    },
    entitlements: { enabledModules: ['projects'], modules: ['projects'] },
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
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('projects.addMember role invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFindMany.mockResolvedValue([{ id: 'lead_1' }]);
    mocks.memberFindUnique.mockResolvedValue({ userId: 'lead_1', role: 'LEAD' });
    mocks.memberUpsert.mockResolvedValue({ userId: 'lead_1', role: 'MEMBER' });
  });

  it('rejects demoting the last lead through the add-member upsert path', async () => {
    mocks.memberCount.mockResolvedValue(1);

    await expect(
      caller().addMember({ projectId: 'project_1', userId: 'lead_1', role: 'MEMBER' })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Cannot demote the last lead. Promote another member first.',
    });

    expect(mocks.memberUpsert).not.toHaveBeenCalled();
  });

  it('still permits demotion when another lead remains', async () => {
    mocks.memberCount.mockResolvedValue(2);

    await caller().addMember({ projectId: 'project_1', userId: 'lead_1', role: 'MEMBER' });

    expect(mocks.memberUpsert).toHaveBeenCalledWith({
      where: { projectId_userId: { projectId: 'project_1', userId: 'lead_1' } },
      create: { projectId: 'project_1', userId: 'lead_1', role: 'MEMBER' },
      update: { role: 'MEMBER' },
    });
  });
});
