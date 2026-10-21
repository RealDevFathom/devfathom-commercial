import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  purchasingWorkspace,
  listPurchaseReturns,
  listSupplierCredits,
  type PurchasingReadBounds,
} from './purchasing-console';

const scope = { organizationId: 'org_a', branchId: 'branch_a' };
const from = new Date('2026-09-01T00:00:00.000Z');
const to = new Date('2026-09-03T23:59:59.999Z');
const row = (id: string) => ({
  ...scope,
  id,
  createdAt: from,
  receivedAt: from,
  lines: [],
  debitNotes: [],
  allocations: [],
});
function database(rows: ReturnType<typeof row>[] = []) {
  const findMany = vi.fn().mockResolvedValue(rows);
  return {
    findMany,
    db: {
      pharmacyPurchaseReturn: { findMany },
      pharmacySupplierCredit: { findMany },
    } as unknown as ScopedDb,
  };
}

describe.each([
  ['returns', listPurchaseReturns, 'createdAt'],
  ['credits', listSupplierCredits, 'receivedAt'],
] as const)('bounded live %s reader', (_label, read, dateBasis) => {
  it('pins tenant, branch and inclusive dates before limiting a deterministic source query', async () => {
    const { db, findMany } = database([row('b'), row('a')]);
    const before = Date.now();
    const result = await read(db, scope, { from, to, page: { limit: 1 } });
    expect(findMany).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: { ...scope, [dateBasis]: { gte: from, lte: to } },
        orderBy: [{ [dateBasis]: 'desc' }, { id: 'desc' }],
        take: 2,
      })
    );
    expect(result).toMatchObject({
      rows: [{ id: 'b' }],
      coverage: 'partial',
      truncated: true,
      nextCursor: { at: from, id: 'b' },
      cap: { limit: 1, max: 100 },
      bounds: { from, to },
      dateBasis,
      snapshot: 'live',
    });
    expect(result.observedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.observedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(result.rows).toHaveLength(1);
  });

  it('uses a date/id keyset with the same scope/range, without looking up the cursor row', async () => {
    const { db, findMany } = database([row('a')]);
    const after = { at: from, id: 'b' };
    const result = await read(db, scope, { from, to, page: { limit: 1, after } });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          ...scope,
          [dateBasis]: { gte: from, lte: to },
          OR: [{ [dateBasis]: { lt: from } }, { [dateBasis]: from, id: { lt: 'b' } }],
        },
        take: 2,
      })
    );
    expect(result).toMatchObject({
      rows: [{ id: 'a' }],
      coverage: 'partial',
      truncated: false,
      nextCursor: null,
    });
  });

  it.each([0, 1])('reports exhausted first-page coverage for %i records', async (count) => {
    const { db } = database(count ? [row('a')] : []);
    const result = await read(db, scope, { page: { limit: 1 } });
    expect(result).toMatchObject({
      coverage: 'complete',
      truncated: false,
      nextCursor: null,
      bounds: { from: null, to: null },
      snapshot: 'live',
    });
    expect(result.rows).toHaveLength(count);
  });

  it('does not call an empty later page complete', async () => {
    const { db } = database();
    expect(
      await read(db, scope, { page: { after: { at: from, id: 'foreign-cursor' } } })
    ).toMatchObject({
      rows: [],
      coverage: 'partial',
      truncated: false,
      nextCursor: null,
      cap: { limit: 50, max: 100 },
    });
  });

  it('preserves legacy unpaginated arrays, with optional one-sided date bounds', async () => {
    const { db, findMany } = database([row('b'), row('a')]);
    const legacy = await read(db, scope);
    expect(Array.isArray(legacy)).toBe(true);
    expect(legacy.map((item) => item.id)).toEqual(['b', 'a']);
    expect(findMany.mock.calls[0]![0]).not.toHaveProperty('take');
    expect(Array.isArray(await read(db, scope, { from }))).toBe(true);
    expect(findMany.mock.lastCall![0].where[dateBasis]).toEqual({ gte: from, lte: undefined });
    await read(db, scope, { to });
    expect(findMany.mock.lastCall![0].where[dateBasis]).toEqual({ gte: undefined, lte: to });
  });

  it.each([
    { from: to, to: from },
    { from: new Date('invalid') },
    { page: { limit: 0 } },
    { page: { limit: 101 } },
    { page: { limit: 1.5 } },
    { page: { after: { at: from, id: '' } } },
  ])('rejects invalid bounds before reading: %j', async (options) => {
    const { db, findMany } = database();
    await expect(read(db, scope, options as PurchasingReadBounds)).rejects.toThrow();
    expect(findMany).not.toHaveBeenCalled();
  });
});

it('retains the legacy at clock for window preparation without claiming historical balances', async () => {
  const { db, findMany } = database();
  findMany.mockResolvedValue([{ ...row('a'), lines: [{ returnWindowEndsAt: to }] }]);
  const legacy = await listPurchaseReturns(db, scope, { at: from });
  expect(legacy[0]!.lines[0]!.daysToWindowEnd).toBe(2);
  const page = await listPurchaseReturns(db, scope, { at: from, page: {} });
  expect(page.snapshot).toBe('live');
  expect(page.observedAt.getTime()).toBeGreaterThan(to.getTime());
});

it('labels goods-in packs using each child multiplier, excluding the parent multiplier', async () => {
  const empty = { findMany: vi.fn().mockResolvedValue([]) };
  const db = {
    pharmacyBranch: empty,
    pharmacyStockLocation: empty,
    pharmacySupplier: empty,
    user: empty,
    medicine: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'm1',
          productName: 'Test',
          brandName: null,
          coldChain: false,
          controlled: false,
          presentations: [
            {
              presentation: 'TABLET',
              packLevels: [
                {
                  id: 'box',
                  level: 'BOX',
                  unitsPerParent: 1,
                  parentPackLevelId: null,
                  effectiveFrom: from,
                  effectiveTo: null,
                },
                {
                  id: 'strip',
                  level: 'STRIP',
                  unitsPerParent: 5,
                  parentPackLevelId: 'box',
                  effectiveFrom: from,
                  effectiveTo: null,
                },
                {
                  id: 'unit',
                  level: 'UNIT',
                  unitsPerParent: 12,
                  parentPackLevelId: 'strip',
                  effectiveFrom: from,
                  effectiveTo: null,
                },
              ],
            },
          ],
        },
      ]),
    },
  } as unknown as ScopedDb;
  const workspace = await purchasingWorkspace(db, scope, { at: to });
  expect(workspace.medicines[0]!.packs).toEqual([
    expect.objectContaining({
      level: 'BOX',
      canonicalUnitsPerPack: 60,
      conversionLabel: '1 BOX = 5 STRIPs = 60 UNITs = 60 units',
    }),
    expect.objectContaining({
      level: 'STRIP',
      canonicalUnitsPerPack: 12,
      conversionLabel: '1 STRIP = 12 UNITs = 12 units',
    }),
    expect.objectContaining({
      level: 'UNIT',
      canonicalUnitsPerPack: 1,
      conversionLabel: '1 UNIT = 1 units',
    }),
  ]);
});
