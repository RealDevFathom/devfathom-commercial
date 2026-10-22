import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  membership: vi.fn(),
  update: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async () => true) };
});
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('../activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/lib/webhooks', () => ({ emitEvent: vi.fn() }));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(() => 'https://example.test'), templates: {} }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));

import { projectsRouter } from './projects';

const db = {
  projectMember: { findUnique: mocks.membership },
  project: { update: mocks.update },
};

function caller(role: 'ADMIN' | 'EMPLOYEE' = 'EMPLOYEE') {
  return projectsRouter.createCaller({
    db,
    entitlements: { enabledModules: [], modules: [], activeSeats: 1, seatLimit: 10 },
    session: {
      expires: 'later',
      user: {
        id: 'actor_1',
        role,
        department: 'ENGINEERING',
        status: 'ACTIVE',
        organizationId: 'org_1',
      },
    },
    organization: { id: 'org_1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

describe('projects.update management authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockResolvedValue({ id: 'project_1', name: 'Updated project' });
  });

  it('rejects an ordinary project member before writing', async () => {
    mocks.membership.mockResolvedValue({ role: 'MEMBER' });

    await expect(
      caller().update({ id: 'project_1', name: 'Hijacked', status: 'CANCELLED' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([
    ['project lead', 'EMPLOYEE', { role: 'LEAD' }],
    ['tenant admin', 'ADMIN', null],
  ] as const)('allows a %s to update project identity and lifecycle', async (_label, role, member) => {
    mocks.membership.mockResolvedValue(member);

    await caller(role).update({ id: 'project_1', name: 'Approved', status: 'ON_HOLD' });

    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'project_1' },
      data: { name: 'Approved', status: 'ON_HOLD' },
    });
  });
});
