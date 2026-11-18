import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./regulatory', async () => ({
  ...(await vi.importActual<typeof import('./regulatory')>('./regulatory')),
  assertStoredPharmacyMayOperate: vi.fn(async () => undefined),
}));
vi.mock('./stock-ledger', async () => ({
  ...(await vi.importActual<typeof import('./stock-ledger')>('./stock-ledger')),
  allocateForSale: vi.fn(
    async (_db: unknown, _scope: unknown, input: { requiredUnits: number }) => ({
      allocations: [
        { inventoryLotId: 'lot-a', stockLocationId: 'location-a', units: input.requiredUnits },
      ],
      movementIds: ['movement-a'],
    })
  ),
}));

import { addSaleLine, PharmacySaleError } from './sales';
import { allocateForSale } from './stock-ledger';

/**
 * DEV-830 (security scan F05): a counter request chose its own canonical-unit multiplier,
 * so a full pack could be sold with `canonicalUnitsPerSaleUnit: 1` and the server charged
 * and debited a single tablet. The multiplier is now derived from the stored medicine,
 * presentation and pack hierarchy before any stock is allocated or the line is priced.
 */
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };
const EFFECTIVE = new Date('2026-01-01T00:00:00.000Z');

/** One box of 10 strips of 10 tablets: box 100, strip 10, tablet 1. */
const hierarchy = [
  { id: 'box', level: 'BOX', parentPackLevelId: null, unitsPerParent: 1 },
  { id: 'strip', level: 'STRIP', parentPackLevelId: 'box', unitsPerParent: 10 },
  { id: 'tablet', level: 'UNIT', parentPackLevelId: 'strip', unitsPerParent: 10 },
].map((level) => ({
  ...level,
  effectiveFrom: EFFECTIVE,
  effectiveTo: null,
  versionGroupId: `${level.id}-group`,
}));

function saleDb(options: { receivedUnitsPerPack?: number[] } = {}) {
  return {
    $queryRaw: vi.fn(async () => []),
    pharmacySale: {
      findFirst: vi.fn(async () => ({ id: 'sale-a', status: 'OPEN', lines: [] })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    medicine: {
      findFirst: vi.fn(async () => ({
        id: 'medicine-a',
        rx: false,
        otc: true,
        restricted: false,
        controlled: false,
      })),
    },
    packLevel: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { presentationId: string; presentation: { medicineId: string } };
        }) =>
          where.presentationId === 'presentation-a' &&
          where.presentation.medicineId === 'medicine-a'
            ? hierarchy
            : []
      ),
    },
    pharmacyInventoryLot: {
      findFirst: vi.fn(
        async ({ where }: { where: { packLevelId: string; unitsPerPack: number } }) =>
          where.packLevelId === 'box' &&
          (options.receivedUnitsPerPack ?? []).includes(where.unitsPerPack)
            ? { id: 'lot-a' }
            : null
      ),
      findMany: vi.fn(async () => [
        {
          id: 'lot-a',
          packLevelId: 'box',
          printedMrpMinor: 10_000,
          unitsPerPack: 100,
          unitCostMinor: 50,
          batch: { batchNumber: 'B-1' },
        },
      ]),
    },
    medicinePackMrp: { findMany: vi.fn(async () => []) },
    pharmacySaleLine: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'line-a',
        ...data,
      })),
    },
    pharmacySaleLineAllocation: { create: vi.fn(async () => ({})) },
    pharmacySaleEvent: { create: vi.fn(async () => ({})) },
  };
}

const line = {
  saleId: 'sale-a',
  medicineId: 'medicine-a',
  presentationId: 'presentation-a',
  packLevelId: 'box',
  saleUnit: 'PACK' as const,
  quantity: 1,
  canonicalUnitsPerSaleUnit: 100,
  idempotencyKey: 'line-a',
};

function expectNoSideEffects(db: ReturnType<typeof saleDb>) {
  expect(allocateForSale).not.toHaveBeenCalled();
  expect(db.pharmacySaleLine.create).not.toHaveBeenCalled();
  expect(db.pharmacySaleLineAllocation.create).not.toHaveBeenCalled();
  expect(db.pharmacySaleEvent.create).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.mocked(allocateForSale).mockClear();
});

describe('sale-unit multiplier derived from the stored pack setup (DEV-830 F05)', () => {
  it('passes the shelf-label lot constraint to the locked stock allocator', async () => {
    await addSaleLine(saleDb() as never, scope, { ...line, shelfLabelLotId: 'lot-a' });
    expect(vi.mocked(allocateForSale).mock.calls[0]?.[2]).toMatchObject({
      expectedInventoryLotId: 'lot-a',
    });
  });

  it('refuses a full pack with a single-unit multiplier before any stock or price', async () => {
    const db = saleDb();
    await expect(
      addSaleLine(db as never, scope, { ...line, canonicalUnitsPerSaleUnit: 1 })
    ).rejects.toThrow(new PharmacySaleError('INVALID_SALE_UNIT'));
    expectNoSideEffects(db);
  });

  it.each([
    ['a strip priced as one tablet', { saleUnit: 'STRIP' as const, packLevelId: 'strip' }, 1],
    ['a strip priced as a box', { saleUnit: 'STRIP' as const, packLevelId: 'strip' }, 100],
    ['a loose unit that carries ten', { saleUnit: 'UNIT' as const, packLevelId: 'tablet' }, 10],
    ['a pack level of another presentation', { presentationId: 'presentation-b' }, 100],
    ['a pack level outside the presentation', { packLevelId: 'carton-elsewhere' }, 100],
  ])('refuses %s', async (_label, overrides, multiplier) => {
    const db = saleDb();
    await expect(
      addSaleLine(db as never, scope, {
        ...line,
        ...overrides,
        canonicalUnitsPerSaleUnit: multiplier,
      })
    ).rejects.toThrow(new PharmacySaleError('INVALID_SALE_UNIT'));
    expectNoSideEffects(db);
  });

  it('scopes the pack setup to the line medicine and presentation in this organization', async () => {
    const db = saleDb();
    await addSaleLine(db as never, scope, line);
    expect(db.packLevel.findMany.mock.calls[0]![0].where).toEqual({
      organizationId: 'org-a',
      presentationId: 'presentation-a',
      presentation: { organizationId: 'org-a', medicineId: 'medicine-a' },
    });
  });

  it('sells a full pack at its stored multiplier and full price', async () => {
    const db = saleDb();
    await addSaleLine(db as never, scope, line);
    expect(vi.mocked(allocateForSale).mock.calls[0]![2]).toMatchObject({ requiredUnits: 100 });
    expect(db.pharmacySaleLine.create.mock.calls[0]![0].data).toMatchObject({
      saleUnit: 'PACK',
      canonicalUnitsPerSaleUnit: 100,
      canonicalUnits: 100,
      grossMinor: 10_000,
    });
  });

  it.each([
    ['STRIP' as const, 'strip', 10, 1_000],
    ['UNIT' as const, 'tablet', 1, 100],
  ])('sells a %s at its stored multiplier', async (saleUnit, packLevelId, multiplier, gross) => {
    const db = saleDb();
    await addSaleLine(db as never, scope, {
      ...line,
      saleUnit,
      packLevelId,
      canonicalUnitsPerSaleUnit: multiplier,
    });
    expect(db.pharmacySaleLine.create.mock.calls[0]![0].data).toMatchObject({
      canonicalUnits: multiplier,
      grossMinor: gross,
    });
  });

  it('accepts the size a lot of this medicine was received as at the branch (DEV-717)', async () => {
    const db = saleDb({ receivedUnitsPerPack: [50] });
    await addSaleLine(db as never, scope, { ...line, canonicalUnitsPerSaleUnit: 50 });
    expect(db.pharmacyInventoryLot.findFirst.mock.calls[0]![0].where).toEqual({
      organizationId: 'org-a',
      branchId: 'branch-a',
      packLevelId: 'box',
      unitsPerPack: 50,
      batch: { medicineId: 'medicine-a' },
    });
    expect(vi.mocked(allocateForSale).mock.calls[0]![2]).toMatchObject({ requiredUnits: 50 });
  });
});

describe('offline replay checks the sale unit at the signed sale time (DEV-830)', () => {
  // `strip-v2` replaced `strip-v1` before the sale, but the tablet level still points at
  // `strip-v1`; `strip-v3` replaced `strip-v2` after the sale and before the replay.
  const window = (from: string, to: string | null) => ({
    effectiveFrom: new Date(from),
    effectiveTo: to ? new Date(to) : null,
  });
  const revised = [
    {
      id: 'box',
      level: 'BOX',
      parentPackLevelId: null,
      unitsPerParent: 1,
      versionGroupId: 'g-box',
      ...window('2025-01-01', null),
    },
    {
      id: 'strip-v1',
      level: 'STRIP',
      parentPackLevelId: 'box',
      unitsPerParent: 10,
      versionGroupId: 'g-strip',
      ...window('2025-01-01', '2026-01-01'),
    },
    {
      id: 'strip-v2',
      level: 'STRIP',
      parentPackLevelId: 'box',
      unitsPerParent: 10,
      versionGroupId: 'g-strip',
      ...window('2026-01-01', '2026-06-01'),
    },
    {
      id: 'strip-v3',
      level: 'STRIP',
      parentPackLevelId: 'box',
      unitsPerParent: 10,
      versionGroupId: 'g-strip',
      ...window('2026-06-01', null),
    },
    {
      id: 'tablet',
      level: 'UNIT',
      parentPackLevelId: 'strip-v1',
      unitsPerParent: 10,
      versionGroupId: 'g-tablet',
      ...window('2025-01-01', null),
    },
  ];
  const stripLine = {
    ...line,
    saleUnit: 'STRIP' as const,
    packLevelId: 'strip-v2',
    canonicalUnitsPerSaleUnit: 10,
  };

  it('accepts a strip that was current when the offline sale was made', async () => {
    const db = saleDb();
    db.packLevel.findMany.mockResolvedValue(revised as never);
    await addSaleLine(db as never, scope, stripLine, {
      saleUnitAt: new Date('2026-03-01T12:00:00.000Z'),
    });
    expect(db.pharmacySaleLine.create.mock.calls[0]![0].data).toMatchObject({
      canonicalUnits: 10,
    });
  });

  it('still refuses that strip on a sale checked against the later setup', async () => {
    const db = saleDb();
    db.packLevel.findMany.mockResolvedValue(revised as never);
    await expect(
      addSaleLine(db as never, scope, stripLine, {
        saleUnitAt: new Date('2026-09-01T12:00:00.000Z'),
      })
    ).rejects.toThrow(new PharmacySaleError('INVALID_SALE_UNIT'));
    expectNoSideEffects(db);
  });
});

describe('DEV-705 legacy strip server conversion', () => {
  function legacyDb() {
    const db = saleDb();
    db.packLevel.findMany.mockResolvedValue([
      {
        ...hierarchy[0],
        unitsPerParent: 100,
        presentation: { presentation: '10x10', dosageForm: 'Tablet' },
      },
    ] as never);
    return db;
  }
  it('posts a legacy strip and three loose tablets at their exact stock and price', async () => {
    const db = legacyDb();
    await addSaleLine(db as never, scope, {
      ...line,
      saleUnit: 'STRIP',
      canonicalUnitsPerSaleUnit: 10,
    });
    await addSaleLine(db as never, scope, {
      ...line,
      saleUnit: 'UNIT',
      canonicalUnitsPerSaleUnit: 1,
      quantity: 3,
      idempotencyKey: 'loose',
    });
    expect(vi.mocked(allocateForSale).mock.calls.map((call) => call[2].requiredUnits)).toEqual([
      10, 3,
    ]);
    expect(
      db.pharmacySaleLine.create.mock.calls.map(([{ data }]) => [
        data.canonicalUnits,
        data.grossMinor,
      ])
    ).toEqual([
      [10, 1000],
      [3, 300],
    ]);
  });
  it('refuses a strip on a box that is not counted in tablets or capsules', async () => {
    const db = saleDb();
    db.packLevel.findMany.mockResolvedValue([
      {
        ...hierarchy[0],
        unitsPerParent: 100,
        presentation: { presentation: '10x10', dosageForm: 'Injection' },
      },
    ] as never);
    await expect(
      addSaleLine(db as never, scope, { ...line, saleUnit: 'STRIP', canonicalUnitsPerSaleUnit: 10 })
    ).rejects.toThrow(new PharmacySaleError('INVALID_SALE_UNIT'));
    expectNoSideEffects(db);
  });
  it.each([1, 5, 20, 99])(
    'refuses forged legacy strip multiplier %s before allocation',
    async (multiplier) => {
      const db = legacyDb();
      await expect(
        addSaleLine(db as never, scope, {
          ...line,
          saleUnit: 'STRIP',
          canonicalUnitsPerSaleUnit: multiplier,
        })
      ).rejects.toThrow(new PharmacySaleError('INVALID_SALE_UNIT'));
      expectNoSideEffects(db);
    }
  );
});
