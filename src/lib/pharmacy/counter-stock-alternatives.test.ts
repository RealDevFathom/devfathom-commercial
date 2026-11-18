import { describe, expect, it, vi } from 'vitest';
import { searchCounterCatalog } from './counter';

const at = new Date('2026-11-17T00:00:00Z');
const scope = { organizationId: 'org-a', branchId: 'branch-a' };
const component = (ingredientId = 'salt-a', value = '10.000', unit = 'mg') => ({
  ingredientId,
  value,
  unit,
  ingredient: { name: ingredientId },
});
function medicine(id: string, strengths = [component()], dosageForm = 'Tablet') {
  return {
    id,
    organizationId: 'org-a',
    productName: id === 'requested' ? 'Nalbin' : id,
    brandName: id,
    manufacturer: null,
    saleable: true,
    strengths,
    rx: true,
    otc: false,
    restricted: false,
    controlled: false,
    highAlert: false,
    lasa: false,
    coldChain: false,
    presentations: [{ id: `p-${id}`, presentation: 'Box of 10', dosageForm, route: 'Oral' }],
  };
}
function lot(id: string, medicineId: string, expiresAt = '2027-02-01', printedMrpMinor = 2000) {
  return {
    id,
    organizationId: 'org-a',
    branchId: 'branch-a',
    packLevelId: `pack-${medicineId}`,
    unitsPerPack: 10,
    printedMrpMinor,
    receivedAt: at as Date | null,
    batch: { batchNumber: id, medicineId, expiresAt: new Date(expiresAt), state: 'ACTIVE' },
  };
}
function fixture(
  medicines = [medicine('requested'), medicine('alternative')],
  lots = [lot('safe', 'alternative')]
) {
  const balances = lots.map((entry) => ({
    organizationId: entry.organizationId,
    branchId: entry.branchId,
    inventoryLotId: entry.id,
    stockLocationId: 'rack-a',
    disposition: 'AVAILABLE',
    onHandUnits: 30,
  }));
  type Args = {
    where: {
      organizationId: string;
      branchId?: string;
      id?: { in: string[] };
      batch?: { medicineId: { in: string[] } };
      inventoryLotId?: { in: string[] };
      OR?: unknown[];
      strengths?: { every: { ingredientId: { in: string[] } } };
    };
    include?: unknown;
    take?: number;
  };
  const db = {
    medicineBarcode: { findFirst: vi.fn(async () => null) },
    medicineAlias: { findMany: vi.fn(async () => []) },
    medicineStrengthComponent: { findMany: vi.fn(async () => []) },
    presentation: { findMany: vi.fn(async () => []) },
    medicine: {
      findMany: vi.fn(async ({ where, include, take }: Args) => {
        const scoped = medicines.filter(
          (entry) => entry.organizationId === where.organizationId && entry.saleable
        );
        if (where.id) return scoped.filter((entry) => where.id!.in.includes(entry.id));
        // Candidate filtering deliberately returns a superset: equivalence must also
        // be checked against the hydrated stored graph, never a string search match.
        return include
          ? scoped
          : where.strengths
            ? scoped
                .filter(
                  (entry) =>
                    entry.strengths.every((component) =>
                      where.strengths!.every.ingredientId.in.includes(component.ingredientId)
                    ) &&
                    // The branch-stock prefilter: a lot of this medicine exists here.
                    lots.some(
                      (stock) =>
                        stock.batch.medicineId === entry.id && stock.branchId === scope.branchId
                    )
                )
                .map(({ id }) => ({ id }))
                .slice(0, take)
            : scoped.filter((entry) => entry.id === 'requested').map(({ id }) => ({ id }));
      }),
    },
    pharmacyInventoryLot: {
      findMany: vi.fn(async ({ where }: Args) =>
        lots.filter(
          (entry) =>
            entry.organizationId === where.organizationId &&
            entry.branchId === where.branchId &&
            where.batch!.medicineId.in.includes(entry.batch.medicineId)
        )
      ),
    },
    packLevel: {
      findMany: vi.fn(async () =>
        medicines.flatMap((entry) =>
          entry.presentations.map((presentation) => ({
            id: `pack-${entry.id}${presentation.id === `p-${entry.id}` ? '' : '-other'}`,
            level: 'BOX',
            parentPackLevelId: null,
            unitsPerParent: 10,
            presentationId: presentation.id,
            effectiveFrom: new Date('2025-01-01'),
            effectiveTo: null,
            versionGroupId: `v-${presentation.id}`,
          }))
        )
      ),
    },
    medicinePackMrp: { findMany: vi.fn(async () => []) },
    pharmacyStockBalance: {
      findMany: vi.fn(async ({ where }: Args) =>
        balances.filter(
          (entry) =>
            entry.organizationId === where.organizationId &&
            entry.branchId === where.branchId &&
            where.inventoryLotId!.in.includes(entry.inventoryLotId)
        )
      ),
    },
    pharmacyStockLocation: {
      findMany: vi.fn(async () => [
        { id: 'rack-a', kind: 'RACK_BIN', code: 'A1', name: 'Rack A1' },
      ]),
    },
  };
  return {
    db,
    balances,
    search: () => searchCounterCatalog(db as never, scope, { query: 'Nalbin', at }),
  };
}

describe('DEV-878 automatic out-of-stock search alternatives', () => {
  it('returns an in-stock brand on the first search without a source lot or price, using normal counter rows', async () => {
    const f = fixture();
    const { rows } = await f.search();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ displayName: 'Nalbin', onHandUnits: 0, printedMrpMinor: null });
    expect(rows[0]!.stockAlternatives).toMatchObject({
      ingredientRecorded: true,
      other: [],
      exact: [
        {
          medicineId: 'alternative',
          presentationId: 'p-alternative',
          brandName: 'alternative',
          strength: '10 mg',
          dosageForm: 'Tablet',
          presentation: 'Box of 10',
          unitsPerPack: 10,
          printedMrpMinor: 2000,
          onHandUnits: 30,
          recommendedLotId: 'safe',
          restriction: { rx: true },
          // Labelled as an ingredient match, not as a name hit on the typed query.
          matchedOn: 'INGREDIENT',
        },
      ],
    });
    expect(rows[0]!.stockAlternatives!.exact[0]!.saleUnits.length).toBeGreaterThan(0);
    expect(f.db.medicine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-a',
          saleable: true,
          strengths: { every: { ingredientId: { in: ['salt-a'] } } },
          AND: [{ strengths: { some: { ingredientId: 'salt-a' } } }],
          batches: {
            some: {
              state: 'ACTIVE',
              // DEV-853: an unrecorded expiry is never treated as expired.
              OR: [{ expiresAt: null }, { expiresAt: { gt: at } }],
              lots: {
                some: {
                  branchId: 'branch-a',
                  receivedAt: { not: null, lte: at },
                  balances: { some: { disposition: 'AVAILABLE', onHandUnits: { gt: 0 } } },
                },
              },
            },
          },
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 21,
      })
    );
  });

  it('requires the exact ingredient SET and per-ingredient strengths, independent of component order', async () => {
    const source = medicine('requested', [component(), component('salt-b', '5')]);
    const reordered = medicine('reordered', [
      component('salt-b', '5.00'),
      component('salt-a', '10'),
    ]);
    const missing = medicine('missing', [component()]);
    const extra = medicine('extra', [...source.strengths, component('salt-c')]);
    const different = medicine('different', [component('salt-z'), component('salt-b', '5')]);
    const swapped = medicine('swapped', [component('salt-a', '5'), component('salt-b', '10')]);
    const form = medicine('form', source.strengths, 'Injection');
    const f = fixture(
      [source, reordered, missing, extra, different, swapped, form],
      [reordered, missing, extra, different, swapped, form].map((entry) =>
        lot(`lot-${entry.id}`, entry.id)
      )
    );
    const result = (await f.search()).rows[0]!.stockAlternatives!;
    expect(result.exact.map((entry) => entry.medicineId)).toEqual(['reordered']);
    expect(result.other.map((entry) => entry.medicineId)).toEqual(['form', 'swapped']);
  });

  it('quotes the lot the sale writer would allocate and never calls a mixed-form medicine exact', async () => {
    // The add-line path allocates FEFO across every presentation of a medicine, so a
    // tablet quote must not hide an earlier-expiring injection lot that would be sold.
    const candidate = medicine('alternative');
    candidate.presentations.push({
      ...candidate.presentations[0]!,
      id: 'p-other',
      dosageForm: 'Injection',
      route: 'IV',
    });
    const injectionLot = {
      ...lot('injection-lot', 'alternative', '2026-12-15', 9000),
      packLevelId: 'pack-alternative-other',
    };
    const f = fixture(
      [medicine('requested'), candidate],
      [lot('tablet-lot', 'alternative'), injectionLot]
    );
    const result = (await f.search()).rows[0]!.stockAlternatives!;
    expect(result.exact).toEqual([]);
    expect(result.other).toHaveLength(1);
    expect(result.other[0]).toMatchObject({
      medicineId: 'alternative',
      recommendedLotId: 'injection-lot',
      presentationId: 'p-other',
      printedMrpMinor: 9000,
      onHandUnits: 60,
    });
  });

  it('never calls a suggestion exact when the requested medicine itself has several forms', async () => {
    const requested = medicine('requested');
    requested.presentations.push({
      ...requested.presentations[0]!,
      id: 'p-requested-injection',
      dosageForm: 'Injection',
      route: 'IV',
    });
    const f = fixture([requested, medicine('alternative')]);
    const result = (await f.search()).rows[0]!.stockAlternatives!;
    expect(result.exact).toEqual([]);
    expect(result.other.map((entry) => entry.medicineId)).toEqual(['alternative']);
  });

  it('bounds each ingredient set separately so one common salt cannot hide another', async () => {
    const common = Array.from(
      { length: 25 },
      (_, index) => `a-common-${String(index).padStart(2, '0')}`
    );
    const f = fixture(
      [
        medicine('requested'),
        medicine('requested-b', [component('salt-b')]),
        ...common.map((id) => medicine(id)),
        medicine('z-salt-b-brand', [component('salt-b')]),
      ],
      [...common.map((id) => lot(`lot-${id}`, id)), lot('lot-salt-b', 'z-salt-b-brand')]
    );
    f.db.medicineAlias.findMany.mockResolvedValueOnce([
      { medicineId: 'requested' },
      { medicineId: 'requested-b' },
    ] as never);
    const rows = (await f.search()).rows;
    const a = rows.find((row) => row.medicineId === 'requested')!.stockAlternatives!;
    const b = rows.find((row) => row.medicineId === 'requested-b')!.stockAlternatives!;
    // The salt-b brand sorts after every salt-a brand, yet still reaches its own match.
    expect(b.exact.map((entry) => entry.medicineId)).toEqual(['z-salt-b-brand']);
    expect(b.truncated).toBe(false);
    expect(a.exact).toHaveLength(20);
    expect(a.truncated).toBe(true);
  });

  it('separates a different route even when the form matches', async () => {
    const candidate = medicine('alternative');
    candidate.presentations[0]!.route = 'Sublingual';
    const f = fixture([medicine('requested'), candidate]);
    const result = (await f.search()).rows[0]!.stockAlternatives!;
    expect(result.exact).toEqual([]);
    expect(result.other.map((entry) => entry.medicineId)).toEqual(['alternative']);
  });

  it('sorts FEFO first, then pack price, including brands more expensive than the source', async () => {
    const ids = ['later-cheap', 'early-expensive', 'early-cheap'];
    const f = fixture(
      [medicine('requested'), ...ids.map((id) => medicine(id))],
      [
        lot('old-source', 'requested', '2026-01-01', 100),
        lot('later', ids[0]!, '2028-01-01', 200),
        lot('early-high', ids[1]!, '2027-01-01', 5000),
        lot('early-low', ids[2]!, '2027-01-01', 3000),
        lot('early-low-cheaper', ids[2]!, '2027-01-01', 2500),
      ]
    );
    const exact = (await f.search()).rows[0]!.stockAlternatives!.exact;
    expect(exact.map((entry) => entry.medicineId)).toEqual([
      'early-cheap',
      'early-expensive',
      'later-cheap',
    ]);
    // Within one brand, preserve the sale writer's FEFO/id tie-break so the
    // displayed price comes from the lot the normal add-line path will use.
    expect(exact[0]!.recommendedLotId).toBe('early-low');
    expect(exact[0]!.printedMrpMinor).toBe(3000);
  });

  it('quotes the oldest receipt first among equal-expiry lots, as the sale allocator does', async () => {
    const older = { ...lot('z-older', 'alternative', '2027-01-01', 1800) };
    older.receivedAt = new Date('2026-10-01T00:00:00Z');
    const newer = { ...lot('a-newer', 'alternative', '2027-01-01', 2600) };
    newer.receivedAt = new Date('2026-11-01T00:00:00Z');
    const f = fixture(undefined, [newer, older]);
    const [alternative] = (await f.search()).rows[0]!.stockAlternatives!.exact;
    expect(alternative).toMatchObject({ recommendedLotId: 'z-older', printedMrpMinor: 1800 });
  });

  it('breaks an expiry tie on price per unit, not on the whole-pack price', async () => {
    const f = fixture(
      [medicine('requested'), medicine('small-pack'), medicine('large-pack')],
      [
        { ...lot('small', 'small-pack', '2027-01-01', 1500), unitsPerPack: 10 },
        { ...lot('large', 'large-pack', '2027-01-01', 3000), unitsPerPack: 30 },
      ]
    );
    const exact = (await f.search()).rows[0]!.stockAlternatives!.exact;
    // 100 per unit beats 150 per unit even though its pack MRP is higher.
    expect(exact.map((entry) => entry.medicineId)).toEqual(['large-pack', 'small-pack']);
  });

  it.each([
    'expired',
    'expiry-boundary',
    'recalled',
    'quarantined',
    'damaged',
    'unreceived',
    'empty',
    'other-branch',
    'other-tenant',
    'unpublished',
  ])('excludes %s stock', async (kind) => {
    const candidate = medicine('alternative');
    const stock = lot('unsafe', 'alternative');
    if (kind === 'expired') stock.batch.expiresAt = new Date('2026-01-01');
    if (kind === 'expiry-boundary') stock.batch.expiresAt = at;
    if (kind === 'recalled') stock.batch.state = 'RECALLED';
    if (kind === 'unreceived') stock.receivedAt = null;
    if (kind === 'other-branch') stock.branchId = 'branch-b';
    if (kind === 'other-tenant') {
      stock.organizationId = 'org-b';
      candidate.organizationId = 'org-b';
    }
    if (kind === 'unpublished') candidate.saleable = false;
    const f = fixture([medicine('requested'), candidate], [stock]);
    if (kind === 'quarantined') f.balances[0]!.disposition = 'QUARANTINE';
    if (kind === 'damaged') f.balances[0]!.disposition = 'DAMAGED';
    if (kind === 'empty') f.balances[0]!.onHandUnits = 0;
    const result = (await f.search()).rows[0]!.stockAlternatives!;
    expect(result).toEqual({ ingredientRecorded: true, exact: [], other: [], truncated: false });
    for (const call of f.db.pharmacyInventoryLot.findMany.mock.calls)
      expect(call[0].where).toMatchObject(scope);
    for (const call of f.db.pharmacyStockBalance.findMany.mock.calls)
      expect(call[0].where).toMatchObject(scope);
  });

  it('records the ingredient gap, never treating two empty ingredient lists as equivalent', async () => {
    const f = fixture([medicine('requested', []), medicine('alternative', [])]);
    expect((await f.search()).rows[0]!.stockAlternatives).toEqual({
      ingredientRecorded: false,
      exact: [],
      other: [],
      truncated: false,
    });
    expect(f.db.pharmacyInventoryLot.findMany).toHaveBeenCalledTimes(1);
  });

  it('does not load suggestions for an in-stock search match', async () => {
    const f = fixture(undefined, [lot('source', 'requested'), lot('safe', 'alternative')]);
    expect((await f.search()).rows[0]!.stockAlternatives).toBeUndefined();
    expect(f.db.pharmacyInventoryLot.findMany).toHaveBeenCalledTimes(1);
  });
});
