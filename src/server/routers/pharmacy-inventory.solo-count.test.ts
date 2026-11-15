/**
 * DEV-682 — solo-pharmacy rule on count approval.
 *
 * A variance above the threshold needs a second person. A pharmacy owner who
 * is the only active member has nobody else, so they may co-authorize their own
 * count with a fresh PIN, and the approval writes an audit row. Anybody else
 * still needs the second person.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  soloOwnerApprovalAllowed: vi.fn(),
  verifyPurchaseApprover: vi.fn(),
  postCountAdjustmentEntry: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(() => ({})),
  withTenantDb: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/finance-postings', () => ({
  postCountAdjustmentEntry: mocks.postCountAdjustmentEntry,
}));
vi.mock('@/lib/pharmacy/purchase-approval', () => ({
  SOLO_OWNER_POLICY: 'PHARMACY_SOLO_OWNER_PIN',
  soloOwnerApprovalAllowed: mocks.soloOwnerApprovalAllowed,
  verifyPurchaseApprover: mocks.verifyPurchaseApprover,
}));

import { pharmacyInventoryRouter } from './pharmacy-inventory';
import type { TRPCContext } from '../trpc';

const OWN_COUNT = {
  id: 'count_1',
  status: 'AWAITING_COAUTH',
  createdById: 'user_a',
  lines: [
    {
      id: 'line_1',
      inventoryLotId: 'lot_1',
      stockLocationId: 'location_1',
      varianceUnits: -12,
      countedSealedPacks: 1,
      countedLooseUnits: 0,
      expectedSealedPacks: 2,
      expectedLooseUnits: 2,
    },
  ],
};

function makeDb() {
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: { permissions: [{ capability: 'pharmacy:inventory', effect: 'ALLOW' }] },
        permissionOverrides: [],
      }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    // DEV-505: approveCount admits only a branch the actor is assigned to.
    pharmacyBranchAssignment: { findFirst: vi.fn().mockResolvedValue({ id: 'assignment_a' }) },
    pharmacyBranch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'branch_a' }),
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        (where.id?.in ?? []).map((id) => ({ id }))
      ),
    },
    pharmacyInventoryCount: {
      findFirst: vi.fn().mockResolvedValue(OWN_COUNT),
      update: vi.fn(async ({ data }: { data: object }) => ({
        id: 'count_1',
        approvedAt: new Date('2026-11-15T10:00:00.000Z'),
        ...data,
      })),
    },
    pharmacyStockMovement: { create: vi.fn().mockResolvedValue({ id: 'movement_1' }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  return Object.assign(db, {
    $transaction: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)),
    $queryRaw: vi.fn(async () => []),
  });
}

let db = makeDb();
function caller() {
  return pharmacyInventoryRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules: ['pharmacy-inventory'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: { expires: 'later', user: { id: 'user_a', role: 'EMPLOYEE', status: 'ACTIVE' } },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

const approve = (extra: Record<string, string> = {}) =>
  caller().approveCount({
    branchId: 'branch_a',
    countId: 'count_1',
    idempotencyKeyPrefix: 'ui-count:count_1',
    varianceReason: 'Two strips damaged',
    ...extra,
  });

beforeEach(() => {
  db = makeDb();
  mocks.soloOwnerApprovalAllowed.mockReset().mockResolvedValue(true);
  mocks.verifyPurchaseApprover.mockReset().mockResolvedValue({ verified: true });
  mocks.postCountAdjustmentEntry.mockReset().mockResolvedValue(null);
});

describe('DEV-682 solo self-approval of a count variance', () => {
  it('still refuses the counter approving their own variance without the solo PIN', async () => {
    await expect(approve()).rejects.toMatchObject({ message: 'COAUTH_REQUIRED' });
    expect(mocks.soloOwnerApprovalAllowed).not.toHaveBeenCalled();
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('lets a solo owner co-authorize with a fresh PIN and records an audit row', async () => {
    await expect(approve({ soloPin: '1234' })).resolves.toMatchObject({ status: 'APPROVED' });
    expect(mocks.soloOwnerApprovalAllowed).toHaveBeenCalledWith(db, 'org_a', 'user_a', 'branch_a');
    expect(mocks.verifyPurchaseApprover).toHaveBeenCalledWith(db, {
      organizationId: 'org_a',
      branchId: 'branch_a',
      approverId: 'user_a',
      pin: '1234',
    });
    expect(db.pharmacyStockMovement.create).toHaveBeenCalledOnce();
    expect(db.auditLog.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        organizationId: 'org_a',
        actorId: 'user_a',
        action: 'pharmacy.inventoryCountSoloApproval',
        targetType: 'PharmacyInventoryCount',
        targetId: 'count_1',
        metadata: {
          branchId: 'branch_a',
          approverId: 'user_a',
          pinVerified: true,
          policy: 'PHARMACY_SOLO_OWNER_PIN',
        },
      }),
    });
  });

  it('refuses the PIN path when another active member could co-authorize', async () => {
    mocks.soloOwnerApprovalAllowed.mockResolvedValue(false);
    await expect(approve({ soloPin: '1234' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.verifyPurchaseApprover).not.toHaveBeenCalled();
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('refuses a wrong or locked-out PIN', async () => {
    mocks.verifyPurchaseApprover.mockResolvedValue({ blocked: 'nope' });
    await expect(approve({ soloPin: '9999' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects a malformed PIN at the input boundary', async () => {
    await expect(approve({ soloPin: 'abc' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.soloOwnerApprovalAllowed).not.toHaveBeenCalled();
  });

  it('still requires a variance reason on the solo path', async () => {
    await expect(approve({ soloPin: '1234', varianceReason: '' })).rejects.toMatchObject({
      message: 'VARIANCE_REASON_REQUIRED',
    });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('refuses a member who is not assigned to the branch before any count work (DEV-505)', async () => {
    db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
    await expect(approve({ soloPin: '1234' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Branch is outside your scope.',
    });
    expect(mocks.soloOwnerApprovalAllowed).not.toHaveBeenCalled();
    expect(mocks.verifyPurchaseApprover).not.toHaveBeenCalled();
    expect(db.pharmacyInventoryCount.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });
});
