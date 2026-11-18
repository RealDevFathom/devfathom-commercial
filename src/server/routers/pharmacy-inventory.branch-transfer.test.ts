/**
 * DEV-908 — a recorded stock transfer between branches of the same owner is an
 * optional feature the owner switches on. The server refuses it while the switch
 * is off, for a controlled drug, and for a branch that is not a licensed premises
 * of this owner; a transfer that goes ahead carries a full record at both ends.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const audit = vi.hoisted(() => ({ annotateAudit: vi.fn() }));
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
  annotateAudit: audit.annotateAudit,
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordAudit: vi.fn(),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/finance-postings', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/finance-postings')>()),
  postInterbranchTransferEntry: vi.fn(async () => null),
  postInterbranchTransferReceiptEntry: vi.fn(async () => null),
}));

import { pharmacyInventoryRouter } from './pharmacy-inventory';
import type { TRPCContext } from '../trpc';

const NOW = Date.now();
const LICENSED = {
  provinceCode: 'PB',
  isPlaceholder: false,
  licenceEvidenceFileRef: 'evidence/licence.pdf',
  licenceValidFrom: new Date(NOW - 365 * 86_400_000),
  licenceValidTo: new Date(NOW + 365 * 86_400_000),
};
const BRANCHES: Record<string, { addressLine: string; city: string; licence: string }> = {
  branch_a: { addressLine: '1 Mall Road', city: 'Lahore', licence: 'LIC-A-001' },
  branch_b: { addressLine: '9 Canal Bank', city: 'Lahore', licence: 'LIC-B-002' },
};

type Options = {
  enabled?: boolean;
  controlled?: boolean;
  profileFor?: (branchId: string) => object | null;
  owner?: boolean;
};

function profileOf(branchId: string) {
  const branch = BRANCHES[branchId]!;
  return {
    ...LICENSED,
    premises: { addressLine: branch.addressLine, city: branch.city },
    licenceNumber: branch.licence,
  };
}

function makeDb(options: Options = {}) {
  const transfer = {
    id: 'transfer_1',
    organizationId: 'org_a',
    fromBranchId: 'branch_a',
    toBranchId: 'branch_b',
    status: 'APPROVED',
    allocatedById: 'user_other',
    lines: [
      {
        id: 'line_1',
        sourceBranchId: 'branch_a',
        sourceLotId: 'lot_1',
        sourceStockLocationId: 'location_src',
        destinationStockLocationId: 'location_dst',
        quantityUnits: 20,
        receivedUnits: 0,
      },
    ],
  };
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: { permissions: [{ capability: 'pharmacy:inventory', effect: 'ALLOW' }] },
        permissionOverrides: [],
      }),
      findFirst: vi.fn(async ({ select }: { select?: { organizationRole?: unknown } }) =>
        // The owner check reads the live role; the ADMIN-exception check finds nobody.
        select?.organizationRole && options.owner
          ? {
              role: 'EMPLOYEE',
              status: 'ACTIVE',
              organizationRole: { key: 'owner', isSystem: true, permissions: [] },
              permissionOverrides: [],
            }
          : null
      ),
      findMany: vi.fn().mockResolvedValue([]),
    },
    organization: {
      findFirst: vi.fn(async () => ({
        pharmacyBranchTransfersEnabled: options.enabled ?? true,
        timezone: 'Asia/Karachi',
      })),
      update: vi.fn(
        async ({ data }: { data: { pharmacyBranchTransfersEnabled: boolean } }) => data
      ),
    },
    pharmacyBranchAssignment: { findFirst: vi.fn().mockResolvedValue({ id: 'assignment' }) },
    pharmacyBranch: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        BRANCHES[where.id]
          ? {
              id: where.id,
              active: true,
              provinceCode: 'PB',
              addressLine: BRANCHES[where.id]!.addressLine,
              city: BRANCHES[where.id]!.city,
            }
          : null
      ),
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        (where.id?.in ?? []).map((id) => ({ id }))
      ),
    },
    branchRegulatoryProfile: {
      findFirst: vi.fn(async ({ where }: { where: { branchId: string } }) =>
        (options.profileFor ?? profileOf)(where.branchId)
      ),
    },
    pharmacyInventoryLot: {
      findFirst: vi.fn().mockResolvedValue({ id: 'lot_1' }),
      findMany: vi.fn(async () => [
        {
          id: 'lot_1',
          branchId: 'branch_a',
          batch: { medicine: { controlled: options.controlled ?? false } },
        },
      ]),
      findFirstOrThrow: vi.fn().mockResolvedValue({
        id: 'lot_1',
        manufacturingBatchId: 'batch_1',
        packLevelId: 'pack_1',
        unitsPerPack: 10,
        supplierName: 'Supplier',
        supplierInvoiceRef: 'INV-1',
        unitCostMinor: 100,
        printedMrpMinor: 150,
        receivedExpiresAt: new Date(NOW + 400 * 86_400_000),
        receivedExpiryPrecision: 'DAY',
      }),
      create: vi.fn().mockResolvedValue({ id: 'lot_dst' }),
    },
    pharmacyStockLocation: { findFirst: vi.fn().mockResolvedValue({ id: 'location_dst' }) },
    pharmacyInterbranchTransfer: {
      create: vi.fn().mockResolvedValue({ id: 'transfer_new' }),
      findFirst: vi.fn(async () => transfer),
      findFirstOrThrow: vi.fn(async () => ({ ...transfer, status: 'ALLOCATED' })),
      update: vi.fn(async ({ data }: { data: object }) => ({
        ...transfer,
        dispatchedAt: new Date(NOW),
        ...data,
      })),
    },
    pharmacyInterbranchTransferLine: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    pharmacyStockMovement: {
      create: vi.fn(async ({ data }: { data: object }) => ({
        id: 'movement',
        occurredAt: new Date(NOW),
        ...data,
      })),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $queryRaw: vi.fn(async () => [
      { onHandUnits: 40, unitsPerPack: 10, state: 'ACTIVE', expiresAt: new Date(NOW + 1e10) },
    ]),
  };
  return Object.assign(db, {
    $transaction: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)),
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

const allocate = (toBranchId = 'branch_b') =>
  caller().allocateTransfer({
    branchId: 'branch_a',
    toBranchId,
    lines: [
      {
        sourceLotId: 'lot_1',
        sourceStockLocationId: 'location_src',
        destinationStockLocationId: 'location_dst',
        quantityUnits: 20,
      },
    ],
  });
const dispatch = () =>
  caller().dispatchTransfer({
    branchId: 'branch_a',
    transferId: 'transfer_1',
    idempotencyKeyPrefix: 'dispatch-1',
  });

beforeEach(() => {
  db = makeDb();
  audit.annotateAudit.mockReset();
});

describe('DEV-908 owner switch', () => {
  it('defaults to off in the schema and in the migration', () => {
    const schema = readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    expect(schema).toMatch(/pharmacyBranchTransfersEnabled\s+Boolean\s+@default\(false\)/);
    const migration = readFileSync(
      path.join(
        process.cwd(),
        'prisma/migrations/20261118030000_pharmacy_branch_transfer_policy/migration.sql'
      ),
      'utf8'
    );
    expect(migration).toContain('"pharmacyBranchTransfersEnabled" BOOLEAN NOT NULL DEFAULT false');
  });

  it('refuses a new transfer while the owner has not switched transfers on', async () => {
    db = makeDb({ enabled: false });
    await expect(allocate()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'BRANCH_TRANSFERS_DISABLED',
    });
    expect(db.pharmacyInterbranchTransfer.create).not.toHaveBeenCalled();
  });

  it('refuses to take up a transfer request while the switch is off', async () => {
    db = makeDb({ enabled: false });
    await expect(
      caller().allocateRequestedTransfer({ branchId: 'branch_a', transferId: 'transfer_1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'BRANCH_TRANSFERS_DISABLED' });
  });

  it('reports the switch, and lets only the owner change it', async () => {
    db = makeDb({ enabled: false });
    await expect(caller().branchTransferSettings()).resolves.toEqual({
      enabled: false,
      canChange: false,
    });
    await expect(caller().setBranchTransfersEnabled({ enabled: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.organization.update).not.toHaveBeenCalled();

    db = makeDb({ enabled: false, owner: true });
    await expect(caller().setBranchTransfersEnabled({ enabled: true })).resolves.toEqual({
      enabled: true,
    });
    expect(db.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'org_a' },
        data: { pharmacyBranchTransfersEnabled: true },
      })
    );
    expect(audit.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetType: 'Organization', targetId: 'org_a' })
    );
  });
});

describe('DEV-908 server-side transfer rules', () => {
  it('allocates a transfer between two licensed branches of the owner', async () => {
    await expect(allocate()).resolves.toMatchObject({ status: 'ALLOCATED' });
    expect(db.pharmacyInterbranchTransfer.create).toHaveBeenCalledOnce();
  });

  it('refuses a controlled drug on allocation, even with the switch on', async () => {
    db = makeDb({ controlled: true });
    await expect(allocate()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'CONTROLLED_DRUG_TRANSFER',
    });
    expect(db.pharmacyInterbranchTransfer.create).not.toHaveBeenCalled();
  });

  it('refuses to dispatch a controlled drug, whatever allocated the transfer', async () => {
    db = makeDb({ controlled: true });
    await expect(dispatch()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'CONTROLLED_DRUG_TRANSFER',
    });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('refuses a destination whose premises licence has expired', async () => {
    db = makeDb({
      profileFor: (branchId) =>
        branchId === 'branch_b'
          ? { ...profileOf(branchId), licenceValidTo: new Date(NOW - 86_400_000) }
          : profileOf(branchId),
    });
    await expect(allocate()).rejects.toMatchObject({ message: 'PREMISES_NOT_LICENSED' });
    expect(db.pharmacyInterbranchTransfer.create).not.toHaveBeenCalled();
  });

  it('refuses a destination with no licence, or only a placeholder one', async () => {
    db = makeDb({
      profileFor: (branchId) => (branchId === 'branch_b' ? null : profileOf(branchId)),
    });
    await expect(allocate()).rejects.toMatchObject({ message: 'PREMISES_NOT_LICENSED' });

    db = makeDb({
      profileFor: (branchId) => ({
        ...profileOf(branchId),
        isPlaceholder: branchId === 'branch_b',
      }),
    });
    await expect(allocate()).rejects.toMatchObject({ message: 'PREMISES_NOT_LICENSED' });
  });

  it('refuses a licence recorded for other premises than the branch', async () => {
    db = makeDb({
      profileFor: (branchId) =>
        branchId === 'branch_b'
          ? { ...profileOf(branchId), premises: { addressLine: 'Elsewhere', city: 'Lahore' } }
          : profileOf(branchId),
    });
    await expect(allocate()).rejects.toMatchObject({ message: 'PREMISES_NOT_LICENSED' });
  });

  it('refuses to dispatch when the sending branch is no longer licensed', async () => {
    db = makeDb({
      profileFor: (branchId) => (branchId === 'branch_a' ? null : profileOf(branchId)),
    });
    await expect(dispatch()).rejects.toMatchObject({ message: 'PREMISES_NOT_LICENSED' });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it("refuses a branch of another owner, which is not in this owner's organization", async () => {
    await expect(allocate('branch_of_other_owner')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'BRANCH_NOT_SAME_OWNER',
    });
    expect(db.pharmacyBranch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'branch_of_other_owner', organizationId: 'org_a' },
      })
    );
    expect(db.pharmacyInterbranchTransfer.create).not.toHaveBeenCalled();
  });

  it("refuses stock that is not this owner's stock at the sending branch", async () => {
    db.pharmacyInventoryLot.findMany.mockResolvedValue([]);
    await expect(allocate()).rejects.toMatchObject({ message: 'BRANCH_NOT_SAME_OWNER' });
    expect(db.pharmacyInventoryLot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['lot_1'] }, organizationId: 'org_a' },
      })
    );
  });
});

describe('DEV-908 full record on both sides', () => {
  it('records the sending side: movements out of the branch and both premises licences', async () => {
    await expect(dispatch()).resolves.toMatchObject({
      fromLicenceNumber: 'LIC-A-001',
      toLicenceNumber: 'LIC-B-002',
    });
    const movements = db.pharmacyStockMovement.create.mock.calls.map(([{ data }]) => data);
    expect(movements).toEqual([
      expect.objectContaining({
        branchId: 'branch_a',
        kind: 'TRANSFER_OUT',
        disposition: 'AVAILABLE',
        quantityUnits: -20,
        actorId: 'user_a',
      }),
      expect.objectContaining({
        branchId: 'branch_a',
        kind: 'TRANSFER_IN',
        disposition: 'IN_TRANSIT',
        quantityUnits: 20,
        actorId: 'user_a',
      }),
    ]);
    expect(db.pharmacyInterbranchTransfer.update).toHaveBeenCalledWith({
      where: { id: 'transfer_1' },
      data: { fromLicenceNumber: 'LIC-A-001', toLicenceNumber: 'LIC-B-002' },
    });
  });

  it('records the receiving side: movements into the branch and who received it', async () => {
    db.pharmacyInterbranchTransfer.findFirst.mockResolvedValue({
      ...(await db.pharmacyInterbranchTransfer.findFirst()),
      status: 'DISPATCHED',
    });
    await caller().receiveTransferLine({
      branchId: 'branch_b',
      transferId: 'transfer_1',
      lineId: 'line_1',
      receivedUnits: 20,
      idempotencyKeyPrefix: 'receive-1',
    });
    const movements = db.pharmacyStockMovement.create.mock.calls.map(([{ data }]) => data);
    expect(movements).toEqual([
      expect.objectContaining({
        branchId: 'branch_a',
        kind: 'TRANSFER_OUT',
        disposition: 'IN_TRANSIT',
        quantityUnits: -20,
      }),
      expect.objectContaining({
        branchId: 'branch_b',
        inventoryLotId: 'lot_dst',
        kind: 'TRANSFER_IN',
        disposition: 'AVAILABLE',
        quantityUnits: 20,
        actorId: 'user_a',
      }),
    ]);
    expect(db.pharmacyInterbranchTransfer.update).toHaveBeenLastCalledWith({
      where: { id: 'transfer_1' },
      data: expect.objectContaining({ status: 'RECEIVED', receivedById: 'user_a' }),
    });
  });
});
