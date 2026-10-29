import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => false),
  create: vi.fn(),
  branch: vi.fn(),
  mode: vi.fn(),
}));

vi.mock('@/lib/pharmacy/branch-assignment', () => ({ assertBranchAssignment: mocks.branch }));
vi.mock('@/lib/pharmacy/operating-mode', () => ({ enforceOperatingMode: mocks.mode }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import type { TRPCContext } from '../trpc';
import { pharmacyDispensingRouter } from './pharmacy-dispensing';

function caller() {
  return pharmacyDispensingRouter.createCaller({
    db: { pharmacySubstitutionRecord: { create: mocks.create } },
    entitlements: { enabledModules: ['pharmacy-core'] },
    session: {
      expires: 'later',
      user: { id: 'counter-user', role: 'EMPLOYEE', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('AI-05 pharmacist gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(false);
  });

  it('refuses accepting a proposal on an Rx line without pharmacist capability', async () => {
    await expect(
      caller().recordSubstitution({
        prescriptionLineId: 'rx-line',
        saleLineId: 'sale-line',
        prescribedPresentationId: 'prescribed',
        suppliedPresentationId: 'supplied',
        equivalenceBasis: 'Exact ingredient, strength, form and route',
        patientCommunication: 'Patient accepted after pharmacist explanation.',
        jurisdictionRuleRef: 'RX-04',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'pharmacy:dispense',
      undefined,
      expect.anything()
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('decideReview branch authorization', () => {
  it('refuses an unassigned branch before approval or decision writes', async () => {
    mocks.can.mockResolvedValue(true);
    const { TRPCError } = await import('@trpc/server');
    mocks.branch.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    const decision = vi.fn();
    const db = {
      pharmacyPharmacistReviewItem: {
        findFirst: vi.fn(async () => ({
          id: 'review',
          saleLineId: 'line',
          requestedByUserId: 'maker',
        })),
      },
      pharmacySaleLine: { findFirst: vi.fn(async () => ({ branchId: 'unassigned' })) },
      pharmacyPharmacistReviewDecision: { create: decision },
    };
    const ctx = {
      db: { ...db, $transaction: (fn: (tx: unknown) => unknown) => fn(db) },
      session: {
        user: { id: 'checker', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org' },
      },
      entitlements: {
        organizationId: 'org',
        enabledModules: ['pharmacy-core', 'pharmacy-dispensing'],
      },
      audit: { detail: {} },
      requestMeta: { ip: null, userAgent: null },
    } as unknown as TRPCContext;
    await expect(
      pharmacyDispensingRouter
        .createCaller(ctx)
        .decideReview({ reviewItemId: 'review', kind: 'VERIFY', pin: '4729' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branch).toHaveBeenCalledWith(db, {
      organizationId: 'org',
      branchId: 'unassigned',
      actorId: 'checker',
    });
    expect(mocks.mode).not.toHaveBeenCalled();
    expect(decision).not.toHaveBeenCalled();
  });
});
