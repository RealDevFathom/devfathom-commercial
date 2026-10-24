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
  return { hasModule };
});
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
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

import { moduleForProcedure } from '@/lib/module-catalog';

import { pharmacyInventoryRouter } from './pharmacy-inventory';
import type { TRPCContext } from '../trpc';

function model() {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    findFirstOrThrow: vi.fn().mockRejectedValue(new Error('Test record not configured')),
    create: vi
      .fn()
      .mockImplementation(async ({ data }: { data: object }) => ({ id: 'new', ...data })),
    update: vi.fn(),
    count: vi.fn(),
  };
}

function makeDb() {
  const db = {
    user: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: { permissions: [] },
        permissionOverrides: [],
      }),
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
    pharmacyInterbranchTransferLine: model(),
    pharmacyPurchaseReturn: model(),
    pharmacyPurchaseReturnLine: model(),
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        (where.id?.in ?? []).map((id) => ({ id }))
      ),
    },
  };
  return Object.assign(db, {
    $transaction: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)),
    $queryRaw: vi.fn().mockResolvedValue([]),
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
        data: expect.objectContaining({ expiresAt: new Date('2027-07-01T00:00:00.000Z') }),
      })
    );
  });

  it('refuses to block a batch without a reason (INV-03 evidence)', async () => {
    db.user.findUnique.mockResolvedValue({
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

  it.each([
    ['setBatchState', { manufacturingBatchId: 'batch_1', state: 'ACTIVE' }],
    ['acknowledgeRecall', { branchId: 'branch_a', recallNoticeId: 'recall_1' }],
    ['closeRecall', { recallNoticeId: 'recall_1' }],
  ] as const)('requires pharmacy:safety for %s', async (procedure, input) => {
    await expect(caller()[procedure](input as never)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('allows an exact pharmacy:safety grant to acknowledge a recall', async () => {
    db.user.findUnique.mockResolvedValue({
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

/** #357 regression: real router + service + projection-checking in-memory ledger.
 * PostgreSQL trigger/RLS acceptance is separately exercised by the DB suite.
 */
describe('#357 partial transfer receipts', () => {
  function scenario(units = 10) {
    grant([allow('pharmacy:inventory')]);
    const transfer = {
      id: 'transfer_357',
      organizationId: 'org_a',
      fromBranchId: 'branch_source',
      toBranchId: 'branch_a',
      status: 'DISPATCHED',
      receivedAt: null as Date | null,
      lines: [
        {
          id: 'line_1',
          sourceLotId: 'lot_source',
          sourceStockLocationId: 'source_location',
          destinationStockLocationId: 'destination_location',
          quantityUnits: units,
          receivedUnits: 0,
        },
      ],
    };
    const transit = {
      onHandUnits: units,
      sealedPacks: Math.floor(units / 10),
      looseUnits: units % 10,
    };
    const destination = { onHandUnits: 0, sealedPacks: 0, looseUnits: 0 };
    type Movement = {
      id?: string;
      organizationId: string;
      branchId: string;
      kind: string;
      disposition: string;
      quantityUnits: number;
      sealedPackDelta: number;
      looseUnitDelta: number;
      idempotencyKey: string;
      transferId?: string;
      stockLocationId: string;
      note?: string;
    };
    const movements: Movement[] = [];
    db.pharmacyStockBalance.findFirst.mockImplementation(async () => structuredClone(transit));
    db.$queryRaw.mockImplementation(async (query: { strings: readonly string[] }) =>
      query.strings.join('').includes('pharmacy_stock_balances')
        ? [{ ...structuredClone(transit), unitsPerPack: 10 }]
        : [{ id: transfer.id }]
    );
    db.pharmacyInterbranchTransfer.findFirst.mockImplementation(async () =>
      structuredClone(transfer)
    );
    db.pharmacyInterbranchTransfer.update.mockImplementation(async ({ data }) => {
      Object.assign(transfer, data);
      return structuredClone(transfer);
    });
    db.pharmacyInterbranchTransferLine.update.mockImplementation(async ({ data }) => {
      transfer.lines[0].receivedUnits += (
        data as { receivedUnits: { increment: number } }
      ).receivedUnits.increment;
      return structuredClone(transfer.lines[0]);
    });
    db.pharmacyInventoryLot.findFirstOrThrow.mockResolvedValue({
      id: 'lot_source',
      manufacturingBatchId: 'batch_1',
      packLevelId: 'pack_1',
      unitsPerPack: 10,
      supplierName: 'Supplier',
      supplierInvoiceRef: 'invoice',
      unitCostMinor: 100,
      printedMrpMinor: 150,
      receivedExpiresAt: new Date('2027-01-01'),
      receivedExpiryPrecision: 'DAY',
      batch: {},
    });
    db.pharmacyStockMovement.findFirst.mockImplementation(
      async ({ where }) =>
        movements.find(
          (m) =>
            m.organizationId === where.organizationId &&
            m.branchId === where.branchId &&
            m.idempotencyKey === where.idempotencyKey &&
            m.kind === where.kind
        ) ?? null
    );
    db.pharmacyStockMovement.findMany.mockImplementation(async ({ where }) =>
      movements.filter(
        (m) =>
          m.organizationId === where.organizationId &&
          m.branchId === where.branchId &&
          m.transferId === where.transferId &&
          m.kind === where.kind &&
          m.idempotencyKey.startsWith(where.idempotencyKey.startsWith)
      )
    );
    db.pharmacyStockMovement.create.mockImplementation(async ({ data }: { data: object }) => {
      const m = data as Movement;
      if (
        movements.some(
          (old) => old.branchId === m.branchId && old.idempotencyKey === m.idempotencyKey
        )
      )
        throw new Error('duplicate movement key');
      const bucket = m.disposition === 'IN_TRANSIT' ? transit : destination;
      const next = {
        onHandUnits: bucket.onHandUnits + m.quantityUnits,
        sealedPacks: bucket.sealedPacks + m.sealedPackDelta,
        looseUnits: bucket.looseUnits + m.looseUnitDelta,
      };
      if (
        Object.values(next).some((n) => n < 0) ||
        next.onHandUnits !== next.sealedPacks * 10 + next.looseUnits
      )
        throw new Error('INVALID_ARRANGEMENT');
      Object.assign(bucket, next);
      movements.push(m);
      return { id: `m_${movements.length}`, ...m };
    });
    const receive = (receivedUnits: number, key = 'receipt-1') =>
      caller().receiveTransferWithVariance({
        branchId: 'branch_a',
        transferId: transfer.id,
        lines: [{ lineId: 'line_1', receivedUnits }],
        idempotencyKeyPrefix: key,
      });
    return { transfer, transit, destination, movements, receive };
  }

  it('opens sealed10, receives4, leaves6 in transit, then finishes6 with a new receipt key', async () => {
    const s = scenario();
    const first = await s.receive(4);
    expect(first.transfer).toMatchObject({ status: 'PARTIALLY_RECEIVED', receivedAt: null });
    expect(first.variances).toEqual([]);
    expect(s.transit).toEqual({ onHandUnits: 6, sealedPacks: 0, looseUnits: 6 });
    expect(s.destination.onHandUnits).toBe(4);
    expect(s.movements.map((m) => m.kind)).toEqual(['BREAK_PACK', 'TRANSFER_OUT', 'TRANSFER_IN']);
    const second = await s.receive(6, 'receipt-2');
    expect(second.transfer).toMatchObject({ status: 'RECEIVED', receivedAt: expect.any(Date) });
    expect(s.transfer.lines[0].receivedUnits).toBe(10);
    expect(s.transit.onHandUnits).toBe(0);
    expect(s.destination.onHandUnits).toBe(10);
    expect(s.movements).toHaveLength(5);
    expect(s.movements.some((m) => m.kind === 'WRITE_OFF')).toBe(false);
  });

  it('is exactly-once on first receipt retry and retry after final completion', async () => {
    const s = scenario();
    await s.receive(4);
    await s.receive(4);
    expect(s.movements).toHaveLength(3);
    await s.receive(6, 'receipt-2');
    await s.receive(6, 'receipt-2');
    await s.receive(4);
    expect(s.movements).toHaveLength(5);
    expect(s.destination.onHandUnits).toBe(10);
    expect(s.transfer.lines[0].receivedUnits).toBe(10);
  });

  it('rejects changed quantity on a consumed receipt key without writes', async () => {
    const s = scenario();
    await s.receive(4);
    await expect(s.receive(3)).rejects.toMatchObject({ message: 'INVALID_STATE' });
    expect(s.movements).toHaveLength(3);
  });

  it('rejects cumulative over-receipt before any additional movement', async () => {
    const s = scenario();
    await s.receive(4);
    await expect(s.receive(7, 'receipt-2')).rejects.toMatchObject({ message: 'INVALID_UNITS' });
    expect(s.movements).toHaveLength(3);
    expect(s.transit.onHandUnits).toBe(6);
  });

  it('receives an intact whole pack without an unnecessary break', async () => {
    const s = scenario();
    await s.receive(10);
    expect(s.movements.map((m) => m.kind)).toEqual(['TRANSFER_OUT', 'TRANSFER_IN']);
    expect(s.destination).toEqual({ onHandUnits: 10, sealedPacks: 1, looseUnits: 0 });
  });

  it('conserves a mixed whole/fractional receipt14 out of sealed20', async () => {
    const s = scenario(20);
    await s.receive(14);
    expect(s.transit).toEqual({ onHandUnits: 6, sealedPacks: 0, looseUnits: 6 });
    expect(s.destination).toEqual({ onHandUnits: 14, sealedPacks: 1, looseUnits: 4 });
  });

  it('keeps the legacy single-line endpoint partial rather than EXCEPTION', async () => {
    const s = scenario();
    await caller().receiveTransferLine({
      branchId: 'branch_a',
      transferId: s.transfer.id,
      lineId: 'line_1',
      receivedUnits: 4,
      idempotencyKeyPrefix: 'legacy-1',
    });
    expect(s.transfer.status).toBe('PARTIALLY_RECEIVED');
    await caller().receiveTransferLine({
      branchId: 'branch_a',
      transferId: s.transfer.id,
      lineId: 'line_1',
      receivedUnits: 6,
      idempotencyKeyPrefix: 'legacy-2',
    });
    expect(s.transfer.status).toBe('RECEIVED');
  });

  it('preserves witnessed permanent-shortfall write-off with a valid arrangement', async () => {
    const s = scenario();
    db.user.findFirst.mockResolvedValue({ id: 'witness' });
    const result = await caller().receiveTransferWithVariance({
      branchId: 'branch_a',
      transferId: s.transfer.id,
      lines: [{ lineId: 'line_1', receivedUnits: 4 }],
      idempotencyKeyPrefix: 'variance-1',
      variance: {
        reason: 'Missing carton confirmed by courier',
        witnessId: 'witness',
        evidenceRef: 'courier:1',
      },
    });
    expect(result.transfer.status).toBe('RECEIVED');
    expect(s.movements.map((m) => m.kind)).toEqual([
      'BREAK_PACK',
      'TRANSFER_OUT',
      'TRANSFER_IN',
      'WRITE_OFF',
    ]);
    expect(s.transit.onHandUnits).toBe(0);
    expect(s.destination.onHandUnits).toBe(4);
    expect(s.movements.find((m) => m.kind === 'WRITE_OFF')).toMatchObject({
      quantityUnits: -6,
      disposition: 'IN_TRANSIT',
      looseUnitDelta: -6,
    });
    expect(Math.abs(s.movements.find((m) => m.kind === 'WRITE_OFF')!.sealedPackDelta)).toBe(0);
  });

  it('requires a distinct active witness before closing a permanent shortfall', async () => {
    const s = scenario();
    await expect(
      caller().receiveTransferWithVariance({
        branchId: 'branch_a',
        transferId: s.transfer.id,
        lines: [{ lineId: 'line_1', receivedUnits: 4 }],
        idempotencyKeyPrefix: 'bad-witness',
        variance: {
          reason: 'Missing carton confirmed',
          witnessId: 'user_a',
          evidenceRef: 'courier:2',
        },
      })
    ).rejects.toMatchObject({ message: 'COAUTH_REQUIRED' });
    expect(s.movements).toHaveLength(0);
  });

  it('refuses a foreign destination branch before touching its stock', async () => {
    const s = scenario();
    s.transfer.toBranchId = 'foreign_branch';
    await expect(s.receive(4)).rejects.toMatchObject({ message: 'CROSS_BRANCH_REFERENCE' });
    expect(s.movements).toHaveLength(0);
  });

  it('refuses an unknown line rather than implicitly closing the transfer', async () => {
    const s = scenario();
    await expect(
      caller().receiveTransferWithVariance({
        branchId: 'branch_a',
        transferId: s.transfer.id,
        lines: [{ lineId: 'foreign_line', receivedUnits: 4 }],
        idempotencyKeyPrefix: 'bad-line',
      })
    ).rejects.toMatchObject({ message: 'CROSS_BRANCH_REFERENCE' });
    expect(s.movements).toHaveLength(0);
  });
});
