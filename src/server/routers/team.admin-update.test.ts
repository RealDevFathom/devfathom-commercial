/** Regression coverage for #413: admin updates must not return credential fields. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  count: vi.fn(),
  update: vi.fn(),
  can: vi.fn(async () => true),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: ['hr'] })),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(), sendEmail: vi.fn(), templates: {} }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));

import { router, type TRPCContext } from '../trpc';
import { teamRouter } from './team';

function caller() {
  return router({ team: teamRouter }).createCaller({
    db: {
      user: { findUnique: mocks.findUnique, count: mocks.count, update: mocks.update },
      organizationDepartment: { findFirst: vi.fn() },
    },
    entitlements: { enabledModules: ['hr'], modules: [], activeSeats: 2, seatLimit: 50 },
    session: {
      expires: 'later',
      user: { id: 'admin', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org_1' },
    },
    organization: { id: 'org_1', isDemo: false },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).team;
}

describe('team.adminUpdateMember', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.findUnique.mockResolvedValue({
      name: 'Casey',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
    });
    // Prisma honors the select below and therefore returns only this projection.
    mocks.update.mockResolvedValue({
      id: 'casey',
      name: 'Casey',
      email: 'casey@example.test',
      role: 'HR',
      status: 'ACTIVE',
    });
  });

  it('selects and returns only non-credential member fields', async () => {
    const member = await caller().adminUpdateMember({ id: 'casey', role: 'HR' });

    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'casey' },
        data: { role: 'HR' },
        select: expect.objectContaining({ id: true, name: true, email: true, role: true }),
      })
    );
    const select = mocks.update.mock.calls[0]?.[0]?.select;
    expect(select).not.toHaveProperty('password');
    expect(select).not.toHaveProperty('tokenVersion');
    expect(select).not.toHaveProperty('passwordChangedAt');
    expect(member).not.toHaveProperty('password');
  });
});
