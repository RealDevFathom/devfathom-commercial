/**
 * DEV-80 — a DRAFT transfer request (from lost-demand advice or a stock signal)
 * continues only through people: the source branch allocates it, then a second
 * person approves it. A pharmacy owner who works alone approves their own
 * allocation with a fresh PIN, and that approval writes an audit row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  soloOwnerApprovalAllowed: vi.fn(),
  verifyPurchaseApprover: vi.fn(),
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
vi.mock('@/lib/pharmacy/purchase-approval', () => ({
  SOLO_OWNER_POLICY: 'PHARMACY_SOLO_OWNER_PIN',
  soloOwnerApprovalAllowed: mocks.soloOwnerApprovalAllowed,
  verifyPurchaseApprover: mocks.verifyPurchaseApprover,
}));

import { pharmacyInventoryRouter } from './pharmacy-inventory';
import type { TRPCContext } from '../trpc';

const REQUEST_LINE = {
  id: 'line_1',
  sourceBranchId: 'branch_a',
  sourceLotId: 'lot_1',
  sourceStockLocationId: 'location_src',
  destinationStockLocationId: 'location_dst',
  quantityUnits: 20,
};

function makeDb() {
  const transfer = {
    id: 'transfer_1',
    organizationId: 'org_a',
    fromBranchId: 'branch_a',
    toBranchId: 'branch_b',
    status: 'DRAFT',
    // The destination branch's buyer raised the request.
    allocatedById: 'user_requester',
    lines: [REQUEST_LINE],
  };
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: { permissions: [{ capability: 'pharmacy:inventory', effect: 'ALLOW' }] },
        permissionOverrides: [],
      }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    pharmacyBranchAssignment: { findFirst: vi.fn().mockResolvedValue({ id: 'assignment_a' }) },
    pharmacyBranch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'branch_a' }),
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        (where.id?.in ?? []).map((id) => ({ id }))
      ),
    },
    pharmacyInventoryLot: { findFirst: vi.fn().mockResolvedValue({ id: 'lot_1' }) },
    pharmacyStockLocation: { findFirst: vi.fn().mockResolvedValue({ id: 'location_dst' }) },
    pharmacyInterbranchTransfer: {
      findFirst: vi.fn().mockResolvedValue(transfer),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn(async ({ data }: { data: object }) => ({ ...transfer, ...data })),
      findFirstOrThrow: vi.fn(async () => ({
        ...transfer,
        status: 'ALLOCATED',
        allocatedById: 'user_a',
      })),
    },
    pharmacyStockMovement: { create: vi.fn() },
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

const allocate = () =>
  caller().allocateRequestedTransfer({ branchId: 'branch_a', transferId: 'transfer_1' });
const approve = (extra: Record<string, string> = {}) =>
  caller().approveTransfer({ branchId: 'branch_a', transferId: 'transfer_1', ...extra });

function allocatedBy(actor: string) {
  db.pharmacyInterbranchTransfer.findFirst.mockResolvedValue({
    id: 'transfer_1',
    organizationId: 'org_a',
    fromBranchId: 'branch_a',
    toBranchId: 'branch_b',
    status: 'ALLOCATED',
    allocatedById: actor,
    lines: [REQUEST_LINE],
  });
}

beforeEach(() => {
  db = makeDb();
  mocks.soloOwnerApprovalAllowed.mockReset().mockResolvedValue(true);
  mocks.verifyPurchaseApprover.mockReset().mockResolvedValue({ verified: true });
});

describe('DEV-80 allocating a DRAFT transfer request at the source branch', () => {
  it('turns the request into an ALLOCATED transfer owned by the allocator, moving no stock', async () => {
    await expect(allocate()).resolves.toMatchObject({
      status: 'ALLOCATED',
      allocatedById: 'user_a',
    });
    expect(db.pharmacyInterbranchTransfer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'transfer_1', organizationId: 'org_a', fromBranchId: 'branch_a' },
      })
    );
    // Conditional on DRAFT, so two people cannot both allocate it.
    expect(db.pharmacyInterbranchTransfer.updateMany).toHaveBeenCalledWith({
      where: { id: 'transfer_1', organizationId: 'org_a', status: 'DRAFT' },
      data: { status: 'ALLOCATED', allocatedById: 'user_a' },
    });
    expect(db.pharmacyInventoryLot.findFirst).toHaveBeenCalledWith({
      where: { id: 'lot_1', organizationId: 'org_a', branchId: 'branch_a' },
    });
    expect(db.pharmacyStockLocation.findFirst).toHaveBeenCalledWith({
      where: { id: 'location_dst', organizationId: 'org_a', branchId: 'branch_b' },
    });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('refuses a request already allocated or past DRAFT', async () => {
    allocatedBy('user_b');
    await expect(allocate()).rejects.toMatchObject({ message: 'INVALID_STATE' });
    expect(db.pharmacyInterbranchTransfer.updateMany).not.toHaveBeenCalled();
  });

  it('refuses when a concurrent allocation already flipped the request', async () => {
    db.pharmacyInterbranchTransfer.updateMany.mockResolvedValue({ count: 0 });
    await expect(allocate()).rejects.toMatchObject({ message: 'INVALID_STATE' });
  });

  it('refuses a request whose lot no longer belongs to the source branch', async () => {
    db.pharmacyInventoryLot.findFirst.mockResolvedValue(null);
    await expect(allocate()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'CROSS_BRANCH_REFERENCE',
    });
    expect(db.pharmacyInterbranchTransfer.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a request addressed from another branch', async () => {
    db.pharmacyInterbranchTransfer.findFirst.mockResolvedValue(null);
    await expect(allocate()).rejects.toMatchObject({ message: 'CROSS_BRANCH_REFERENCE' });
    expect(db.pharmacyInterbranchTransfer.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a member not assigned to the source branch before any transfer read', async () => {
    db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
    await expect(allocate()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Branch is outside your scope.',
    });
    expect(db.pharmacyInterbranchTransfer.findFirst).not.toHaveBeenCalled();
  });

  it('never lets a DRAFT request be approved directly', async () => {
    db.pharmacyInterbranchTransfer.findFirst.mockResolvedValue({
      id: 'transfer_1',
      fromBranchId: 'branch_a',
      status: 'DRAFT',
      allocatedById: 'user_requester',
    });
    await expect(approve()).rejects.toMatchObject({ message: 'COAUTH_REQUIRED' });
    await expect(approve({ soloPin: '1234' })).rejects.toMatchObject({
      message: 'COAUTH_REQUIRED',
    });
    expect(db.pharmacyInterbranchTransfer.update).not.toHaveBeenCalled();
  });
});

describe('DEV-80 approving the allocated request', () => {
  it('lets a colleague other than the allocator approve it', async () => {
    allocatedBy('user_b');
    await expect(approve()).resolves.toMatchObject({ status: 'APPROVED', approvedById: 'user_a' });
    expect(mocks.soloOwnerApprovalAllowed).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('still refuses the allocator approving their own transfer without the solo PIN', async () => {
    allocatedBy('user_a');
    await expect(approve()).rejects.toMatchObject({ message: 'COAUTH_REQUIRED' });
    expect(db.pharmacyInterbranchTransfer.update).not.toHaveBeenCalled();
  });

  it('lets a solo owner approve their own allocation with a fresh PIN and audits it', async () => {
    allocatedBy('user_a');
    await expect(approve({ soloPin: '1234' })).resolves.toMatchObject({
      status: 'APPROVED',
      approvedById: 'user_a',
    });
    expect(mocks.soloOwnerApprovalAllowed).toHaveBeenCalledWith(db, 'org_a', 'user_a', 'branch_a');
    expect(mocks.verifyPurchaseApprover).toHaveBeenCalledWith(db, {
      organizationId: 'org_a',
      branchId: 'branch_a',
      approverId: 'user_a',
      pin: '1234',
    });
    expect(db.auditLog.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        organizationId: 'org_a',
        actorId: 'user_a',
        action: 'pharmacy.transferSoloApproval',
        targetType: 'PharmacyInterbranchTransfer',
        targetId: 'transfer_1',
        metadata: {
          branchId: 'branch_a',
          approverId: 'user_a',
          pinVerified: true,
          policy: 'PHARMACY_SOLO_OWNER_PIN',
        },
      }),
    });
  });

  it('refuses the PIN path when another member could approve', async () => {
    allocatedBy('user_a');
    mocks.soloOwnerApprovalAllowed.mockResolvedValue(false);
    await expect(approve({ soloPin: '1234' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.verifyPurchaseApprover).not.toHaveBeenCalled();
    expect(db.pharmacyInterbranchTransfer.update).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('refuses a wrong or locked-out PIN', async () => {
    allocatedBy('user_a');
    mocks.verifyPurchaseApprover.mockResolvedValue({ blocked: 'nope' });
    await expect(approve({ soloPin: '9999' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyInterbranchTransfer.update).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects a malformed PIN at the input boundary', async () => {
    await expect(approve({ soloPin: 'abc' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.soloOwnerApprovalAllowed).not.toHaveBeenCalled();
  });
});
