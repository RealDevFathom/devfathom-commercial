import { beforeEach, describe, expect, it, vi } from 'vitest';

const ledger = vi.hoisted(() => ({ loadStockCandidatesForRead: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('./stock-ledger', () => ledger);

import { readLostDemandAdvice, saltStrengthKey } from './lost-demand-advice-reader';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const NOW = new Date('2026-11-15T12:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const SCOPE = { organizationId: 'org_a', branchId: 'b1' };

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
  const model = () => ({
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
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
  db.pharmacySaleLine!.findMany!.mockResolvedValue([
    { branchId: 'b1', canonicalUnits: 300 },
    { branchId: 'b2', canonicalUnits: 30 },
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
});
