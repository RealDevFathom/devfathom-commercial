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
import type { PharmacyStockMovement } from '@/generated/prisma/client';

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
    updateMany: vi.fn(),
    count: vi.fn(),
  };
}

function makeDb() {
  const db = {
    user: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue({
        organizationId: 'org_a',
        status: 'ACTIVE',
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
    pharmacySupplier: model(),
    pharmacySupplierClaim: model(),
    pharmacyStockMovement: model(),
    pharmacyCustodyRecord: model(),
    pharmacyStockBalance: model(),
    pharmacyRecallQuarantineAction: {
      findMany: vi.fn().mockResolvedValue([]),
    },
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
    pharmacyBranchAssignment: model(),
    pharmacyBranch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'branch_a' }),
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
function caller(
  overrides: {
    enabledModules?: string[];
    userId?: string | null;
    role?: 'ADMIN' | 'EMPLOYEE' | 'HR';
    userOrganizationId?: string;
  } = {}
) {
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
            user: {
              id: overrides.userId ?? 'user_a',
              role: overrides.role ?? 'ADMIN',
              status: 'ACTIVE',
              organizationId: overrides.userOrganizationId ?? 'org_a',
            },
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
    organizationId: 'org_a',
    status: 'ACTIVE',
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
    db.user.findFirst.mockResolvedValue({ id: 'user_b' });
    const occurredAt = new Date('2026-10-29T00:02:07.000Z');
    db.user.findFirst.mockResolvedValue({ id: 'user_b' });
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

describe('PH-A5 expiry recovery integration', () => {
  function position(id: string, expiresAt: Date, unitCostMinor = 2_500) {
    return {
      inventoryLotId: id,
      stockLocationId: 'location_1',
      onHandUnits: 10,
      location: { name: 'Main shelf' },
      lot: {
        supplierName: 'Fallback name',
        unitsPerPack: 10,
        unitCostMinor,
        printedMrpMinor: 5_000,
        batch: {
          batchNumber: 'B-1',
          expiresAt,
          state: 'ACTIVE',
          medicine: {
            productName: 'OTC medicine',
            brandName: null,
            rx: false,
            otc: true,
            restricted: false,
            controlled: false,
            productFamily: 'PHARMACEUTICAL',
          },
        },
        receiptLines: [{ goodsReceipt: { supplierId: 'supplier_1' } }],
      },
    };
  }

  it('uses the active branch relationship and returns risk/calendar facts', async () => {
    grant([allow('pharmacy:inventory')]);
    const expiresAt = new Date(Date.now() + 45 * 86_400_000);
    db.pharmacyStockBalance.findMany.mockResolvedValueOnce([position('lot_1', expiresAt)]);
    db.pharmacySupplier.findMany.mockResolvedValue([
      {
        id: 'supplier_1',
        name: 'Branch distributor',
        relationships: [{ expiryReturnWindowDays: 30 }],
      },
    ]);

    const board = await caller().expiryBoardLots({ branchId: 'branch_a', withinDays: 60 });

    expect(db.pharmacySupplier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          relationships: expect.objectContaining({
            where: { branchId: 'branch_a', active: true },
          }),
        }),
      })
    );
    expect(board.riskBuckets).toEqual([
      { days: 30, valueAtRiskMinor: 0 },
      { days: 60, valueAtRiskMinor: 25_000 },
      { days: 90, valueAtRiskMinor: 25_000 },
    ]);
    expect(board.rows[0]).toMatchObject({
      suggestedSupplierId: 'supplier_1',
      markdownEligible: true,
      returnDeadlineAt: expiresAt,
    });
    expect(board.rows[0]?.returnWindowOpensAt?.toISOString()).toBe(
      new Date(expiresAt.getTime() - 30 * 86_400_000).toISOString()
    );
  });

  it.each([30, 60, 90, 180] as const)(
    'keeps cumulative risk independent of the %s-day list filter and excludes expired stock',
    async (withinDays) => {
      const now = Date.now();
      const day = 86_400_000;
      const positions = [
        position('expired', new Date(now - day)),
        position('just_expired', new Date(now - 3_600_000)),
        position('lot_20', new Date(now + 20 * day), 12_500),
        position('lot_45', new Date(now + 45 * day), 7_500),
        position('lot_80', new Date(now + 80 * day), 5_000),
        position('lot_120', new Date(now + 120 * day), 10_000),
      ];
      db.pharmacyStockBalance.findMany.mockResolvedValueOnce(
        positions.filter(
          (row) => row.lot.batch.expiresAt.getTime() <= now + Math.max(withinDays, 90) * day
        )
      );

      const board = await caller().expiryBoardLots({ branchId: 'branch_a', withinDays });

      expect(db.pharmacyStockBalance.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: 'org_a',
            branchId: 'branch_a',
            lot: {
              batch: {
                expiresAt: {
                  lte: new Date(board.generatedAt.getTime() + Math.max(withinDays, 90) * day),
                },
              },
            },
          }),
        })
      );
      expect(board.riskBuckets).toEqual([
        { days: 30, valueAtRiskMinor: 125_000 },
        { days: 60, valueAtRiskMinor: 200_000 },
        { days: 90, valueAtRiskMinor: 250_000 },
      ]);
      expect(board.rows.map((row) => row.inventoryLotId)).toEqual(
        positions
          .filter((row) => row.lot.batch.expiresAt.getTime() <= now + withinDays * day)
          .map((row) => row.inventoryLotId)
      );
    }
  );

  it.each([
    ['Rx', { rx: true, restricted: false, controlled: false }],
    ['restricted', { rx: false, restricted: true, controlled: false }],
    ['controlled', { rx: false, restricted: false, controlled: true }],
  ])(
    'rejects a mark-down mutation for %s medicine before recording an event',
    async (_kind, flags) => {
      grant([allow('pharmacy:inventory')]);
      db.pharmacyInventoryLot.findFirst.mockResolvedValue({
        printedMrpMinor: 5_000,
        batch: {
          expiresAt: new Date(Date.now() + 30 * 86_400_000),
          state: 'ACTIVE',
          medicineId: 'medicine_1',
          medicine: { ...flags, otc: true, productFamily: 'PHARMACEUTICAL' },
        },
      });

      await expect(
        caller().draftExpiryMarkdown({
          branchId: 'branch_a',
          inventoryLotId: 'lot_1',
          stockLocationId: 'location_1',
          markdownPercent: 20,
          reason: 'Near expiry',
        })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Mark-down suggestions are limited to OTC and non-drug stock.',
      });
      expect(db.pharmacyStockSignalEvent.create).not.toHaveBeenCalled();
    }
  );
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

  it('normalises a MONTH-precision expiry to Karachi midnight after the month', async () => {
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
    db.user.findFirst.mockResolvedValue({ id: 'witness_a' });
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

  it('refuses quarantine for an inventory-only caller before any stock access', async () => {
    grant([allow('pharmacy:inventory')]);

    await expect(
      caller().quarantinePart({
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_1',
        units: 10,
        reason: 'Suspected contamination',
        idempotencyKeyPrefix: 'quarantine-1',
      })
    ).rejects.toMatchObject(CAPABILITY_REFUSAL);

    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
    expect(db.pharmacyInventoryLot.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyStockBalance.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('runs quarantine through the real router with exact pharmacy:safety authority', async () => {
    // The explicit inventory DENY makes this a regression test for the procedure
    // declaration itself: changing quarantinePart back to inventoryControl must
    // stop the call before its transaction and movement writes.
    grant([allow('pharmacy:safety'), deny('pharmacy:inventory')]);
    db.pharmacyInventoryLot.findFirst.mockResolvedValue({
      id: 'lot_1',
      unitsPerPack: 10,
    });
    db.pharmacyStockBalance.findFirst.mockResolvedValue({
      onHandUnits: 20,
      sealedPacks: 2,
      looseUnits: 0,
    });

    await caller().quarantinePart({
      branchId: 'branch_a',
      inventoryLotId: 'lot_1',
      stockLocationId: 'location_1',
      units: 10,
      reason: 'Suspected contamination',
      idempotencyKeyPrefix: 'quarantine-1',
    });

    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(db.pharmacyStockMovement.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 'org_a',
          branchId: 'branch_a',
          disposition: 'AVAILABLE',
          quantityUnits: -10,
          idempotencyKey: 'quarantine-1:out',
        }),
      })
    );
    expect(db.pharmacyStockMovement.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 'org_a',
          branchId: 'branch_a',
          disposition: 'QUARANTINE',
          quantityUnits: 10,
          idempotencyKey: 'quarantine-1:in',
        }),
      })
    );
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
      organizationRole: {
        permissions: [{ capability: 'pharmacy:safety', effect: 'ALLOW' }],
      },
      permissionOverrides: [],
    });
    db.$queryRaw.mockResolvedValueOnce([{ id: 'recall_1' }] as never);
    db.pharmacyRecallNotice.findFirst.mockResolvedValue({
      id: 'recall_1',
      batchId: 'batch_1',
      medicineId: null,
    });
    db.pharmacyInventoryLot.findFirst.mockResolvedValue({ id: 'lot_1' });

    await caller().acknowledgeRecall({ branchId: 'branch_a', recallNoticeId: 'recall_1' });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
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
      if (procedure === 'createRecall') {
        db.$queryRaw.mockResolvedValueOnce([]);
        db.$queryRaw.mockResolvedValueOnce([{ id: 'batch_1', medicineId: 'medicine_1' }] as never);
      }
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

describe('manual quarantine resolution authorization', () => {
  const input = {
    branchId: 'branch_a',
    inventoryLotId: 'lot_1',
    stockLocationId: 'location_1',
    units: 10,
    reason: 'Inspection passed',
    idempotencyKeyPrefix: 'release-1',
  };

  beforeEach(() => {
    grant([allow('pharmacy:inventory')]);
    db.pharmacyInventoryLot.findFirst.mockResolvedValue({ id: 'lot_1', unitsPerPack: 10 });
    db.pharmacyStockBalance.findFirst.mockResolvedValue({
      onHandUnits: 20,
      sealedPacks: 2,
      looseUnits: 0,
    });
  });

  it('lets an inventory-only actor release a manual hold with session attribution', async () => {
    await caller().releaseQuarantinedPart(input);
    expect(db.pharmacyStockMovement.create).toHaveBeenCalledTimes(2);
    expect(db.pharmacyStockMovement.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        organizationId: 'org_a',
        branchId: 'branch_a',
        actorId: 'user_a',
        disposition: 'AVAILABLE',
        quantityUnits: 10,
        reason: 'Inspection passed',
      }),
    });
    expect(db.pharmacyRecallQuarantineAction.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_a',
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_1',
        reversedAt: null,
      },
      select: { quantityUnits: true, heldMovementId: true },
    });
  });

  it.each(['release', 'write-off'])(
    'refuses regulatory stock through inventory-only %s before posting movements',
    async (operation) => {
      db.pharmacyRecallQuarantineAction.findMany.mockResolvedValue([
        { quantityUnits: 20, heldMovementId: 'recall-held-1' },
      ]);
      const result =
        operation === 'release'
          ? caller().releaseQuarantinedPart(input)
          : caller().writeOff({
              branchId: input.branchId,
              inventoryLotId: input.inventoryLotId,
              stockLocationId: input.stockLocationId,
              units: input.units,
              reason: input.reason,
              disposition: 'QUARANTINE',
              witnessId: 'witness',
              evidenceRef: 'certificate',
              idempotencyKey: 'write-off-1',
            });
      await expect(result).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'INSUFFICIENT_STOCK',
      });
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
      expect(db.pharmacyCustodyRecord.create).not.toHaveBeenCalled();
    }
  );

  it('still requires safety authority for the regulatory reversal', async () => {
    await expect(
      caller().reverseDrapRecall({ recallNoticeId: 'recall_1', reason: 'Cleared' })
    ).rejects.toMatchObject(CAPABILITY_REFUSAL);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an out-of-tenant branch before looking up stock', async () => {
    db.pharmacyBranch.findMany.mockResolvedValue([]);
    await expect(caller().releaseQuarantinedPart(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That record is not in this workspace.',
    });
    expect(db.pharmacyInventoryLot.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });
});

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
    [
      'quarantinePart',
      {
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_1',
        units: 1,
        reason: 'Manual safety hold',
        idempotencyKeyPrefix: 'hold-1',
      },
    ],
    [
      'releaseQuarantinedPart',
      {
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_1',
        units: 1,
        reason: 'Inspection passed',
        idempotencyKeyPrefix: 'release-1',
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
    db.user.findFirst.mockResolvedValue({ organizationId: 'org_a', status: 'ACTIVE' });
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
    type Movement = Pick<
      PharmacyStockMovement,
      | 'organizationId'
      | 'branchId'
      | 'kind'
      | 'disposition'
      | 'quantityUnits'
      | 'sealedPackDelta'
      | 'looseUnitDelta'
      | 'idempotencyKey'
      | 'stockLocationId'
      | 'reason'
    > & { id?: string };
    const movements: Movement[] = [];
    const custodyRecords: Array<{
      id: string;
      movementId: string;
      witnessId: string;
      reason: string;
      evidenceRef: string;
    }> = [];
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
    db.pharmacyInterbranchTransferLine.updateMany = vi.fn(async ({ data }) => {
      transfer.lines[0].receivedUnits += (
        data as { receivedUnits: { increment: number } }
      ).receivedUnits.increment;
      return { count: 1 };
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
      movements.filter((m) => {
        if (m.organizationId !== where.organizationId || m.kind !== where.kind) return false;
        if (where.branchId !== undefined && m.branchId !== where.branchId) return false;
        if (where.reason?.in && !where.reason.in.includes(m.reason)) return false;
        if (
          where.idempotencyKey?.startsWith &&
          !m.idempotencyKey.startsWith(where.idempotencyKey.startsWith)
        )
          return false;
        if (where.idempotencyKey?.in && !where.idempotencyKey.in.includes(m.idempotencyKey))
          return false;
        return true;
      })
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
      const created = { id: `m_${movements.length + 1}`, ...m };
      movements.push(created);
      return created;
    });
    db.pharmacyCustodyRecord.create.mockImplementation(async ({ data }) => {
      const created = {
        id: `c_${custodyRecords.length + 1}`,
        ...data,
      } as (typeof custodyRecords)[number];
      custodyRecords.push(created);
      return created;
    });
    db.pharmacyCustodyRecord.findMany.mockImplementation(async ({ where }) =>
      custodyRecords.filter((record) => where.movementId.in.includes(record.movementId))
    );
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

  it('never reseals a pack-sized quantity taken from loose transit stock', async () => {
    const s = scenario(20);
    Object.assign(s.transit, { sealedPacks: 0, looseUnits: 20 });
    await s.receive(10);
    expect(s.transit).toEqual({ onHandUnits: 10, sealedPacks: 0, looseUnits: 10 });
    expect(s.destination).toEqual({ onHandUnits: 10, sealedPacks: 0, looseUnits: 10 });
    expect(s.movements.map((m) => m.kind)).toEqual(['TRANSFER_OUT', 'TRANSFER_IN']);
  });

  it('conserves a mixed whole/fractional receipt14 out of sealed20', async () => {
    const s = scenario(20);
    await s.receive(14);
    expect(s.transit).toEqual({ onHandUnits: 6, sealedPacks: 0, looseUnits: 6 });
    expect(s.destination).toEqual({ onHandUnits: 14, sealedPacks: 1, looseUnits: 4 });
  });

  it.each(['receiveTransferLine', 'receiveTransferWithVariance'] as const)(
    '%s preserves the physical arrangement across deliveries of 4, 10 and 6',
    async (procedure) => {
      const s = scenario(20);
      for (const [index, units] of [4, 10, 6].entries()) {
        const common = {
          branchId: 'branch_a',
          transferId: s.transfer.id,
          idempotencyKeyPrefix: `arrangement-${index}`,
        };
        if (procedure === 'receiveTransferLine') {
          await caller().receiveTransferLine({ ...common, lineId: 'line_1', receivedUnits: units });
        } else {
          await caller().receiveTransferWithVariance({
            ...common,
            lines: [{ lineId: 'line_1', receivedUnits: units }],
          });
        }
        const outgoing = s.movements.find(
          (m) =>
            m.idempotencyKey.startsWith(common.idempotencyKeyPrefix) && m.kind === 'TRANSFER_OUT'
        )!;
        const incoming = s.movements.find(
          (m) =>
            m.idempotencyKey.startsWith(common.idempotencyKeyPrefix) && m.kind === 'TRANSFER_IN'
        )!;
        expect(incoming.sealedPackDelta + outgoing.sealedPackDelta).toBe(0);
        expect(incoming.looseUnitDelta + outgoing.looseUnitDelta).toBe(0);
        if (index === 1) {
          expect(incoming).toMatchObject({ sealedPackDelta: 1, looseUnitDelta: 0 });
          expect(s.transit).toEqual({ onHandUnits: 6, sealedPacks: 0, looseUnits: 6 });
        }
      }
      expect(s.movements.filter((m) => m.kind === 'BREAK_PACK')).toHaveLength(1);
      expect(s.destination).toEqual({ onHandUnits: 20, sealedPacks: 1, looseUnits: 10 });
      expect(s.transit).toEqual({ onHandUnits: 0, sealedPacks: 0, looseUnits: 0 });
      expect(s.transfer.status).toBe('RECEIVED');
    }
  );

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
    db.user.findFirst.mockImplementation(async ({ where }) =>
      where.id === 'witness'
        ? { id: 'witness' }
        : { id: where.id, organizationId: 'org_a', status: 'ACTIVE' }
    );
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

  it('replays an identical variance receipt, including a variance-only receipt', async () => {
    const s = scenario();
    db.user.findFirst.mockImplementation(async ({ where }) =>
      where.id === 'witness'
        ? { id: 'witness' }
        : { id: where.id, organizationId: 'org_a', status: 'ACTIVE' }
    );
    const input = {
      branchId: 'branch_a',
      transferId: s.transfer.id,
      lines: [{ lineId: 'line_1', receivedUnits: 0 }],
      idempotencyKeyPrefix: 'variance-only',
      variance: {
        reason: 'Entire carton missing',
        witnessId: 'witness',
        evidenceRef: 'courier:missing',
      },
    };
    const first = await caller().receiveTransferWithVariance(input);
    const replay = await caller().receiveTransferWithVariance(input);
    expect(replay).toEqual(first);
    expect(s.movements.filter((movement) => movement.kind === 'WRITE_OFF')).toHaveLength(1);
    expect(s.transit.onHandUnits).toBe(0);
  });

  it('rejects changed variance evidence on a consumed receipt key', async () => {
    const s = scenario();
    db.user.findFirst.mockImplementation(async ({ where }) =>
      where.id === 'witness'
        ? { id: 'witness' }
        : { id: where.id, organizationId: 'org_a', status: 'ACTIVE' }
    );
    const input = {
      branchId: 'branch_a',
      transferId: s.transfer.id,
      lines: [{ lineId: 'line_1', receivedUnits: 0 }],
      idempotencyKeyPrefix: 'variance-only',
      variance: {
        reason: 'Entire carton missing',
        witnessId: 'witness',
        evidenceRef: 'courier:missing',
      },
    };
    await caller().receiveTransferWithVariance(input);
    await expect(
      caller().receiveTransferWithVariance({
        ...input,
        variance: { ...input.variance, evidenceRef: 'courier:changed' },
      })
    ).rejects.toMatchObject({ message: 'INVALID_STATE' });
    expect(s.movements.filter((movement) => movement.kind === 'WRITE_OFF')).toHaveLength(1);
  });

  it('gives receipt and variance pack openings distinct keys in a pooled transit balance', async () => {
    const s = scenario(16);
    // Transfer T owns16, another same-lot dispatched transfer owns7 units.
    // Receipt8 and writeoff8 each need their own physical pack opening.
    Object.assign(s.transit, { onHandUnits: 23, sealedPacks: 2, looseUnits: 3 });
    db.user.findFirst.mockImplementation(async ({ where }) =>
      where.id === 'witness'
        ? { id: 'witness' }
        : { id: where.id, organizationId: 'org_a', status: 'ACTIVE' }
    );
    const result = await caller().receiveTransferWithVariance({
      branchId: 'branch_a',
      transferId: s.transfer.id,
      lines: [{ lineId: 'line_1', receivedUnits: 8 }],
      idempotencyKeyPrefix: 'pooled-variance',
      variance: {
        reason: 'Confirmed permanent shortfall',
        witnessId: 'witness',
        evidenceRef: 'courier:pooled',
      },
    });
    expect(result.transfer.status).toBe('RECEIVED');
    const openings = s.movements.filter((m) => m.kind === 'BREAK_PACK');
    expect(openings).toHaveLength(2);
    expect(new Set(openings.map((m) => m.idempotencyKey)).size).toBe(2);
    expect(s.transit).toEqual({ onHandUnits: 7, sealedPacks: 0, looseUnits: 7 });
    expect(s.destination.onHandUnits).toBe(8);
    expect(s.movements.find((m) => m.kind === 'WRITE_OFF')?.quantityUnits).toBe(-8);
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

  it.each([
    { name: 'no capability', role: [] as Rule[], overrides: [] as Rule[] },
    { name: 'safety capability alone', role: [allow('pharmacy:safety')], overrides: [] as Rule[] },
    {
      name: 'explicit inventory denial',
      role: [allow('pharmacy:inventory')],
      overrides: [deny('pharmacy:inventory')],
    },
  ])(
    'refuses a partial receipt with $name before locking or posting',
    async ({ role, overrides }) => {
      const s = scenario();
      grant(role, overrides);
      await expect(s.receive(4)).rejects.toMatchObject(CAPABILITY_REFUSAL);
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(s.movements).toHaveLength(0);
      expect(s.transit.onHandUnits).toBe(10);
    }
  );

  it('refuses a transfer from another tenant without creating a destination lot', async () => {
    const s = scenario();
    s.transfer.organizationId = 'org_b';
    await expect(s.receive(4)).rejects.toMatchObject({ message: 'CROSS_BRANCH_REFERENCE' });
    expect(db.pharmacyInventoryLot.create).not.toHaveBeenCalled();
    expect(s.movements).toHaveLength(0);
  });

  const receiptProcedures = ['receiveTransferLine', 'receiveTransferWithVariance'] as const;
  function branchReceiptInput(procedure: (typeof receiptProcedures)[number], transferId: string) {
    const common = { branchId: 'branch_b', transferId, idempotencyKeyPrefix: 'branch-receipt-357' };
    return procedure === 'receiveTransferLine'
      ? { ...common, lineId: 'line_1', receivedUnits: 4 }
      : { ...common, lines: [{ lineId: 'line_1', receivedUnits: 4 }] };
  }
  function expectNoReceiptEffects(s: ReturnType<typeof scenario>) {
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
    for (const model of [
      db.pharmacyInventoryLot,
      db.pharmacyStockMovement,
      db.pharmacyStockBalance,
      db.pharmacyStockDiscrepancy,
      db.pharmacyInterbranchTransferLine,
      db.pharmacyInterbranchTransfer,
    ]) {
      expect(model.create).not.toHaveBeenCalled();
      expect(model.update).not.toHaveBeenCalled();
    }
    expect(s.movements).toEqual([]);
    expect(s.transit).toEqual({ onHandUnits: 10, sealedPacks: 1, looseUnits: 0 });
    expect(s.destination).toEqual({ onHandUnits: 0, sealedPacks: 0, looseUnits: 0 });
    expect(s.transfer).toMatchObject({
      status: 'DISPATCHED',
      receivedAt: null,
      lines: [{ id: 'line_1', quantityUnits: 10, receivedUnits: 0 }],
    });
  }

  describe.each(receiptProcedures)(
    '%s SEC-384-01 canonical receipt branch authority',
    (procedure) => {
      const nonAdminRoles = [
        { role: 'EMPLOYEE' as const, name: 'org:admin' },
        { role: 'EMPLOYEE' as const, name: 'org:superadmin' },
        { role: 'HR' as const, name: 'stock-clerk' },
      ];
      const unassignedActors = nonAdminRoles.flatMap((actor) => [
        { ...actor, assignment: 'none', branches: [] as { branchId: string }[] },
        { ...actor, assignment: 'sibling only', branches: [{ branchId: 'branch_a' }] },
      ]);

      it.each(unassignedActors)(
        'refuses $role / display name $name / $assignment with no stock effects',
        async ({ role, name, branches }) => {
          const s = scenario();
          s.transfer.toBranchId = 'branch_b';
          // The role KEY is nonprivileged. Display names are editable, not admin grants.
          db.user.findUnique.mockResolvedValue({
            organizationId: 'org_a',
            status: 'ACTIVE',
            organizationRole: {
              key: 'stock-clerk',
              name,
              permissions: [allow('pharmacy:inventory')],
            },
            permissionOverrides: [],
          });
          db.pharmacyBranchAssignment.findMany.mockResolvedValue(branches);
          await expect(
            caller({ role })[procedure](branchReceiptInput(procedure, s.transfer.id) as never)
          ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
          expectNoReceiptEffects(s);
        }
      );

      it.each(nonAdminRoles)(
        'allows $role / display name $name only with the active destination assignment',
        async ({ role, name }) => {
          const s = scenario();
          s.transfer.toBranchId = 'branch_b';
          db.user.findUnique.mockResolvedValue({
            organizationId: 'org_a',
            status: 'ACTIVE',
            organizationRole: {
              key: 'stock-clerk',
              name,
              permissions: [allow('pharmacy:inventory')],
            },
            permissionOverrides: [],
          });
          db.pharmacyBranchAssignment.findMany.mockResolvedValue([{ branchId: 'branch_b' }]);
          await caller({ role })[procedure](branchReceiptInput(procedure, s.transfer.id) as never);
          expect(s.transit.onHandUnits).toBe(6);
          expect(s.destination.onHandUnits).toBe(4);
          expect(db.pharmacyBranchAssignment.findMany).toHaveBeenCalledWith({
            where: {
              organizationId: 'org_a',
              userId: 'user_a',
              active: true,
              branch: { organizationId: 'org_a', active: true },
            },
            select: { branchId: true },
          });
        }
      );

      it.each([
        { member: 'missing', value: null },
        { member: 'foreign', value: { organizationId: 'org_b', status: 'ACTIVE' } },
        { member: 'inactive', value: { organizationId: 'org_a', status: 'SUSPENDED' } },
      ])(
        'refuses even session ADMIN with $member persisted membership before stock effects',
        async ({ value }) => {
          const s = scenario();
          s.transfer.toBranchId = 'branch_b';
          // Capability lookup remains granted; the second lookup is persisted membership.
          db.user.findFirst.mockResolvedValue(value);
          await expect(
            caller({ role: 'ADMIN' })[procedure](
              branchReceiptInput(procedure, s.transfer.id) as never
            )
          ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
          expectNoReceiptEffects(s);
        }
      );

      it('refuses an inactive or foreign destination even for session ADMIN before stock effects', async () => {
        const s = scenario();
        s.transfer.toBranchId = 'branch_b';
        db.pharmacyBranch.findMany.mockResolvedValue([]);
        await expect(
          caller({ role: 'ADMIN' })[procedure](
            branchReceiptInput(procedure, s.transfer.id) as never
          )
        ).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: 'That record is not in this workspace.',
        });
        expectNoReceiptEffects(s);
        expect(db.pharmacyBranch.findMany).toHaveBeenCalledWith({
          where: { organizationId: 'org_a', id: { in: ['branch_b'] }, active: true },
          select: { id: true },
        });
      });
    }
  );

  it.each(receiptProcedures)(
    '%s refuses a valid transfer TO an unassigned same-tenant branch',
    async (procedure) => {
      const s = scenario();
      s.transfer.toBranchId = 'branch_b';
      db.pharmacyBranchAssignment.findMany.mockResolvedValue([{ branchId: 'branch_a' }]);
      await expect(
        caller({ role: 'EMPLOYEE' })[procedure](
          branchReceiptInput(procedure, s.transfer.id) as never
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(s.movements).toHaveLength(0);
      expect(s.transit.onHandUnits).toBe(10);
      expect(s.destination.onHandUnits).toBe(0);
    }
  );
  it.each(receiptProcedures)(
    '%s refuses an actor with no active pharmacy assignment',
    async (procedure) => {
      const s = scenario();
      s.transfer.toBranchId = 'branch_b';
      db.pharmacyBranchAssignment.findMany.mockResolvedValue([]);
      await expect(
        caller({ role: 'EMPLOYEE' })[procedure](
          branchReceiptInput(procedure, s.transfer.id) as never
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(s.movements).toHaveLength(0);
      expect(s.transit.onHandUnits).toBe(10);
    }
  );
  it.each(receiptProcedures)(
    '%s allows an actively assigned employee at the actual destination',
    async (procedure) => {
      const s = scenario();
      s.transfer.toBranchId = 'branch_b';
      db.pharmacyBranchAssignment.findMany.mockResolvedValue([{ branchId: 'branch_b' }]);
      await caller({ role: 'EMPLOYEE' })[procedure](
        branchReceiptInput(procedure, s.transfer.id) as never
      );
      expect(s.transit.onHandUnits).toBe(6);
      expect(s.destination.onHandUnits).toBe(4);
      expect(db.pharmacyBranchAssignment.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: 'org_a',
          userId: 'user_a',
          active: true,
          branch: { organizationId: 'org_a', active: true },
        },
        select: { branchId: true },
      });
    }
  );
  it.each(receiptProcedures)(
    '%s preserves the same-tenant session ADMIN exception',
    async (procedure) => {
      const s = scenario();
      s.transfer.toBranchId = 'branch_b';
      db.pharmacyBranchAssignment.findMany.mockResolvedValue([]);
      await caller({ role: 'ADMIN' })[procedure](
        branchReceiptInput(procedure, s.transfer.id) as never
      );
      expect(s.transit.onHandUnits).toBe(6);
      expect(s.destination.onHandUnits).toBe(4);
    }
  );
  it.each(receiptProcedures)(
    '%s refuses a session from a different tenant even when ADMIN',
    async (procedure) => {
      const s = scenario();
      s.transfer.toBranchId = 'branch_b';
      await expect(
        caller({ role: 'ADMIN', userOrganizationId: 'org_b' })[procedure](
          branchReceiptInput(procedure, s.transfer.id) as never
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(s.movements).toHaveLength(0);
    }
  );

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
