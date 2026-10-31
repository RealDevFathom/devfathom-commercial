/**
 * PH-INV / INV-01..04 — the transport layer.
 *
 * These cases cover only what the router itself owns: the `pharmacy-inventory`
 * entitlement mapping, the refusal to take the tenant or the actor from the
 * payload, and cross-tenant ID substitution on the two references the router
 * checks before it reaches the ledger. Every invariant the ledger and its
 * triggers own is proved against a real database in
 * `lib/pharmacy/stock-ledger.db.test.ts`, not here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const hasModule = vi.fn<(view: { enabledModules: string[] }, key: string) => boolean>();
  hasModule.mockReturnValue(true);
  const postWriteOffEntry = vi.fn();
  return { hasModule, postWriteOffEntry };
});
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/pharmacy/solo-approval', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/solo-approval')>()),
  verifyPharmacyUserPin: vi.fn(async (_scope, pin) => pin === '4729'),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.hasModule,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/finance-postings', () => ({
  postWriteOffEntry: mocks.postWriteOffEntry,
}));

import { moduleForProcedure } from '@/lib/module-catalog';

import { pharmacyInventoryRouter } from './pharmacy-inventory';
import type { TRPCContext } from '../trpc';

function model() {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi
      .fn()
      .mockImplementation(async ({ data }: { data: object }) => ({ id: 'new', ...data })),
    update: vi.fn(),
    count: vi.fn(),
  };
}

function makeDb() {
  const db = {
    organization: { findFirstOrThrow: vi.fn(async () => ({ pharmacyOperatingMode: 'STAFFED' })) },
    auditLog: { create: vi.fn() },
    pharmacyBranchAssignment: { findMany: vi.fn(async () => [{ branchId: 'branch_a' }]) },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        role: 'EMPLOYEE',
        status: 'ACTIVE',
        organizationId: 'org_a',
        organizationRole: { permissions: [] },
        permissionOverrides: [],
      }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    medicine: model(),
    packLevel: model(),
    camera: model(),
    pharmacyStockLocation: model(),
    pharmacyTemperatureLog: Object.assign(model(), {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    }),
    pharmacyManufacturingBatch: Object.assign(model(), {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    }),
    pharmacyRecallNotice: model(),
    pharmacyInventoryLot: model(),
    pharmacyStockMovement: model(),
    pharmacyCustodyRecord: model(),
    pharmacyStockBalance: model(),
    pharmacyAllocationOverride: model(),
    pharmacyStockDiscrepancy: model(),
    pharmacyRecallAcknowledgement: model(),
    pharmacySafetyStock: Object.assign(model(), {
      upsert: vi
        .fn()
        .mockImplementation(async ({ create }: { create: object }) => ({ id: 'new', ...create })),
      findMany: vi.fn().mockResolvedValue([]),
    }),
    pharmacyStockSignal: Object.assign(model(), { findMany: vi.fn().mockResolvedValue([]) }),
    pharmacyStockSignalEvent: model(),
    pharmacyStockSignalAction: model(),
    pharmacyRequisition: model(),
    pharmacyRequisitionLine: model(),
    pharmacyInterbranchTransfer: model(),
    pharmacyPurchaseReturn: model(),
    pharmacyPurchaseReturnLine: model(),
    pharmacyBranch: {
      findFirst: vi.fn(async () => ({ id: 'branch_a' })),
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        (where.id?.in ?? []).map((id) => ({ id }))
      ),
    },
  };
  return Object.assign(db, {
    $transaction: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)),
    $queryRaw: vi.fn(async () => []),
  });
}

let db = makeDb();
function caller(overrides: { enabledModules?: string[]; userId?: string | null } = {}) {
  return pharmacyInventoryRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules: overrides.enabledModules ?? ['pharmacy-inventory'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session:
      overrides.userId === null
        ? null
        : {
            expires: 'later',
            user: { id: overrides.userId ?? 'user_a', role: 'ADMIN', status: 'ACTIVE' },
          },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const allow = (capability: string): Rule => ({ capability, effect: 'ALLOW' });
const deny = (capability: string): Rule => ({ capability, effect: 'DENY' });

/** What `can()` reads: the member's role rules and their own overrides. */
function grant(role: Rule[], overrides: Rule[] = []) {
  db.user.findUnique.mockResolvedValue({
    role: 'EMPLOYEE',
    status: 'ACTIVE',
    organizationId: 'org_a',
    organizationRole: { permissions: role },
    permissionOverrides: overrides,
  });
}

/** The capability middleware's refusal, as opposed to a handler's own FORBIDDEN. */
const CAPABILITY_REFUSAL = {
  code: 'FORBIDDEN',
  message: 'You do not have permission for this action.',
};

beforeEach(() => {
  db = makeDb();
  mocks.hasModule.mockImplementation((view, key) => view.enabledModules.includes(key));
  mocks.postWriteOffEntry.mockReset();
});

describe('pharmacy write-off accounting', () => {
  it('posts the write-off journal in the same transaction as the stock movement', async () => {
    grant([allow('pharmacy:inventory')]);
    db.user.findFirst.mockResolvedValue({ id: 'user_b', organizationRole: { key: 'manager' } });
    const occurredAt = new Date('2026-10-29T00:02:07.000Z');
    db.pharmacyInventoryLot.findFirst.mockResolvedValue({
      id: 'lot_1',
      unitsPerPack: 10,
    });
    db.pharmacyStockBalance.findFirst.mockResolvedValue({
      onHandUnits: 20,
      sealedPacks: 2,
      looseUnits: 0,
    });
    db.pharmacyStockMovement.create.mockResolvedValue({
      id: 'movement_1',
      occurredAt,
    });

    await caller().writeOff({
      branchId: 'branch_a',
      inventoryLotId: 'lot_1',
      stockLocationId: 'location_1',
      units: 10,
      witnessId: 'user_b',
      pin: '4729',
      reason: 'Expired stock destroyed',
      evidenceRef: 'DEST-1',
      idempotencyKey: 'writeoff-1',
    });

    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(mocks.postWriteOffEntry).toHaveBeenCalledWith(
      db,
      { organizationId: 'org_a', branchId: 'branch_a', actorId: 'user_a' },
      { stockMovementId: 'movement_1', at: occurredAt }
    );
  });
});

describe('pharmacy inventory entitlement and tenant boundaries', () => {
  it('maps the public router prefix to the pharmacy-inventory entitlement', () => {
    expect(moduleForProcedure('pharmacyInventory.allocateForSale')).toBe('pharmacy-inventory');
    // Not the mandatory Core module the medicine identity lane maps to.
    expect(moduleForProcedure('pharmacyMedicine.createIngredient')).toBe('pharmacy-core');
  });

  it('rejects a cross-tenant medicine ID substitution when registering a batch', async () => {
    await expect(
      caller().registerBatch({
        medicineId: 'medicine_from_org_b',
        batchNumber: 'B-1',
        printedExpiry: new Date('2027-06-15T00:00:00.000Z'),
        expiryPrecision: 'DAY',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyManufacturingBatch.create).not.toHaveBeenCalled();
  });

  it('rejects a cross-tenant pack level ID substitution when receiving a lot', async () => {
    grant([allow('pharmacy:inventory')]);
    await expect(
      caller().receiveLot({
        branchId: 'branch_a',
        manufacturingBatchId: 'batch_1',
        packLevelId: 'pack_level_from_org_b',
        stockLocationId: 'location_1',
        unitsPerPack: 10,
        supplierName: 'Distributor Ltd',
        supplierInvoiceRef: 'INV-1',
        unitCostMinor: 1200,
        printedMrpMinor: 2000,
        printedExpiry: new Date('2027-06-15T00:00:00.000Z'),
        expiryPrecision: 'DAY',
        quantityUnits: 100,
        idempotencyKey: 'receipt-1',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyInventoryLot.create).not.toHaveBeenCalled();
  });

  it('takes the organization from the session, never from the payload', async () => {
    grant([allow('pharmacy:inventory')]);
    db.medicine.findFirst.mockResolvedValue({ id: 'medicine_1' });
    await caller().registerBatch({
      medicineId: 'medicine_1',
      batchNumber: 'B-1',
      printedExpiry: new Date('2027-06-15T00:00:00.000Z'),
      expiryPrecision: 'DAY',
    });
    expect(db.pharmacyManufacturingBatch.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ organizationId: 'org_a' }) })
    );
  });

  it('normalises a MONTH-precision expiry to the first instant after the month', async () => {
    grant([allow('pharmacy:inventory')]);
    db.medicine.findFirst.mockResolvedValue({ id: 'medicine_1' });
    await caller().registerBatch({
      medicineId: 'medicine_1',
      batchNumber: 'B-1',
      // Printed "06/2027": good through the whole of June.
      printedExpiry: new Date('2027-06-15T00:00:00.000Z'),
      expiryPrecision: 'MONTH',
    });
    expect(db.pharmacyManufacturingBatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ expiresAt: new Date('2027-06-30T19:00:00.000Z') }),
      })
    );
  });

  it('refuses to block a batch without a reason (INV-03 evidence)', async () => {
    db.user.findUnique.mockResolvedValue({
      role: 'EMPLOYEE',
      status: 'ACTIVE',
      organizationId: 'org_a',
      organizationRole: {
        permissions: [{ capability: 'pharmacy:safety', effect: 'ALLOW' }],
      },
      permissionOverrides: [],
    });
    db.pharmacyManufacturingBatch.findFirst.mockResolvedValue({ id: 'batch_1' });
    await expect(
      caller().setBatchState({ manufacturingBatchId: 'batch_1', state: 'RECALLED' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacyManufacturingBatch.update).not.toHaveBeenCalled();
  });

  it('rejects a write-off witness who is not an active member assigned to the branch', async () => {
    grant([allow('pharmacy:inventory')]);

    await expect(
      caller().writeOff({
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_1',
        units: 1,
        witnessId: 'untrusted_string',
        reason: 'Damaged package',
        evidenceRef: 'PHOTO-1',
        idempotencyKey: 'write-off-1',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'COAUTH_REQUIRED' });

    expect(db.user.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'untrusted_string',
        organizationId: 'org_a',
        status: 'ACTIVE',
        pharmacyBranchAssignments: {
          some: { organizationId: 'org_a', branchId: 'branch_a', active: true },
        },
      },
      select: { id: true },
    });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacyCustodyRecord.create).not.toHaveBeenCalled();
  });

  it('accepts an active same-tenant witness assigned to the write-off branch', async () => {
    grant([allow('pharmacy:inventory')]);
    db.user.findFirst.mockResolvedValue({ id: 'witness_a', organizationRole: { key: 'manager' } });
    db.pharmacyInventoryLot.findFirst.mockResolvedValue({ id: 'lot_1', unitsPerPack: 1 });
    db.pharmacyStockBalance.findFirst.mockResolvedValue({
      onHandUnits: 5,
      sealedPacks: 5,
      looseUnits: 0,
    });

    await caller().writeOff({
      branchId: 'branch_a',
      inventoryLotId: 'lot_1',
      stockLocationId: 'location_1',
      units: 1,
      witnessId: 'witness_a',
      pin: '4729',
      reason: 'Damaged package',
      evidenceRef: 'PHOTO-1',
      idempotencyKey: 'write-off-1',
    });

    expect(db.pharmacyCustodyRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org_a',
        branchId: 'branch_a',
        actorId: 'user_a',
        witnessId: 'witness_a',
      }),
    });
  });

  it.each([
    ['setBatchState', { manufacturingBatchId: 'batch_1', state: 'ACTIVE' }],
    ['acknowledgeRecall', { branchId: 'branch_a', recallNoticeId: 'recall_1' }],
    ['closeRecall', { recallNoticeId: 'recall_1' }],
  ] as const)('requires pharmacy:safety for %s', async (procedure, input) => {
    await expect(caller()[procedure](input as never)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each(['RECALLED', 'QUARANTINED'] as const)(
    'does not let an ordinary member reactivate a %s batch',
    async (state) => {
      db.pharmacyManufacturingBatch.findFirst.mockResolvedValue({
        id: 'batch_1',
        medicineId: 'medicine_1',
        state,
      });

      await expect(
        caller().setBatchState({ manufacturingBatchId: 'batch_1', state: 'ACTIVE' })
      ).rejects.toMatchObject(CAPABILITY_REFUSAL);

      expect(db.pharmacyManufacturingBatch.findFirst).not.toHaveBeenCalled();
      expect(db.pharmacyManufacturingBatch.update).not.toHaveBeenCalled();
    }
  );

  it('does not let a safety user reactivate a batch covered by an open recall', async () => {
    grant([allow('pharmacy:safety')]);
    db.pharmacyManufacturingBatch.findFirst.mockResolvedValue({
      id: 'batch_1',
      medicineId: 'medicine_1',
      state: 'RECALLED',
    });
    db.pharmacyRecallNotice.count.mockResolvedValue(1);

    await expect(
      caller().setBatchState({ manufacturingBatchId: 'batch_1', state: 'ACTIVE' })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Close the open recall before reactivating this batch.',
    });

    expect(db.pharmacyRecallNotice.count).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_a',
        status: 'OPEN',
        OR: [{ batchId: 'batch_1' }, { medicineId: 'medicine_1' }],
      },
    });
    expect(db.pharmacyManufacturingBatch.update).not.toHaveBeenCalled();
  });

  it('allows a safety user to reactivate a batch when no recall remains open', async () => {
    grant([allow('pharmacy:safety')]);
    db.pharmacyManufacturingBatch.findFirst.mockResolvedValue({
      id: 'batch_1',
      medicineId: 'medicine_1',
      state: 'QUARANTINED',
    });
    db.pharmacyRecallNotice.count.mockResolvedValue(0);

    await caller().setBatchState({ manufacturingBatchId: 'batch_1', state: 'ACTIVE' });

    expect(db.pharmacyManufacturingBatch.update).toHaveBeenCalledWith({
      where: { id: 'batch_1' },
      data: { state: 'ACTIVE', stateReason: null, stateChangedAt: null },
    });
  });

  it('allows an exact pharmacy:safety grant to acknowledge a recall', async () => {
    db.user.findUnique.mockResolvedValue({
      role: 'EMPLOYEE',
      status: 'ACTIVE',
      organizationId: 'org_a',
      organizationRole: {
        permissions: [{ capability: 'pharmacy:safety', effect: 'ALLOW' }],
      },
      permissionOverrides: [],
    });

    await caller().acknowledgeRecall({ branchId: 'branch_a', recallNoticeId: 'recall_1' });

    expect(db.pharmacyRecallAcknowledgement.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org_a',
        recallNoticeId: 'recall_1',
        branchId: 'branch_a',
        actorId: 'user_a',
      },
    });
  });

  it('refuses a transfer whose source and destination are the same location', async () => {
    grant([allow('pharmacy:inventory')]);
    await expect(
      caller().transfer({
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        fromStockLocationId: 'location_1',
        toStockLocationId: 'location_1',
        units: 10,
        idempotencyKeyPrefix: 'transfer-1',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('refuses a branch that is not an active branch in the session organization', async () => {
    grant([allow('pharmacy:inventory')]);
    db.pharmacyBranch.findMany.mockResolvedValueOnce([]);
    await expect(
      caller().createLocation({
        branchId: 'branch_other',
        code: 'MAIN',
        name: 'Main store',
        kind: 'STORE',
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That record is not in this workspace.',
    });
    expect(db.pharmacyStockLocation.create).not.toHaveBeenCalled();
  });

  it('refuses every mutation when there is no tenant actor to attribute it to', async () => {
    await expect(
      caller({ userId: null }).createLocation({
        branchId: 'branch_a',
        code: 'MAIN',
        name: 'Main store',
        kind: 'STORE',
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(db.pharmacyStockLocation.create).not.toHaveBeenCalled();
  });
});

const LOCATION_ROW = {
  id: 'location_1',
  coldChain: false,
  minimumTemperatureC: null,
  maximumTemperatureC: null,
};

/** #355: every storage-zone, cold-chain and recall write goes through `can()`. */
const GATED_MUTATIONS = [
  {
    procedure: 'createLocation',
    capability: 'pharmacy:inventory',
    input: { branchId: 'branch_a', code: 'FRIDGE-1', name: 'Vaccine fridge', kind: 'FRIDGE' },
    writes: () => [db.pharmacyStockLocation.create],
  },
  {
    procedure: 'recordTemperature',
    capability: 'pharmacy:inventory',
    input: {
      branchId: 'branch_a',
      stockLocationId: 'location_1',
      temperatureC: 5,
      recordedAt: new Date('2026-10-22T08:00:00.000Z'),
    },
    writes: () => [db.pharmacyTemperatureLog.createMany],
  },
  {
    procedure: 'importTemperatureCsv',
    capability: 'pharmacy:inventory',
    input: {
      branchId: 'branch_a',
      stockLocationId: 'location_1',
      csv: 'recordedAt,temperatureC\n2026-10-22T08:00:00.000Z,5\n',
    },
    writes: () => [db.pharmacyTemperatureLog.createMany],
  },
  {
    procedure: 'configureTemperatureMonitoring',
    capability: 'pharmacy:inventory',
    input: {
      branchId: 'branch_a',
      stockLocationId: 'location_1',
      expectedTemperatureReadingIntervalMinutes: 30,
      temperatureExcursionDurationMinutes: 60,
    },
    writes: () => [db.pharmacyStockLocation.update],
  },
  {
    procedure: 'createRecall',
    capability: 'pharmacy:safety',
    input: { batchId: 'batch_1', reference: 'DRAP-R-1', reason: 'Contaminated lot' },
    writes: () => [db.pharmacyManufacturingBatch.updateMany, db.pharmacyRecallNotice.create],
  },
] as const;

describe.each(GATED_MUTATIONS)(
  '#355 — $procedure requires $capability',
  ({ procedure, capability, input, writes }) => {
    const run = () => caller()[procedure](input as never);

    beforeEach(() => {
      // The zone exists in the branch, so only the capability check can refuse.
      db.pharmacyStockLocation.findFirst.mockResolvedValue(LOCATION_ROW);
    });

    it('refuses a member without the capability before any read or write', async () => {
      grant([allow('pharmacy:counter'), allow('pharmacy:orders')]);
      await expect(run()).rejects.toMatchObject(CAPABILITY_REFUSAL);
      expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
      expect(db.pharmacyStockLocation.findFirst).not.toHaveBeenCalled();
      for (const write of writes()) expect(write).not.toHaveBeenCalled();
    });

    it('runs for the exact grant', async () => {
      grant([allow(capability)]);
      await run();
      for (const write of writes()) expect(write).toHaveBeenCalledTimes(1);
    });

    it('lets a user DENY override beat a role ALLOW', async () => {
      grant([allow(capability)], [deny(capability)]);
      await expect(run()).rejects.toMatchObject(CAPABILITY_REFUSAL);
      for (const write of writes()) expect(write).not.toHaveBeenCalled();
    });

    it('lets a role DENY beat a user ALLOW override', async () => {
      grant([deny(capability)], [allow(capability)]);
      await expect(run()).rejects.toMatchObject(CAPABILITY_REFUSAL);
      for (const write of writes()) expect(write).not.toHaveBeenCalled();
    });
  }
);

describe('#355 — remaining stock mutations require pharmacy:inventory', () => {
  it.each([
    [
      'registerBatch',
      {
        medicineId: 'medicine_1',
        batchNumber: 'B-1',
        printedExpiry: new Date('2027-06-15T00:00:00.000Z'),
        expiryPrecision: 'DAY',
      },
    ],
    [
      'allocateForSale',
      {
        branchId: 'branch_a',
        medicineId: 'medicine_1',
        requiredUnits: 1,
        idempotencyKeyPrefix: 'sale-1',
      },
    ],
    ['acknowledgeSignal', { branchId: 'branch_a', signalId: 'signal_1' }],
    [
      'draftExpiryMarkdown',
      {
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_1',
        markdownPercent: 10,
        reason: 'Near expiry',
      },
    ],
    [
      'receiveTransferWithVariance',
      {
        branchId: 'branch_a',
        transferId: 'transfer_1',
        lines: [{ lineId: 'line_1', receivedUnits: 1 }],
        idempotencyKeyPrefix: 'receive-1',
      },
    ],
  ] as const)('honours an explicit DENY for %s before handler access', async (procedure, input) => {
    grant([allow('pharmacy:inventory')], [deny('pharmacy:inventory')]);

    await expect(caller()[procedure](input as never)).rejects.toMatchObject(CAPABILITY_REFUSAL);
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    [
      'receiveLot',
      {
        branchId: 'branch_a',
        manufacturingBatchId: 'batch_1',
        packLevelId: 'pack_level_1',
        stockLocationId: 'location_1',
        unitsPerPack: 10,
        supplierName: 'Distributor Ltd',
        supplierInvoiceRef: 'INV-1',
        unitCostMinor: 1200,
        printedMrpMinor: 2000,
        printedExpiry: new Date('2027-06-15T00:00:00.000Z'),
        expiryPrecision: 'DAY',
        quantityUnits: 100,
        idempotencyKey: 'receipt-1',
      },
    ],
    [
      'receiveTransferLine',
      {
        branchId: 'branch_a',
        transferId: 'transfer_1',
        lineId: 'line_1',
        receivedUnits: 10,
        idempotencyKeyPrefix: 'transfer-receipt-1',
      },
    ],
    [
      'reserveSupplierClaim',
      {
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        reservedUnits: 10,
        returnBy: new Date('2026-11-22T00:00:00.000Z'),
      },
    ],
  ] as const)('refuses %s before resolving its branch', async (procedure, input) => {
    grant([allow('pharmacy:counter'), allow('pharmacy:orders')]);

    await expect(caller()[procedure](input as never)).rejects.toMatchObject(CAPABILITY_REFUSAL);
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
  });
});

describe('#355 — wildcard grants', () => {
  it.each(GATED_MUTATIONS.filter((gated) => gated.capability === 'pharmacy:inventory'))(
    'lets the Owner template (pharmacy:*) run $procedure',
    async ({ procedure, input, writes }) => {
      db.pharmacyStockLocation.findFirst.mockResolvedValue(LOCATION_ROW);
      grant([allow('pharmacy:*')]);
      await caller()[procedure](input as never);
      for (const write of writes()) expect(write).toHaveBeenCalledTimes(1);
    }
  );

  it('does not let pharmacy:* raise a recall: pharmacy:safety is an exact grant', async () => {
    grant([allow('pharmacy:*'), allow('pharmacy:inventory')]);
    await expect(
      caller().createRecall({
        batchId: 'batch_1',
        reference: 'DRAP-R-1',
        reason: 'Contaminated lot',
      })
    ).rejects.toMatchObject(CAPABILITY_REFUSAL);
    expect(db.pharmacyManufacturingBatch.updateMany).not.toHaveBeenCalled();
    expect(db.pharmacyRecallNotice.create).not.toHaveBeenCalled();
  });
});

describe('PUR-07 — the stock action centre transport', () => {
  it('gates the action centre behind the same pharmacy-inventory entitlement', () => {
    expect(moduleForProcedure('pharmacyInventory.refreshStockSignals')).toBe('pharmacy-inventory');
    expect(moduleForProcedure('pharmacyInventory.createDraftAction')).toBe('pharmacy-inventory');
  });

  it('records the SESSION actor as the safety-stock approver, never a payload field', async () => {
    grant([allow('pharmacy:inventory')]);
    db.medicine.findFirst.mockResolvedValue({ id: 'medicine_1' });
    await caller({ userId: 'user_pharmacist_in_charge' }).approveSafetyStock({
      branchId: 'branch_a',
      medicineId: 'medicine_1',
      safetyStockUnits: 120,
      coverageDays: 30,
    });
    expect(db.pharmacySafetyStock.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          organizationId: 'org_a',
          approvedByUserId: 'user_pharmacist_in_charge',
        }),
      })
    );
  });

  it('rejects a cross-tenant medicine ID when approving a safety stock', async () => {
    grant([allow('pharmacy:inventory')]);
    await expect(
      caller().approveSafetyStock({
        branchId: 'branch_a',
        medicineId: 'medicine_from_org_b',
        safetyStockUnits: 120,
        coverageDays: 30,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacySafetyStock.upsert).not.toHaveBeenCalled();
  });

  it('refuses a snooze or a dismissal with no reason (§8A invariant 29)', async () => {
    grant([allow('pharmacy:inventory')]);
    for (const call of [
      () =>
        caller().snoozeSignal({
          branchId: 'branch_a',
          signalId: 'signal_1',
          until: new Date('2026-09-10T00:00:00.000Z'),
          reason: '   ',
        }),
      () => caller().dismissSignal({ branchId: 'branch_a', signalId: 'signal_1', reason: '' }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(db.pharmacyStockSignal.update).not.toHaveBeenCalled();
  });

  it('has no draft-action shape that could name a purchase order or a movement', async () => {
    // §8A invariant 29 at the transport layer: the discriminated union admits
    // exactly three kinds, all of them drafts. A caller cannot smuggle a fourth.
    await expect(
      caller().createDraftAction({
        // @ts-expect-error — proving the schema rejects a non-draft action kind.
        kind: 'CREATE_PURCHASE_ORDER',
        branchId: 'branch_a',
        signalId: 'signal_1',
      })
    ).rejects.toBeDefined();
    expect(db.pharmacyStockSignalAction.create).not.toHaveBeenCalled();
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('refuses a draft action when there is no tenant actor to attribute it to', async () => {
    await expect(
      caller({ userId: null }).createDraftAction({
        kind: 'DRAFT_REQUISITION',
        branchId: 'branch_a',
        signalId: 'signal_1',
        reference: 'REQ-1',
        medicineId: 'medicine_1',
        packLevelId: 'pack_1',
        canonicalUnitsPerPack: 10,
        quantityPacks: 8,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(db.pharmacyRequisition.create).not.toHaveBeenCalled();
  });
});
