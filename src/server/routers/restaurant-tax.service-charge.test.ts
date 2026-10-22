import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  annotateAudit: vi.fn(),
  requireBranch: vi.fn(async () => undefined),
  publish: vi.fn(),
  end: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: mocks.annotateAudit,
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/server/restaurant-branch-scope', () => ({
  requireRestaurantBranchScope: mocks.requireBranch,
}));
vi.mock('@/lib/restaurant/service-charge-policy', () => ({
  ServiceChargePolicyError: class ServiceChargePolicyError extends Error {},
  publishServiceChargePolicy: mocks.publish,
  endServiceChargePolicy: mocks.end,
}));

import { restaurantTaxRouter } from './restaurant-tax';

function caller() {
  return restaurantTaxRouter.createCaller({
    db: {
      restaurantBranch: {
        findFirst: vi.fn(async () => ({ timezone: 'UTC' })),
      },
    } as never,
    entitlements: {
      organizationId: 'org-1',
      enabledModules: ['restaurant-core'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: { id: 'user-1', role: 'ADMIN', department: 'OPERATIONS', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

beforeEach(() => {
  mocks.can.mockReset().mockResolvedValue(true);
  mocks.annotateAudit.mockReset();
  mocks.requireBranch.mockReset().mockResolvedValue(undefined);
  mocks.publish.mockReset().mockResolvedValue({
    id: 'policy-1',
    rate: { toString: () => '0.1' },
    effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
    payloadHash: 'publish-hash',
  });
  mocks.end.mockReset().mockResolvedValue({
    id: 'policy-1',
    effectiveTo: new Date('2026-10-01T00:00:00.000Z'),
    endPayloadHash: 'end-hash',
  });
});

describe('service-charge configuration boundary', () => {
  it('authorizes the exact branch and emits attributed sanitized publish audit evidence', async () => {
    await caller().publishServiceCharge({
      branchId: 'branch-1',
      rate: '0.1',
      effectiveFrom: '2026-09-01',
      acknowledgementRef: 'sensitive-accountant-reference',
      acknowledged: true,
      idempotencyKey: 'sensitive-publish-key',
      replaceOpenPolicy: false,
    });

    expect(mocks.requireBranch).toHaveBeenCalledWith(expect.anything(), 'branch-1');
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'restaurant:configure',
      undefined,
      expect.anything()
    );
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetId: 'policy-1',
        metadata: expect.objectContaining({
          branchId: 'branch-1',
          payloadHash: 'publish-hash',
          acknowledgedByUserId: 'user-1',
        }),
      })
    );
    const audit = JSON.stringify(mocks.annotateAudit.mock.calls[0]?.[1]);
    expect(audit).not.toContain('sensitive-accountant-reference');
    expect(audit).not.toContain('sensitive-publish-key');
  });

  it('passes canonical end identity and emits attributed sanitized end audit evidence', async () => {
    await caller().endServiceCharge({
      branchId: 'branch-1',
      policyVersionId: 'policy-1',
      effectiveTo: '2026-10-01',
      idempotencyKey: 'sensitive-end-key',
    });

    expect(mocks.end).toHaveBeenCalledWith(expect.anything(), {
      organizationId: 'org-1',
      branchId: 'branch-1',
      policyVersionId: 'policy-1',
      effectiveTo: new Date('2026-10-01T00:00:00.000Z'),
      idempotencyKey: 'sensitive-end-key',
    });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetId: 'policy-1',
        metadata: expect.objectContaining({
          branchId: 'branch-1',
          payloadHash: 'end-hash',
          endedByUserId: 'user-1',
        }),
      })
    );
    expect(JSON.stringify(mocks.annotateAudit.mock.calls[0]?.[1])).not.toContain(
      'sensitive-end-key'
    );
  });
});
