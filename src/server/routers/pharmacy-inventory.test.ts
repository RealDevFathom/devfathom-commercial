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
  const refreshStockSignals = vi.fn(async () => undefined);
  return { hasModule, refreshStockSignals };
});
vi.mock('@/lib/pharmacy/stock-signals-operations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/stock-signals-operations')>()),
  refreshStockSignals: mocks.refreshStockSignals,
}));
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

import {
  markdownPackPrice,
  MARKDOWN_DRAFT_PREFIX,
  parseMarkdownDraft,
  pharmacyInventoryRouter,
} from './pharmacy-inventory';
import type { TRPCContext } from '../trpc';

function model() {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi
      .fn()
      .mockImplementation(async ({ data }: { data: object }) => ({ id: 'new', ...data })),
    update: vi.fn(),
    count: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    createMany: vi.fn().mockResolvedValue({ count: 1 }),
    aggregate: vi.fn().mockResolvedValue({ _sum: {} }),
    findFirstOrThrow: vi.fn(),
  };
}

function makeDb() {
  const db = {
    medicine: model(),
    packLevel: model(),
    pharmacyStockLocation: model(),
    pharmacyManufacturingBatch: model(),
    pharmacyInventoryLot: model(),
    pharmacyStockMovement: model(),
    pharmacyStockBalance: model(),
    pharmacyAllocationOverride: model(),
    pharmacyStockDiscrepancy: model(),
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
    pharmacyBranch: model(),
    pharmacySupplier: model(),
    pharmacySupplierClaim: model(),
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
    db.pharmacyManufacturingBatch.findFirst.mockResolvedValue({ id: 'batch_1' });
    await expect(
      caller().setBatchState({ manufacturingBatchId: 'batch_1', state: 'RECALLED' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacyManufacturingBatch.update).not.toHaveBeenCalled();
  });

  it('refuses a transfer whose source and destination are the same location', async () => {
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

describe('PUR-07 — the stock action centre transport', () => {
  it('gates the action centre behind the same pharmacy-inventory entitlement', () => {
    expect(moduleForProcedure('pharmacyInventory.refreshStockSignals')).toBe('pharmacy-inventory');
    expect(moduleForProcedure('pharmacyInventory.createDraftAction')).toBe('pharmacy-inventory');
  });

  it('records the SESSION actor as the safety-stock approver, never a payload field', async () => {
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

describe('PH-A5 — expiry board actions transport', () => {
  const DAY = 86_400_000;
  const position = { branchId: 'branch_a', inventoryLotId: 'lot_1', stockLocationId: 'location_1' };
  const IN_60_DAYS = new Date(Date.now() + 60 * DAY);

  function lot(overrides: { expiresAt?: Date; state?: string } = {}) {
    return {
      id: 'lot_1',
      printedMrpMinor: 32_000,
      unitsPerPack: 10,
      unitCostMinor: 2_500,
      batch: {
        batchNumber: 'B-77',
        expiresAt: overrides.expiresAt ?? IN_60_DAYS,
        state: overrides.state ?? 'ACTIVE',
        medicineId: 'medicine_1',
      },
    };
  }

  function arrange(overrides: Parameters<typeof lot>[0] = {}) {
    db.pharmacyBranch.findFirst.mockResolvedValue({ id: 'branch_a' });
    db.pharmacyInventoryLot.findFirst.mockResolvedValue(lot(overrides));
    db.pharmacyStockLocation.findFirst.mockResolvedValue({ id: 'location_1' });
    db.pharmacyStockBalance.findFirst.mockResolvedValue({
      onHandUnits: 70,
      sealedPacks: 7,
      looseUnits: 0,
    });
    db.pharmacyStockSignal.findFirst.mockResolvedValue({ id: 'signal_1' });
  }

  beforeEach(() => mocks.refreshStockSignals.mockClear());

  it('gates every expiry procedure behind the pharmacy-inventory entitlement', () => {
    for (const name of [
      'expiryBoardLots',
      'draftExpiryMarkdown',
      'draftExpiryReturn',
      'quarantineExpiring',
    ]) {
      expect(moduleForProcedure(`pharmacyInventory.${name}`)).toBe('pharmacy-inventory');
    }
  });

  it('refuses a branch outside the session organization before touching anything', async () => {
    arrange();
    db.pharmacyBranch.findFirst.mockResolvedValue(null);
    for (const call of [
      () => caller().expiryBoardLots({ branchId: 'branch_from_org_b' }),
      () =>
        caller().draftExpiryMarkdown({
          ...position,
          branchId: 'branch_from_org_b',
          markdownPercent: 20,
          reason: 'Clear before expiry',
        }),
      () =>
        caller().draftExpiryReturn({
          ...position,
          branchId: 'branch_from_org_b',
          supplierId: 'supplier_1',
          units: 10,
          reason: 'Near expiry',
        }),
      () =>
        caller().quarantineExpiring({
          ...position,
          branchId: 'branch_from_org_b',
          units: 10,
          reason: 'Near expiry',
          requestKey: 'request-key-1',
        }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(db.pharmacyBranch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'branch_from_org_b', organizationId: 'org_a' }),
      })
    );
    expect(db.pharmacyStockSignalEvent.create).not.toHaveBeenCalled();
    expect(db.pharmacyPurchaseReturn.create).not.toHaveBeenCalled();
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  describe('mark-down draft', () => {
    const input = { ...position, markdownPercent: 20, reason: 'Clear before expiry' };

    it('records an inert draft on the NEAR_EXPIRY signal, attributed to the session actor', async () => {
      arrange();
      const result = await caller({ userId: 'user_inventory' }).draftExpiryMarkdown(input);

      expect(result).toMatchObject({
        created: true,
        signalId: 'signal_1',
        draft: { printedMrpMinor: 32_000, proposedPackPriceMinor: 25_600, markdownPercent: 20 },
      });
      const { data } = db.pharmacyStockSignalEvent.create.mock.calls[0]![0] as {
        data: { detail: string; kind: string; actorId: string; reason: string; signalId: string };
      };
      expect(data).toMatchObject({
        kind: 'DRAFT_ACTION',
        actorId: 'user_inventory',
        reason: 'Clear before expiry',
        signalId: 'signal_1',
      });
      expect(parseMarkdownDraft(data.detail)).toMatchObject({
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_1',
        proposedPackPriceMinor: 25_600,
      });
      // A draft: no price is written and no stock moves.
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
      expect(db.pharmacyInventoryLot.update).not.toHaveBeenCalled();
      // The lot row is locked, so concurrent drafts on it serialize.
      const [lockQuery] = db.$queryRaw.mock.calls[0] as unknown as [{ strings: string[] }];
      expect(lockQuery.strings.join('?')).toContain('FOR UPDATE');
    });

    it('replays an identical draft instead of stacking a duplicate', async () => {
      arrange();
      db.pharmacyStockSignalEvent.findMany.mockResolvedValue([
        {
          id: 'event_1',
          detail: `${MARKDOWN_DRAFT_PREFIX}${JSON.stringify({
            inventoryLotId: 'lot_1',
            stockLocationId: 'location_1',
            markdownPercent: 20,
            proposedPackPriceMinor: 25_600,
          })}`,
        },
      ]);
      await expect(caller().draftExpiryMarkdown(input)).resolves.toMatchObject({
        created: false,
        eventId: 'event_1',
      });
      expect(db.pharmacyStockSignalEvent.create).not.toHaveBeenCalled();
    });

    it('records a revised percentage as a new draft', async () => {
      arrange();
      db.pharmacyStockSignalEvent.findMany.mockResolvedValue([
        {
          id: 'event_1',
          detail: `${MARKDOWN_DRAFT_PREFIX}${JSON.stringify({
            inventoryLotId: 'lot_1',
            stockLocationId: 'location_1',
            markdownPercent: 10,
            proposedPackPriceMinor: 28_800,
          })}`,
        },
      ]);
      await expect(caller().draftExpiryMarkdown(input)).resolves.toMatchObject({ created: true });
      expect(db.pharmacyStockSignalEvent.create).toHaveBeenCalledTimes(1);
    });

    it('refuses expired, blocked, far-dated and over-discounted lots', async () => {
      arrange({ expiresAt: new Date(Date.now() - DAY) });
      await expect(caller().draftExpiryMarkdown(input)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      arrange({ state: 'RECALLED' });
      await expect(caller().draftExpiryMarkdown(input)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'BLOCKED_STOCK',
      });
      arrange({ expiresAt: new Date(Date.now() + 400 * DAY) });
      await expect(caller().draftExpiryMarkdown(input)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      arrange();
      await expect(
        caller().draftExpiryMarkdown({ ...input, markdownPercent: 95 })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(db.pharmacyStockSignalEvent.create).not.toHaveBeenCalled();
    });

    it('refreshes signals once when none covers the lot, then refuses if still none', async () => {
      arrange();
      db.pharmacyStockSignal.findFirst.mockResolvedValue(null);
      await expect(caller().draftExpiryMarkdown(input)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(mocks.refreshStockSignals).toHaveBeenCalledTimes(1);
      expect(db.pharmacyStockSignalEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('supplier return draft', () => {
    const input = {
      ...position,
      supplierId: 'supplier_1',
      units: 40,
      reason: 'Near expiry',
    };

    it('drafts an EXPIRY_CLAIM that reserves nothing and moves nothing', async () => {
      arrange();
      db.pharmacySupplier.findFirst.mockResolvedValue({ id: 'supplier_1' });
      db.pharmacyPurchaseReturn.findFirstOrThrow.mockResolvedValue({
        id: 'return_1',
        reference: 'EXP-1',
        status: 'DRAFT',
      });
      await expect(caller().draftExpiryReturn(input)).resolves.toEqual({
        created: true,
        purchaseReturn: { id: 'return_1', reference: 'EXP-1', status: 'DRAFT' },
      });
      expect(db.pharmacyPurchaseReturn.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: 'org_a',
            kind: 'EXPIRY_CLAIM',
            supplierId: 'supplier_1',
          }),
        })
      );
      const lines = (
        db.pharmacyPurchaseReturnLine.createMany.mock.calls[0]![0] as {
          data: Array<Record<string, unknown>>;
        }
      ).data;
      expect(lines).toEqual([
        expect.objectContaining({
          inventoryLotId: 'lot_1',
          stockLocationId: 'location_1',
          quantityUnits: 40,
          expectedCreditMinor: 40 * 2_500,
          returnWindowEndsAt: IN_60_DAYS,
        }),
      ]);
      expect(db.pharmacySupplierClaim.create).not.toHaveBeenCalled();
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    });

    it('returns the open return for the lot instead of drafting a second one', async () => {
      arrange();
      db.pharmacyPurchaseReturnLine.findFirst.mockResolvedValue({
        purchaseReturn: { id: 'return_1', reference: 'EXP-1', status: 'SUBMITTED' },
      });
      await expect(caller().draftExpiryReturn(input)).resolves.toMatchObject({ created: false });
      expect(db.pharmacyPurchaseReturn.create).not.toHaveBeenCalled();
    });

    it('refuses a supplier outside the workspace and units already reserved', async () => {
      arrange();
      await expect(caller().draftExpiryReturn(input)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      db.pharmacySupplier.findFirst.mockResolvedValue({ id: 'supplier_1' });
      db.pharmacySupplierClaim.aggregate.mockResolvedValue({ _sum: { reservedUnits: 40 } });
      await expect(caller().draftExpiryReturn(input)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'INSUFFICIENT_STOCK',
      });
      expect(db.pharmacyPurchaseReturn.create).not.toHaveBeenCalled();
    });
  });

  describe('quarantine', () => {
    const input = {
      ...position,
      units: 70,
      reason: 'Near expiry: pulled from sale',
      requestKey: 'request-key-1',
    };

    it('posts the AVAILABLE-out / QUARANTINE-in movement pair under the request key', async () => {
      arrange();
      await expect(caller().quarantineExpiring(input)).resolves.toMatchObject({ replayed: false });
      const moves = db.pharmacyStockMovement.create.mock.calls.map(
        ([arg]) => (arg as { data: Record<string, unknown> }).data
      );
      expect(moves).toEqual([
        expect.objectContaining({
          disposition: 'AVAILABLE',
          quantityUnits: -70,
          idempotencyKey: 'expiry-quarantine:request-key-1:out',
          actorId: 'user_a',
        }),
        expect.objectContaining({
          disposition: 'QUARANTINE',
          quantityUnits: 70,
          idempotencyKey: 'expiry-quarantine:request-key-1:in',
        }),
      ]);
    });

    it('replays a double-submitted form and refuses a reused key for other stock', async () => {
      arrange();
      db.pharmacyStockMovement.findFirst.mockResolvedValue({
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_1',
        quantityUnits: 70,
      });
      await expect(caller().quarantineExpiring(input)).resolves.toMatchObject({ replayed: true });
      await expect(caller().quarantineExpiring({ ...input, units: 10 })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    });
  });

  it('lists near-expiry and expired positions with their drafts, soonest first', async () => {
    db.pharmacyBranch.findFirst.mockResolvedValue({ id: 'branch_a' });
    const batch = (batchNumber: string, expiresAt: Date) => ({
      batchNumber,
      expiresAt,
      state: 'ACTIVE',
      medicine: { productName: 'Amoxicillin 500mg', brandName: null },
    });
    db.pharmacyStockBalance.findMany.mockImplementation(
      async ({ where }: { where: { disposition: string } }) =>
        where.disposition === 'QUARANTINE'
          ? [{ inventoryLotId: 'lot_1', onHandUnits: 5 }]
          : [
              {
                inventoryLotId: 'lot_1',
                stockLocationId: 'location_1',
                onHandUnits: 70,
                location: { name: 'Front shelf' },
                lot: {
                  supplierName: 'Indus Pharma',
                  unitsPerPack: 10,
                  unitCostMinor: 2_500,
                  printedMrpMinor: 32_000,
                  batch: batch('B-60', new Date(Date.now() + 60 * DAY)),
                  receiptLines: [{ goodsReceipt: { supplierId: 'supplier_1' } }],
                },
              },
              {
                inventoryLotId: 'lot_2',
                stockLocationId: 'location_1',
                onHandUnits: 3,
                location: { name: 'Front shelf' },
                lot: {
                  supplierName: 'Unknown Traders',
                  unitsPerPack: 10,
                  unitCostMinor: 1_000,
                  printedMrpMinor: 15_000,
                  batch: batch('B-OLD', new Date(Date.now() - 2 * DAY)),
                  receiptLines: [],
                },
              },
            ]
    );
    db.pharmacySupplier.findMany.mockResolvedValue([{ id: 'supplier_1', name: 'Indus Pharma' }]);
    db.pharmacyPurchaseReturnLine.findMany.mockResolvedValue([
      {
        inventoryLotId: 'lot_1',
        purchaseReturn: { id: 'return_1', reference: 'EXP-1', status: 'DRAFT' },
      },
    ]);
    db.pharmacyStockSignalEvent.findMany.mockResolvedValue([
      {
        id: 'event_1',
        reason: 'Clear before expiry',
        createdAt: new Date(),
        detail: `${MARKDOWN_DRAFT_PREFIX}${JSON.stringify({
          inventoryLotId: 'lot_1',
          stockLocationId: 'location_1',
          markdownPercent: 20,
          printedMrpMinor: 32_000,
          proposedPackPriceMinor: 25_600,
        })}`,
      },
      { id: 'event_2', reason: null, createdAt: new Date(), detail: 'DRAFT requisition REQ-1' },
    ]);

    const board = await caller().expiryBoardLots({ branchId: 'branch_a', withinDays: 90 });

    expect(board.withinDays).toBe(90);
    expect(board.rows.map((row) => [row.batchNumber, row.expired])).toEqual([
      ['B-OLD', true],
      ['B-60', false],
    ]);
    expect(board.rows[1]).toMatchObject({
      valueAtRiskMinor: 70 * 2_500,
      quarantinedUnits: 5,
      suggestedSupplierId: 'supplier_1',
      markdown: { markdownPercent: 20, proposedPackPriceMinor: 25_600 },
      returnDraft: { reference: 'EXP-1' },
    });
    expect(board.rows[0]).toMatchObject({ suggestedSupplierId: null, markdown: null });
    await expect(
      // @ts-expect-error — only the four board windows are accepted.
      caller().expiryBoardLots({ branchId: 'branch_a', withinDays: 45 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('prices a mark-down off the printed MRP and ignores foreign draft events', () => {
    expect(markdownPackPrice(32_000, 20)).toBe(25_600);
    expect(markdownPackPrice(999, 15)).toBe(849);
    expect(parseMarkdownDraft('DRAFT requisition REQ-1')).toBeNull();
    expect(parseMarkdownDraft(`${MARKDOWN_DRAFT_PREFIX}{not json`)).toBeNull();
  });
});
