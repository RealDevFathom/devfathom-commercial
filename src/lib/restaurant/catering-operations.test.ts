import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ cost: vi.fn(), post: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('./recipe-costing', () => ({ computeRecipeCostInDb: mocks.cost }));
vi.mock('./inventory-ledger', () => ({ postStockMovements: mocks.post }));
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  approveQuote,
  availability,
  consumeFrozen,
  consumptionHistory,
  invalidateQuote,
  payloadHash,
  peakHeadcount,
  publishQuote,
  recordDisposition,
  snapshotCosts,
  type QuoteSnapshot,
} from './catering-operations';
const d = (s: string) => new Prisma.Decimal(s);
function fixture() {
  const requirement = {
    ingredientId: 'rice',
    ingredientName: 'Rice',
    baseUnitId: 'g',
    stockItemId: 'stock',
    quantityInBaseUnit: '1000',
    unitCost: '0.02',
    costSource: 'REFERENCE' as const,
  };
  const snapshot: QuoteSnapshot = {
    schemaVersion: 1,
    currency: 'PKR',
    quotedTotal: '100',
    headcount: 10,
    bookingStartsAt: '2026-10-08T10:00:00Z',
    bookingEndsAt: '2026-10-08T11:00:00Z',
    fulfillmentMode: 'PICKUP',
    stockLocationId: 'location',
    lines: [],
    extraCosts: [],
    requirements: [requirement],
    missing: [],
  };
  const state = {
    revision: 0,
    approvedQuoteRevisionId: 'quote',
    confirmedQuoteRevisionId: 'quote',
    bookingStartsAt: new Date(snapshot.bookingStartsAt!),
    bookingEndsAt: new Date(snapshot.bookingEndsAt!),
    fulfillmentMode: 'PICKUP',
    stockLocationId: 'location',
  };
  const quote = { id: 'quote', revision: 0, snapshot, contentHash: payloadHash(snapshot) };
  const order = {
    id: 'order',
    organizationId: 'org',
    branchId: 'branch',
    status: 'DRAFT',
    headcount: 10,
    quotedTotal: d('100'),
    lines: [
      {
        id: 'line',
        recipeId: 'recipe',
        productId: null,
        description: 'Rice',
        portions: d('10'),
        unitPrice: d('10'),
      },
    ],
    extraCosts: [],
  };
  let allocated = d('0');
  let disposition: { id: string; payloadHash: string } | null = null;
  const raw = vi.fn(async (query: Prisma.Sql) => {
    const sql = query.strings.join('?');
    if (sql.includes('SELECT "bookingStartsAt"')) return [state];
    if (sql.includes('FROM restaurant_catering_quote_revisions')) return [quote];
    if (sql.includes('FROM restaurant_catering_branch_capacity'))
      return [{ maxConcurrentHeadcount: 20 }];
    if (sql.includes('SELECT id,"bookingStartsAt"')) return [{ ...order, ...state }];
    if (sql.includes('sum(quantity)')) return [{ allocated }];
    if (sql.includes('FROM restaurant_catering_dispositions'))
      return disposition ? [disposition] : [];
    return [];
  });
  const execute = vi.fn(async (query: Prisma.Sql) => {
    const sql = query.strings.join('?');
    if (sql.includes('revision=revision+1')) {
      state.revision++;
      state.approvedQuoteRevisionId = null as unknown as string;
    }
    if (sql.includes('INSERT INTO restaurant_catering_dispositions')) {
      allocated = allocated.plus(query.values[5] as string);
      disposition = { id: query.values[0] as string, payloadHash: query.values[10] as string };
    }
    return 1;
  });
  const db = {
    $queryRaw: raw,
    $executeRaw: execute,
    restaurantCateringOrder: { findFirst: vi.fn(async () => order) },
    restaurantCateringOrderLine: { updateMany: vi.fn() },
    restaurantRecipeVersion: {
      findMany: vi.fn(async () => [{ id: 'version-original', status: 'ACTIVE' }]),
    },
    restaurantIngredient: { findFirst: vi.fn(async () => ({ referenceCost: d('0.02') })) },
    restaurantStockLocation: { findFirst: vi.fn(async () => ({ id: 'location' })) },
    restaurantStockItem: { findFirst: vi.fn(async () => ({ id: 'stock' })) },
    restaurantInventoryIdempotencyKey: {
      findFirst: vi.fn(async ({ where }: { where: { key: string } }) =>
        where.key.endsWith(':consumption') ? { resultRef: 'movement' } : null
      ),
    },
    restaurantStockMovement: {
      findFirst: vi.fn(async () => ({
        quantity: d('-1'),
        stockItemId: 'stock',
        locationId: 'location',
        batchId: null,
        stockItem: { canonicalUnitId: 'kg' },
        location: { branchId: 'branch', isActive: true },
      })),
    },
  };
  return {
    db,
    tx: db as unknown as ScopedDb,
    state,
    quote,
    order,
    requirement,
    setAllocated: (v: string) => {
      allocated = d(v);
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.post.mockResolvedValue({ movements: [{ id: 'returned' }], replayed: false });
  mocks.cost.mockResolvedValue({
    recipeVersionId: 'version-original',
    portionCount: 10,
    lines: [
      {
        ingredientId: 'rice',
        ingredientName: 'Rice',
        baseUnitId: 'g',
        stockItemId: 'stock',
        quantityInBaseUnit: d('1000'),
        unitCost: d('0.02'),
        source: 'REFERENCE',
      },
    ],
  });
});
describe('booking capacity', () => {
  it('uses peak simultaneous occupancy with half-open boundary, not sum of all overlaps', () => {
    const row = (a: number, b: number, n: number) => ({
      bookingStartsAt: new Date(a),
      bookingEndsAt: new Date(b),
      headcount: n,
    });
    expect(peakHeadcount([row(0, 10, 10), row(10, 20, 20), row(5, 15, 5)])).toBe(25);
  });
  it('reports unknown for a legacy reservation without interval', async () => {
    const f = fixture();
    f.state.bookingStartsAt = null as unknown as Date;
    expect(await availability(f.tx, 'org', 'branch', 'order')).toMatchObject({
      capacityStatus: 'UNKNOWN',
    });
  });
  it('rejects excess headcount', async () => {
    const f = fixture();
    f.order.headcount = 21;
    expect(await availability(f.tx, 'org', 'branch', 'order')).toMatchObject({
      capacityStatus: 'EXCEEDED',
    });
  });
});
describe('frozen quote and costing', () => {
  it('invalidates approval on edit while retaining history and rejects stale approval', async () => {
    const f = fixture();
    await invalidateQuote(f.tx, 'org', 'order');
    expect(f.state.revision).toBe(1);
    expect(f.state.approvedQuoteRevisionId).toBeNull();
    await expect(approveQuote(f.tx, 'org', 'order', 'quote', 'staff')).rejects.toThrow('stale');
    expect(f.quote.revision).toBe(0);
  });
  it('reuses immutable quote on publish replay despite new ingredient prices', async () => {
    const f = fixture();
    expect(await publishQuote(f.tx, 'org', 'order', 'PKR', 'staff')).toBe(f.quote);
    expect(mocks.cost).not.toHaveBeenCalled();
  });
  it('freezes exact root recipe version, quantities and nullable costs at first publication', async () => {
    const f = fixture();
    const raw = f.db.$queryRaw.getMockImplementation()!;
    f.db.$queryRaw.mockImplementation(async (q) =>
      q.strings.join('?').includes('FROM restaurant_catering_quote_revisions') ? [] : raw(q)
    );
    const quote = await publishQuote(f.tx, 'org', 'order', 'PKR', 'staff');
    expect(quote.snapshot.lines[0]).toMatchObject({
      recipeVersionId: 'version-original',
      portions: '10',
    });
    expect(quote.snapshot.requirements[0]).toMatchObject({
      quantityInBaseUnit: '1000',
      unitCost: '0.02',
    });
    expect(mocks.cost).toHaveBeenCalledWith(f.tx, {
      organizationId: 'org',
      recipeVersionId: 'version-original',
    });
  });
  it('rejects a legacy product-only line even when replaying a quote revision', async () => {
    const f = fixture();
    const line = f.order.lines[0]! as {
      productId: string | null;
      recipeId: string | null;
    };
    line.productId = 'product';
    line.recipeId = null;

    await expect(publishQuote(f.tx, 'org', 'order', 'PKR', 'staff')).rejects.toThrow(
      'A recipe is required for every quoted line.'
    );
    // Publishing must lock the order before reading its lines, but reject
    // product-only lines before reading booking state or an existing quote.
    expect(f.db.$queryRaw).toHaveBeenCalledExactlyOnceWith(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${'order'},0))`
    );
    expect(mocks.cost).not.toHaveBeenCalled();
    expect(f.db.$executeRaw).not.toHaveBeenCalled();
  });
  it('labels absent costs missing without manufacturing zero profit inputs', () => {
    const f = fixture();
    f.quote.snapshot.missing = ['rice'];
    f.quote.snapshot.requirements[0]!.unitCost = null;
    expect(snapshotCosts(f.quote.snapshot)).toMatchObject({
      costBasis: 'MISSING',
      ingredientCost: null,
      grossMargin: null,
      marginPercent: null,
      actualCost: null,
    });
  });
  it('preserves Decimal ingredient/gross margin and never claims actual/net profit', () => {
    const f = fixture();
    expect(snapshotCosts(f.quote.snapshot)).toMatchObject({
      costBasis: 'ESTIMATED',
      ingredientCost: '20',
      grossMargin: '80',
      marginPercent: '80',
      actualCost: null,
    });
  });
  it('withholds frozen margin percentage for a zero quote denominator', () => {
    const f = fixture();
    f.quote.snapshot.quotedTotal = '0';
    expect(snapshotCosts(f.quote.snapshot)).toMatchObject({
      grossMargin: '-20',
      marginPercent: null,
      actualCost: null,
    });
  });
  it('uses frozen components after active recipe/price changes and sends explicit grams', async () => {
    const f = fixture();
    await consumeFrozen(f.tx, 'org', 'order', 'branch', 'staff');
    expect(mocks.cost).not.toHaveBeenCalled();
    expect(f.db.restaurantIngredient.findFirst).not.toHaveBeenCalled();
    const movement = mocks.post.mock.calls[0]![1].movements[0];
    expect(movement.unitId).toBe('g');
    expect(movement.quantity.toString()).toBe('-1000');
    // The existing ledger converts this explicit unit by .001; omitting unitId gave -1000 kg.
    expect(movement.quantity.times('0.001').toString()).toBe('-1');
  });
  it('fails closed when a frozen stock link disappears', async () => {
    const f = fixture();
    f.db.restaurantStockItem.findFirst.mockResolvedValue(null as never);
    await expect(consumeFrozen(f.tx, 'org', 'order', 'branch', 'staff')).rejects.toThrow(
      'stock link'
    );
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
const disposition = {
  originalMovementId: 'movement',
  kind: 'UNUSED_RETURN' as const,
  quantity: '0.25',
  reason: 'Unused sealed rice physically returned',
  idempotencyKey: 'return-1',
};
describe('physical cancellation disposition', () => {
  it('returns only allocated canonical quantity and replays without double posting', async () => {
    const f = fixture();
    f.order.status = 'CANCELLED';
    const first = await recordDisposition(f.tx, 'org', 'order', 'staff', disposition);
    const second = await recordDisposition(f.tx, 'org', 'order', 'staff', disposition);
    expect(second).toEqual({ id: first.id, replayed: true });
    expect(mocks.post).toHaveBeenCalledOnce();
    const movement = mocks.post.mock.calls[0]![1].movements[0];
    expect(movement.unitId).toBe('kg');
    expect(movement.quantity.toString()).toBe('0.25');
    await expect(
      recordDisposition(f.tx, 'org', 'order', 'staff', { ...disposition, quantity: '0.5' })
    ).rejects.toThrow('payload changed');
  });
  it.each(['WASTE', 'NO_RETURN'] as const)(
    'records %s without a second inventory movement',
    async (kind) => {
      const f = fixture();
      f.order.status = 'CANCELLED';
      await recordDisposition(f.tx, 'org', 'order', 'staff', { ...disposition, kind });
      expect(mocks.post).not.toHaveBeenCalled();
      expect(f.db.$executeRaw).toHaveBeenCalledOnce();
    }
  );
  it('caps sum of all physical dispositions against the original movement', async () => {
    const f = fixture();
    f.order.status = 'CANCELLED';
    f.setAllocated('0.9');
    await expect(recordDisposition(f.tx, 'org', 'order', 'staff', disposition)).rejects.toThrow(
      'exceeds'
    );
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('rejects unrelated movement and historic automatic reversal', async () => {
    const f = fixture();
    f.order.status = 'CANCELLED';
    await expect(
      recordDisposition(f.tx, 'org', 'order', 'staff', {
        ...disposition,
        originalMovementId: 'foreign',
      })
    ).rejects.toThrow('does not belong');
    f.db.restaurantInventoryIdempotencyKey.findFirst.mockResolvedValue({ resultRef: 'movement' });
    await expect(recordDisposition(f.tx, 'org', 'order', 'staff', disposition)).rejects.toThrow(
      'Historical'
    );
  });
  it('propagates late failure to the owning transaction instead of committing partial evidence', async () => {
    const f = fixture();
    f.order.status = 'CANCELLED';
    f.db.$executeRaw.mockRejectedValueOnce(new Error('insert failed'));
    await expect(recordDisposition(f.tx, 'org', 'order', 'staff', disposition)).rejects.toThrow(
      'insert failed'
    );
    expect(mocks.post).toHaveBeenCalledOnce();
  });
});

it('executes the real ledger conversion: frozen 1000g becomes exactly -1kg', async () => {
  const f = fixture();
  const ledger = await vi.importActual<typeof import('./inventory-ledger')>('./inventory-ledger');
  const created: Prisma.Decimal[] = [];
  Object.assign(f.db, {
    $transaction: async (work: (tx: ScopedDb) => Promise<unknown>) => work(f.tx),
    restaurantUnitConversion: { findUnique: vi.fn(async () => ({ factor: d('0.001') })) },
  });
  Object.assign(f.db.restaurantStockItem, {
    findMany: vi.fn(async () => [{ id: 'stock', canonicalUnitId: 'kg' }]),
  });
  Object.assign(f.db.restaurantInventoryIdempotencyKey, {
    findFirst: vi.fn(async () => null),
    create: vi.fn(),
    updateMany: vi.fn(),
  });
  Object.assign(f.db.restaurantStockMovement, {
    create: vi.fn(async ({ data }: { data: { quantity: Prisma.Decimal } }) => {
      created.push(data.quantity);
      return { id: 'posted', ...data };
    }),
  });
  mocks.post.mockImplementation(ledger.postStockMovements);
  await consumeFrozen(f.tx, 'org', 'order', 'branch', 'staff');
  expect(created.map((q) => q.toString())).toEqual(['-1']);
});

describe('canonical consumption history', () => {
  function historyFixture(historical = false) {
    return {
      $executeRaw: vi.fn(),
      restaurantInventoryIdempotencyKey: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ resultRef: 'movement' })
          .mockResolvedValueOnce(historical ? { id: 'legacy' } : null),
      },
      restaurantStockMovement: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'movement',
            stockItemId: 'stock',
            locationId: 'location',
            quantity: d('-1.25'),
            stockItem: { canonicalUnit: { id: 'kg', name: 'Kilogram', abbreviation: 'kg' } },
          },
        ]),
      },
      $queryRaw: vi.fn().mockResolvedValue([
        {
          id: 'disposition',
          originalMovementId: 'movement',
          kind: 'WASTE',
          quantity: '0.35',
          resultMovementId: null,
          reason: 'Prepared',
          actorStaffProfileId: 'staff',
          createdAt: new Date(),
        },
      ]),
    };
  }
  it('subtracts physical allocations exactly in canonical units', async () => {
    const tx = historyFixture();
    const result = await consumptionHistory(tx as unknown as ScopedDb, 'org', 'order', 'branch');
    expect(result.movements[0]).toMatchObject({
      originalMovementId: 'movement',
      consumed: '1.25',
      allocated: '0.35',
      remaining: '0.9',
      canonicalUnit: { id: 'kg' },
    });
    expect(result.reconciliationRequired).toBe(false);
    expect(tx.restaurantStockMovement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org',
          id: { in: ['movement'] },
          location: { branchId: 'branch' },
        }),
      })
    );
  });
  it('marks legacy reversal as reconciliation required without inventing available returns', async () => {
    const result = await consumptionHistory(
      historyFixture(true) as unknown as ScopedDb,
      'org',
      'order',
      'branch'
    );
    expect(result.reconciliationRequired).toBe(true);
    expect(result.movements[0].remaining).toBeNull();
  });
  it('fails closed for missing or foreign branch source movements', async () => {
    const tx = historyFixture();
    tx.restaurantStockMovement.findMany.mockResolvedValue([]);
    await expect(
      consumptionHistory(tx as unknown as ScopedDb, 'org', 'order', 'branch')
    ).rejects.toThrow('Original consumption is unavailable');
  });
  it('rejects inconsistent overallocated history', async () => {
    const tx = historyFixture();
    tx.$queryRaw.mockResolvedValue([{ originalMovementId: 'movement', quantity: '1.26' }]);
    await expect(
      consumptionHistory(tx as unknown as ScopedDb, 'org', 'order', 'branch')
    ).rejects.toThrow('Disposition history exceeds');
  });
});
