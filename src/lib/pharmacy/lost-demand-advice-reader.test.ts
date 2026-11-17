import { beforeEach, describe, expect, it, vi } from 'vitest';

const ledger = vi.hoisted(() => ({ loadStockCandidatesForRead: vi.fn() }));
const access = vi.hoisted(() => ({ procurementBranchIds: vi.fn() }));
vi.mock('./procurement-access', () => access);
vi.mock('server-only', () => ({}));
vi.mock('./stock-ledger', () => ledger);

import { readLostDemandAdvice, saltStrengthKey } from './lost-demand-advice-reader';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const NOW = new Date('2026-11-15T12:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const SCOPE = { organizationId: 'org_a', branchId: 'b1', actorId: 'buyer' };

const PARACETAMOL = [{ ingredientId: 'ing_p', value: { toString: () => '500' }, unit: 'mg' }];

function demand(id: string, medicine: { id: string; brandName: string } | null, saleId = 'sale') {
  return {
    id,
    createdAt: ago(1),
    saleId,
    requestedMedicineId: medicine?.id ?? null,
    requestedText: medicine ? null : 'Unknown syrup',
    strength: null,
    saleUnit: 'UNIT',
    quantity: 10,
    estimatedValueMinor: 1_000,
    medicine: medicine
      ? { ...medicine, productName: medicine.brandName, strengths: PARACETAMOL }
      : null,
  };
}

function candidate(branchId: string, availableUnits: number, overrides: object = {}) {
  return {
    inventoryLotId: `lot_${branchId}_${availableUnits}`,
    stockLocationId: 'loc',
    organizationId: 'org_a',
    branchId,
    batchState: 'ACTIVE',
    disposition: 'AVAILABLE',
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    receivedAt: ago(30),
    availableUnits,
    ...overrides,
  };
}

let db: Record<string, Record<string, ReturnType<typeof vi.fn>>>;

beforeEach(() => {
  access.procurementBranchIds.mockResolvedValue(['b1', 'b2']);
  const model = () => ({
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    groupBy: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
  });
  db = new Proxy({} as typeof db, {
    get(target, key: string) {
      target[key] ??= model();
      return target[key];
    },
  });
  db.organization!.findFirst!.mockResolvedValue({ currency: 'PKR' });
  db.pharmacySale!.count!.mockResolvedValue(40);
  db.unfulfilledDemandEvent!.findMany!.mockResolvedValue([
    demand('e1', { id: 'brand_a', brandName: 'Brand A' }),
    demand('e2', { id: 'brand_a', brandName: 'Brand A' }),
    // Same salt and strength, other brand: one demand group.
    demand('e3', { id: 'brand_b', brandName: 'Brand B' }, null as unknown as string),
    demand('e4', null),
  ]);
  ledger.loadStockCandidatesForRead.mockImplementation(
    async (_db: unknown, scope: { branchId: string }) =>
      scope.branchId === 'b1'
        ? [candidate('b1', 4)]
        : [
            candidate('b2', 300),
            // Expired, quarantined and fully reserved stock never counts.
            candidate('b2', 900, { expiresAt: ago(1) }),
            candidate('b2', 900, { disposition: 'QUARANTINE' }),
            candidate('b2', 0),
          ]
  );
  db.pharmacySaleLine!.groupBy!.mockResolvedValue([
    { branchId: 'b1', _sum: { canonicalUnits: 300 } },
    { branchId: 'b2', _sum: { canonicalUnits: 30 } },
  ]);
  db.pharmacyBranch!.findMany!.mockResolvedValue([{ id: 'b2', name: 'South' }]);
  db.pharmacyPurchaseOrderLine!.findMany!.mockImplementation(
    async ({ where }: { where: { purchaseOrder: { status: { in: string[] } } } }) =>
      where.purchaseOrder.status.in.includes('SUBMITTED')
        ? [
            {
              orderedCanonicalUnits: 50,
              bonusCanonicalUnits: 10,
              goodsReceiptLines: [{ acceptedCanonicalUnits: 40, rejectedCanonicalUnits: 0 }],
            },
          ]
        : [
            {
              packLevelId: 'pack_a',
              canonicalUnitsPerPack: 10,
              orderedPacks: 10,
              bonusPacks: 1,
              listPricePerPackMinor: 50_000,
              discountBps: 0,
              leadTimeDays: null,
              createdAt: ago(10),
              purchaseOrder: {
                id: 'po_1',
                supplierId: 'sup_a',
                sentAt: ago(20),
                supplier: { name: 'Alpha' },
                goodsReceipts: [{ receivedAt: ago(16) }],
              },
            },
          ]
  );
});

describe('readLostDemandAdvice', () => {
  it('refuses incomplete history instead of calculating a misleading rate', async () => {
    db.unfulfilledDemandEvent!.findMany!.mockResolvedValue(
      Array.from({ length: 5001 }, (_, id) => demand(`e${id}`, null))
    );
    await expect(readLostDemandAdvice(db as unknown as ScopedDb, SCOPE, NOW)).rejects.toThrow(
      'exceeds the supported window'
    );
  });
  it('counts one walk-out visit once even when three products were unavailable', async () => {
    db.pharmacySale!.count!.mockResolvedValue(19);
    db.pharmacyLostDemandTriggerSetting!.findFirst!.mockResolvedValue({
      requestCountThreshold: 10,
    });
    db.unfulfilledDemandEvent!.findMany!.mockResolvedValue(
      [1, 2, 3].map((id) => ({
        ...demand(`e${id}`, { id: 'brand_a', brandName: 'Brand A' }, null as unknown as string),
        visitId: 'one-visit',
        visitType: 'WALK_OUT',
      }))
    );
    expect((await readLostDemandAdvice(db as unknown as ScopedDb, SCOPE, NOW)).advice).toEqual([]);
  });

  it('uses the recorded outcome-adjusted loss rather than the gross request value', async () => {
    db.unfulfilledDemandEvent!.findMany!.mockResolvedValue([
      {
        ...demand('e1', { id: 'brand_a', brandName: 'Brand A' }),
        estimatedValueMinor: 2_000_000,
        estLossPkrMinor: 0,
      },
    ]);
    expect((await readLostDemandAdvice(db as unknown as ScopedDb, SCOPE, NOW)).advice).toEqual([]);
  });

  it('does not classify an explicit partial visit as a walk-out without a sale id', async () => {
    db.pharmacySale!.count!.mockResolvedValue(0);
    db.unfulfilledDemandEvent!.findMany!.mockResolvedValue([
      {
        ...demand('e1', { id: 'brand_a', brandName: 'Brand A' }, null as unknown as string),
        visitType: 'PARTIAL',
      },
    ]);
    expect((await readLostDemandAdvice(db as unknown as ScopedDb, SCOPE, NOW)).advice).toEqual([]);
  });

  it('restricts donor reads to the actors reachable branches', async () => {
    access.procurementBranchIds.mockResolvedValue(['b1']);
    db.pharmacyBranch!.findMany!.mockResolvedValue([]);
    await readLostDemandAdvice(db as unknown as ScopedDb, SCOPE, NOW);
    expect(db.pharmacyBranch!.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { not: 'b1', in: ['b1'] } }) })
    );
    expect(
      ledger.loadStockCandidatesForRead.mock.calls.every((call) => call[1].branchId === 'b1')
    ).toBe(true);
  });
  it('groups by salt and strength and loads real stock, inbound and distributor terms', async () => {
    const { advice, config } = await readLostDemandAdvice(db as unknown as ScopedDb, SCOPE, NOW);
    expect(config.requestCountThreshold).toBe(3);
    const salt = advice.find((row) => row.demandKey === `salt:${saltStrengthKey(PARACETAMOL)}`)!;
    expect(salt).toMatchObject({
      medicineId: 'brand_a',
      label: 'Brand A',
      onHandUnits: 4,
      onOrderUnits: 20,
      dailyDemandUnits: 10,
      trigger: { requestCount: 3, walkOuts: 1 },
    });
    expect(salt.distributors[0]).toMatchObject({
      supplierId: 'sup_a',
      scheme: { buyPacks: 10, bonusPacks: 1 },
      leadTimeDays: 4,
      leadTimeSource: 'RECORDED',
    });
    // Donor surplus counts only sellable, unreserved stock: 300 - 10 days of 1/day cover.
    expect(salt.transfer).toMatchObject({
      fromBranchId: 'b2',
      fromBranchName: 'South',
      surplusUnits: 290,
    });
    // The unmatched text request is one request: below the threshold, no card.
    expect(advice.some((row) => row.demandKey.startsWith('text:'))).toBe(false);
  });

  it('reads the visit count for the walk-out rate in the request window', async () => {
    await readLostDemandAdvice(db as unknown as ScopedDb, SCOPE, NOW);
    expect(db.pharmacySale!.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        branchId: 'b1',
        status: 'COMPLETED',
        createdAt: { gte: ago(7), lte: NOW },
      }),
    });
  });

  it('applies the branch configuration', async () => {
    db.pharmacyLostDemandTriggerSetting!.findFirst!.mockResolvedValue({ requestCountThreshold: 4 });
    const { advice } = await readLostDemandAdvice(db as unknown as ScopedDb, SCOPE, NOW);
    expect(advice).toEqual([]);
  });

  it('hides advice that was ignored after the latest request', async () => {
    const key = `salt:${saltStrengthKey(PARACETAMOL)}`;
    db.pharmacyLostDemandAdviceDecision!.findMany!.mockResolvedValue([
      { demandKey: key, createdAt: ago(0.5) },
    ]);
    expect((await readLostDemandAdvice(db as unknown as ScopedDb, SCOPE, NOW)).advice).toEqual([]);
    db.pharmacyLostDemandAdviceDecision!.findMany!.mockResolvedValue([
      { demandKey: key, createdAt: ago(2) },
    ]);
    expect((await readLostDemandAdvice(db as unknown as ScopedDb, SCOPE, NOW)).advice).toHaveLength(
      1
    );
  });

  it('keeps each donor branch own configured cover before offering its surplus', async () => {
    db.pharmacyLostDemandTriggerSetting!.findMany!.mockResolvedValue([
      { branchId: 'b2', safetyStockDays: 30, defaultLeadTimeDays: 3 },
    ]);
    const { advice } = await readLostDemandAdvice(db as unknown as ScopedDb, SCOPE, NOW);
    const salt = advice.find((row) => row.demandKey === `salt:${saltStrengthKey(PARACETAMOL)}`)!;
    // 300 sellable at 1/day, keeping South's own 33 days, not the receiver's 10.
    expect(salt.transfer).toMatchObject({ fromBranchId: 'b2', surplusUnits: 267 });
    expect(db.pharmacyLostDemandTriggerSetting!.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_a', branchId: { in: ['b2'] } },
    });
  });

  it('nets the recorded line discount out of an alternate margin', async () => {
    db.medicine!.findMany!.mockResolvedValue([
      { id: 'brand_c', productName: 'Brand C', brandName: 'Brand C', strengths: PARACETAMOL },
    ]);
    db.pharmacySaleLine!.findFirst!.mockResolvedValue({
      quantity: 1,
      canonicalUnits: 10,
      grossMinor: 1_000,
      discountMinor: 300,
      unitCostMinor: 600,
    });
    const { advice } = await readLostDemandAdvice(db as unknown as ScopedDb, SCOPE, NOW);
    const salt = advice.find((row) => row.demandKey === `salt:${saltStrengthKey(PARACETAMOL)}`)!;
    // (1000 gross - 300 discount - 600 cost) / 10 units, not (1000 - 600) / 10.
    expect(salt.alternates).toEqual([
      expect.objectContaining({ medicineId: 'brand_c', marginPerUnitMinor: 10 }),
    ]);
  });

  it('sums forecast demand in the database rather than loading every sale line', async () => {
    await readLostDemandAdvice(db as unknown as ScopedDb, SCOPE, NOW);
    expect(db.pharmacySaleLine!.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ['branchId'], _sum: { canonicalUnits: true } })
    );
    expect(db.pharmacySaleLine!.findMany).not.toHaveBeenCalled();
  });

  it('reads distributor terms from the branch own orders only', async () => {
    await readLostDemandAdvice(db as unknown as ScopedDb, SCOPE, NOW);
    const termsRead = db.pharmacyPurchaseOrderLine!.findMany!.mock.calls.find(
      ([args]) => !args.where.purchaseOrder.status.in.includes('SUBMITTED')
    )!;
    expect(termsRead[0].where.purchaseOrder).toMatchObject({ branchId: 'b1' });
  });

  it('counts open drafts and transfers already in motion, so advice is not repeated', async () => {
    db.pharmacyInterbranchTransferLine!.findMany!.mockResolvedValue([
      // Owed to this branch: 25 requested, 5 already received.
      {
        quantityUnits: 25,
        receivedUnits: 5,
        transfer: { fromBranchId: 'b2', toBranchId: 'b1', status: 'DISPATCHED' },
      },
      // Already asked of the donor but not dispatched: not offered again.
      {
        quantityUnits: 40,
        receivedUnits: 0,
        transfer: { fromBranchId: 'b2', toBranchId: 'b1', status: 'DRAFT' },
      },
    ]);
    const { advice } = await readLostDemandAdvice(db as unknown as ScopedDb, SCOPE, NOW);
    const salt = advice.find((row) => row.demandKey === `salt:${saltStrengthKey(PARACETAMOL)}`)!;
    // 20 from the open orders fixture + 20 still owed in transit + 40 requested.
    expect(salt.onOrderUnits).toBe(80);
    // South: 300 sellable - 40 already requested - 10 days of cover.
    expect(salt.transfer).toMatchObject({ fromBranchId: 'b2', surplusUnits: 250 });
    const onOrderRead = db.pharmacyPurchaseOrderLine!.findMany!.mock.calls.find(([args]) =>
      args.where.purchaseOrder.status.in.includes('SUBMITTED')
    )!;
    expect(onOrderRead[0].where.purchaseOrder.status.in).toContain('DRAFT');
  });
});
