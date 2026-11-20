import { describe, expect, it, vi } from 'vitest';
import {
  readDiscountLimits,
  readDiscountSuggestions,
  readMaxDiscountSettings,
  recordCompetitorPrice,
  saveMaxDiscountBps,
} from './smart-discount-service';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'manager-a' };
const NOW = new Date('2026-11-15T00:00:00Z');

type Lot = {
  id: string;
  packLevelId: string;
  printedMrpMinor: number;
  unitCostMinor: number;
  unitsPerPack: number;
  packLevel: { presentation: { medicineId: string } };
};
type DailySales = {
  medicineId: string;
  packLevelId: string;
  day: string;
  discounted: boolean;
  units: bigint;
  netMinor: bigint;
};
type Medicine = {
  id: string;
  productName: string;
  rx: boolean;
  restricted: boolean;
  controlled: boolean;
};

let lotSequence = 0;
const lot = (
  medicineId: string,
  packLevelId: string,
  mrp: number,
  unitCost: number,
  units = 10,
  id = `lot-${(lotSequence += 1)}`
) => ({
  id,
  packLevelId,
  printedMrpMinor: mrp,
  unitCostMinor: unitCost,
  unitsPerPack: units,
  packLevel: { presentation: { medicineId } },
});

function dailySales(
  medicineId: string,
  packLevelId: string,
  days: number,
  units: number,
  unitNet: number,
  discounted: boolean
): DailySales[] {
  return Array.from({ length: days }, (_, i) => ({
    medicineId,
    packLevelId,
    day: `2026-10-${String(i + 1).padStart(2, '0')}`,
    discounted,
    units: BigInt(units),
    netMinor: BigInt(units * unitNet),
  }));
}

const medicine = (id: string, flags: Partial<Medicine> = {}): Medicine => ({
  id,
  productName: `Item ${id}`,
  rx: false,
  restricted: false,
  controlled: false,
  ...flags,
});

function suggestionDb(
  options: {
    medicines?: Medicine[];
    lots?: Lot[];
    sales?: DailySales[];
    competitors?: Array<{
      medicineId: string;
      packLevelId: string;
      _min: { observedPriceMinor: number | null };
    }>;
    maxDiscountBps?: number;
    /** Lots whose remaining stock is fully held for supplier claims or restock orders. */
    reservedLotIds?: string[];
  } = {}
) {
  return {
    pharmacyBranch: { findFirst: vi.fn(async () => ({ discountPolicy: { minMarginBps: 2_000 } })) },
    organization: {
      findFirst: vi.fn(async () => ({ pharmacyMaxDiscountBps: options.maxDiscountBps ?? 1_500 })),
    },
    medicine: {
      findMany: vi.fn(async () => options.medicines ?? [medicine('medicine-a')]),
    },
    pharmacyInventoryLot: {
      findMany: vi.fn<(args: { where: Record<string, unknown>; take?: number }) => Promise<Lot[]>>(
        async () =>
          options.lots ?? [
            lot('medicine-a', 'pack-box', 1_200, 80),
            // A different pack size: never mixed into the box's cap or floor.
            lot('medicine-a', 'pack-strip', 100, 999, 1),
          ]
      ),
    },
    pharmacyCompetitorPriceObservation: {
      groupBy: vi.fn<
        (args: { where: Record<string, unknown> }) => Promise<
          Array<{
            medicineId: string;
            packLevelId: string;
            _min: { observedPriceMinor: number | null };
          }>
        >
      >(
        async () =>
          options.competitors ?? [
            {
              medicineId: 'medicine-a',
              packLevelId: 'pack-box',
              _min: { observedPriceMinor: 1_100 },
            },
            // Another pack size of the same medicine is never compared with the box.
            {
              medicineId: 'medicine-a',
              packLevelId: 'pack-strip',
              _min: { observedPriceMinor: 10 },
            },
          ]
      ),
    },
    $queryRaw: vi.fn<(query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>>(
      async (query, ...values) => {
        // The stock ledger's net-availability read, keyed by lot id.
        if (query.join('?').includes('"inventoryLotId" = ANY'))
          return (values.find(Array.isArray) as string[]).map((inventoryLotId) => ({
            inventoryLotId,
            availableUnits: options.reservedLotIds?.includes(inventoryLotId) ? 0 : 10,
          }));
        return options.sales ?? [];
      }
    ),
  };
}

describe('DEV-66 discount suggestions read', () => {
  it('reads only saleable live lots and compares competitor prices for the same pack', async () => {
    const db = suggestionDb();
    const [row] = await readDiscountSuggestions(db as never, scope, {
      medicineIds: ['medicine-a'],
      now: NOW,
    });

    const lotArgs = db.pharmacyInventoryLot.findMany.mock.calls[0]![0];
    // Bounds aggregate every eligible lot, never a truncated sample.
    expect(lotArgs).not.toHaveProperty('take');
    expect(lotArgs.where).toMatchObject({
      organizationId: 'org-a',
      branchId: 'branch-a',
      receivedAt: { not: null },
      batch: { state: 'ACTIVE', expiresAt: { gt: NOW }, medicine: { saleable: true } },
      balances: { some: { disposition: 'AVAILABLE', onHandUnits: { gt: 0 } } },
    });
    expect(db.pharmacyCompetitorPriceObservation.groupBy.mock.calls[0]![0].where).toMatchObject({
      organizationId: 'org-a',
      branchId: 'branch-a',
      medicineId: { in: ['medicine-a'] },
    });

    expect(row).toMatchObject({
      packLevelId: 'pack-box',
      suggestion: {
        kind: 'SUGGEST',
        basis: 'COMPETITOR',
        ceilingPriceMinor: 1_200,
        floorPriceMinor: 1_000,
        suggestedPriceMinor: 1_100,
      },
    });
  });

  it("limits the suggestion to the owner's maximum discount", async () => {
    const db = suggestionDb({
      lots: [lot('medicine-a', 'pack-box', 1_200, 10)],
      competitors: [
        { medicineId: 'medicine-a', packLevelId: 'pack-box', _min: { observedPriceMinor: 600 } },
      ],
      maxDiscountBps: 1_000,
    });
    const [row] = await readDiscountSuggestions(db as never, scope, {
      medicineIds: ['medicine-a'],
      now: NOW,
    });
    expect(row).toMatchObject({ suggestion: { kind: 'SUGGEST', suggestedPriceMinor: 1_080 } });
  });

  it('aggregates over every eligible lot of the selected pack, older restrictive lots included', async () => {
    const lots = [
      lot('medicine-a', 'pack-box', 1_200, 80),
      ...Array.from({ length: 25 }, () => lot('medicine-a', 'pack-box', 1_200, 80)),
      // The oldest lot has the lowest MRP and the highest cost; both bounds come from it.
      lot('medicine-a', 'pack-box', 1_150, 85),
    ];
    const db = suggestionDb({ lots });
    const [row] = await readDiscountSuggestions(db as never, scope, {
      medicineIds: ['medicine-a'],
      now: NOW,
    });
    expect(row).toMatchObject({
      suggestion: { ceilingPriceMinor: 1_150, floorPriceMinor: 1_063 },
    });
  });

  it('reads demand evidence for the selected pack only', async () => {
    const box = [
      ...dailySales('medicine-a', 'pack-box', 10, 10, 1_200, false),
      ...dailySales('medicine-a', 'pack-box', 10, 20, 1_080, true),
    ];
    // Strip sales at a far lower price would make the box look very elastic if mixed in.
    const strips = dailySales('medicine-a', 'pack-strip', 10, 500, 50, true);
    const db = suggestionDb({ sales: [...box, ...strips], competitors: [] });
    const [row] = await readDiscountSuggestions(db as never, scope, {
      medicineIds: ['medicine-a'],
      now: NOW,
    });
    const boxOnly = suggestionDb({ sales: box, competitors: [] });
    const [expected] = await readDiscountSuggestions(boxOnly as never, scope, {
      medicineIds: ['medicine-a'],
      now: NOW,
    });
    expect(row!.elasticity).not.toBeNull();
    expect(row!.elasticity).toEqual(expected!.elasticity);
    expect(row).toMatchObject({ suggestion: { kind: 'SUGGEST', basis: 'ELASTICITY' } });
  });

  it('uses a fixed number of batched queries however many medicines are asked for', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `medicine-${i}`);
    const db = suggestionDb({
      medicines: ids.map((id) => medicine(id)),
      lots: ids.map((id) => lot(id, `pack-${id}`, 1_200, 80)),
      competitors: [],
    });
    const rows = await readDiscountSuggestions(db as never, scope, { medicineIds: ids, now: NOW });
    expect(rows).toHaveLength(50);
    expect(db.pharmacyInventoryLot.findMany).toHaveBeenCalledTimes(1);
    expect(db.pharmacyCompetitorPriceObservation.groupBy).toHaveBeenCalledTimes(1);
    // One net-availability read for every lot, and sale history aggregated per day in one query.
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    const sql = db.$queryRaw.mock.calls[1]![0].join('?');
    expect(sql).toContain('GROUP BY');
    expect(sql).toContain('"status" = \'COMPLETED\'');
  });

  it('ignores a lot whose remaining stock is fully reserved', async () => {
    // The newest lot is a cheap strip pack, but all of it is held for restock orders: the
    // box sets the pack and the bounds, as the ledger would sell it.
    const db = suggestionDb({
      lots: [
        lot('medicine-a', 'pack-strip', 100, 999, 1, 'lot-reserved'),
        lot('medicine-a', 'pack-box', 1_200, 80, 10, 'lot-box'),
      ],
      reservedLotIds: ['lot-reserved'],
    });
    const [row] = await readDiscountSuggestions(db as never, scope, {
      medicineIds: ['medicine-a'],
      now: NOW,
    });
    expect(db.$queryRaw.mock.calls[0]!.slice(1).find(Array.isArray)).toEqual([
      'lot-reserved',
      'lot-box',
    ]);
    expect(row).toMatchObject({
      packLevelId: 'pack-box',
      suggestion: { kind: 'SUGGEST', ceilingPriceMinor: 1_200, floorPriceMinor: 1_000 },
    });
  });

  it('offers no suggestion when every lot is fully reserved', async () => {
    const db = suggestionDb({
      lots: [lot('medicine-a', 'pack-box', 1_200, 80, 10, 'lot-held')],
      reservedLotIds: ['lot-held'],
    });
    const [row] = await readDiscountSuggestions(db as never, scope, {
      medicineIds: ['medicine-a'],
      now: NOW,
    });
    expect(row).toMatchObject({ suggestion: null });
  });

  it('never reads stock or evidence for regulated medicines', async () => {
    const db = suggestionDb({ medicines: [medicine('rx-a', { rx: true })] });
    const [row] = await readDiscountSuggestions(db as never, scope, {
      medicineIds: ['rx-a'],
      now: NOW,
    });
    expect(row).toMatchObject({ suggestion: { kind: 'EXCLUDED', reason: 'REGULATED' } });
    expect(db.pharmacyInventoryLot.findMany).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('DEV-66 competitor price log', () => {
  it('refuses a pack level that is not a pack of the medicine', async () => {
    const create = vi.fn();
    const db = {
      packLevel: { findFirst: vi.fn(async () => null) },
      pharmacyCompetitorPriceObservation: { create },
    };
    await expect(
      recordCompetitorPrice(db as never, scope, {
        medicineId: 'medicine-a',
        packLevelId: 'pack-of-another-medicine',
        competitorLabel: 'Store across the road',
        observedPriceMinor: 900,
        observedAt: NOW,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.packLevel.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-a',
          id: 'pack-of-another-medicine',
          presentation: { medicineId: 'medicine-a' },
        },
      })
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('records the observed pack with the price', async () => {
    const create = vi.fn(async () => ({ id: 'obs-a', observedAt: NOW }));
    const db = {
      packLevel: { findFirst: vi.fn(async () => ({ id: 'pack-box' })) },
      pharmacyCompetitorPriceObservation: { create },
    };
    await recordCompetitorPrice(db as never, scope, {
      medicineId: 'medicine-a',
      packLevelId: 'pack-box',
      competitorLabel: 'Store across the road',
      observedPriceMinor: 900,
      observedAt: NOW,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          branchId: 'branch-a',
          medicineId: 'medicine-a',
          packLevelId: 'pack-box',
          recordedByUserId: 'manager-a',
        }),
      })
    );
  });
});

describe("DEV-66 owner's maximum discount", () => {
  const ownerRole = {
    role: 'ADMIN',
    status: 'ACTIVE',
    organizationRole: { key: 'owner', isSystem: true, permissions: [] },
    permissionOverrides: [],
  };
  const managerRole = {
    role: 'EMPLOYEE',
    status: 'ACTIVE',
    organizationRole: {
      key: 'manager',
      isSystem: true,
      permissions: [{ capability: 'pharmacy:manage', effect: 'ALLOW' }],
    },
    permissionOverrides: [],
  };
  function ownerDb(user: unknown, stored: unknown = 1_000) {
    return {
      user: { findFirst: vi.fn(async () => user) },
      // The locked read of the value being replaced, for the audit's "before".
      $queryRaw: vi.fn(async () => [{ bps: 1_000 }]),
      organization: {
        findFirst: vi.fn(async () => ({ pharmacyMaxDiscountBps: stored })),
        update: vi.fn(async ({ data }: { data: { pharmacyMaxDiscountBps: number } }) => data),
      },
      pharmacyBranch: {
        findFirst: vi.fn(async () => ({ discountPolicy: { minMarginBps: 1_500 } })),
      },
    };
  }

  it('lets the owner change it and stores it for the whole organization', async () => {
    const db = ownerDb(ownerRole);
    await expect(saveMaxDiscountBps(db as never, scope, 2_000)).resolves.toEqual({
      previousMaxDiscountBps: 1_000,
      maxDiscountBps: 2_000,
    });
    expect(db.$queryRaw.mock.calls[0]!.join(' ')).toContain('FOR UPDATE');
    expect(db.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'org-a' }, data: { pharmacyMaxDiscountBps: 2_000 } })
    );
    expect(db.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'manager-a', organizationId: 'org-a' } })
    );
  });

  it('refuses everyone but the owner, managers included', async () => {
    for (const user of [managerRole, null, { ...ownerRole, status: 'SUSPENDED' }]) {
      const db = ownerDb(user);
      await expect(saveMaxDiscountBps(db as never, scope, 2_000)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(db.organization.update).not.toHaveBeenCalled();
    }
  });

  it('refuses a value outside 0 to 100%', async () => {
    const db = ownerDb(ownerRole);
    for (const value of [-1, 10_001, 12.5])
      await expect(saveMaxDiscountBps(db as never, scope, value)).rejects.toThrow();
    expect(db.organization.update).not.toHaveBeenCalled();
  });

  it('reads the stored value with whether the caller may change it', async () => {
    await expect(readMaxDiscountSettings(ownerDb(managerRole) as never, scope)).resolves.toEqual({
      maxDiscountBps: 1_000,
      canChange: false,
    });
    await expect(readMaxDiscountSettings(ownerDb(ownerRole) as never, scope)).resolves.toEqual({
      maxDiscountBps: 1_000,
      canChange: true,
    });
  });

  it('returns both limits for a sale line, failing closed on an unreadable maximum', async () => {
    await expect(readDiscountLimits(ownerDb(ownerRole) as never, scope)).resolves.toEqual({
      minMarginBps: 1_500,
      maxDiscountBps: 1_000,
    });
    await expect(readDiscountLimits(ownerDb(ownerRole, 'x') as never, scope)).resolves.toEqual({
      minMarginBps: 1_500,
      maxDiscountBps: 0,
    });
  });
});
