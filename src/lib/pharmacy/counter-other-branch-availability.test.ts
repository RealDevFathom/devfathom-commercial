import { describe, expect, it, vi } from 'vitest';
import { readOtherBranchAvailability, searchCounterCatalog } from './counter';

// DEV-907: the owner-enabled "also in stock at another branch" line. The line is
// computed on the server only when the owner's switch is passed in, names
// branches of the same organization only, never covers a controlled drug, and
// carries no quantity, price, batch or customer of the other branch.

const at = new Date('2026-11-18T00:00:00Z');
const scope = { organizationId: 'org-a', branchId: 'branch-a' };

type Medicine = { id: string; organizationId: string; controlled: boolean };
type Branch = { id: string; organizationId: string; name: string; active: boolean };
type Lot = {
  id: string;
  organizationId: string;
  branchId: string;
  medicineId: string;
  receivedAt: Date | null;
  state: string;
  /** DEV-853: null when the expiry was never recorded. */
  expiresAt: Date | null;
  disposition: string;
  onHandUnits: number;
};

const catalogue: Medicine[] = [
  { id: 'nalbin', organizationId: 'org-a', controlled: false },
  { id: 'morphine', organizationId: 'org-a', controlled: true },
  { id: 'stocked', organizationId: 'org-a', controlled: false },
  // Another organization's medicine of the same id never reaches org-a's reads.
  { id: 'nalbin', organizationId: 'org-b', controlled: false },
];
const defaultBranches: Branch[] = [
  { id: 'branch-a', organizationId: 'org-a', name: 'Main', active: true },
  { id: 'branch-g', organizationId: 'org-a', name: 'Gulberg', active: true },
  { id: 'branch-d', organizationId: 'org-a', name: 'DHA', active: true },
  { id: 'branch-x', organizationId: 'org-a', name: 'Closed', active: false },
  { id: 'branch-r', organizationId: 'org-b', name: 'Rival', active: true },
];
function stock(id: string, branchId: string, medicineId: string, extra: Partial<Lot> = {}): Lot {
  const organizationId = branchId === 'branch-r' ? 'org-b' : 'org-a';
  return {
    id,
    organizationId,
    branchId,
    medicineId,
    receivedAt: new Date('2026-11-01T00:00:00Z'),
    state: 'ACTIVE',
    expiresAt: new Date('2027-06-01T00:00:00Z'),
    disposition: 'AVAILABLE',
    onHandUnits: 20,
    ...extra,
  };
}
const defaultLots: Lot[] = [
  stock('g-nalbin', 'branch-g', 'nalbin'),
  stock('r-nalbin', 'branch-r', 'nalbin'),
  stock('x-nalbin', 'branch-x', 'nalbin'),
  stock('g-morphine', 'branch-g', 'morphine'),
  stock('d-morphine', 'branch-d', 'morphine'),
  stock('a-stocked', 'branch-a', 'stocked'),
  stock('g-stocked', 'branch-g', 'stocked'),
  // Not sellable-looking: expired, recalled, quarantined, empty, unreceived.
  stock('d-expired', 'branch-d', 'nalbin', { expiresAt: new Date('2026-10-01T00:00:00Z') }),
  stock('d-recalled', 'branch-d', 'nalbin', { state: 'RECALLED' }),
  stock('d-quarantine', 'branch-d', 'nalbin', { disposition: 'QUARANTINE' }),
  stock('d-empty', 'branch-d', 'nalbin', { onHandUnits: 0 }),
  stock('d-unreceived', 'branch-d', 'nalbin', { receivedAt: null }),
];

type LotFilter = {
  organizationId: string;
  receivedAt: { not: null; lte: Date };
  batch: {
    organizationId: string;
    medicineId: { in: string[] };
    state: string;
    OR: [{ expiresAt: null }, { expiresAt: { gt: Date } }];
    medicine: { organizationId: string; controlled: boolean };
  };
  balances: {
    some: { organizationId: string; disposition: string; onHandUnits: { gt: number } };
  };
};
type BranchArgs = {
  where: {
    organizationId: string;
    active: boolean;
    id: { not: string };
    inventoryLots: { some: LotFilter };
  };
  select: { inventoryLots: { where: LotFilter } };
};

/** Evaluates the stored-data filter the way Postgres would, so the test checks the query. */
function matchesLot(lot: Lot, filter: LotFilter, medicines: Medicine[]) {
  const medicine = medicines.find(
    (entry) => entry.id === lot.medicineId && entry.organizationId === lot.organizationId
  );
  return (
    lot.organizationId === filter.organizationId &&
    lot.receivedAt !== null &&
    lot.receivedAt <= filter.receivedAt.lte &&
    lot.organizationId === filter.batch.organizationId &&
    filter.batch.medicineId.in.includes(lot.medicineId) &&
    lot.state === filter.batch.state &&
    (lot.expiresAt === null || lot.expiresAt > filter.batch.OR[1].expiresAt.gt) &&
    medicine !== undefined &&
    medicine.organizationId === filter.batch.medicine.organizationId &&
    medicine.controlled === filter.batch.medicine.controlled &&
    lot.organizationId === filter.balances.some.organizationId &&
    lot.disposition === filter.balances.some.disposition &&
    lot.onHandUnits > filter.balances.some.onHandUnits.gt
  );
}

function branchDb(branches = defaultBranches, lots = defaultLots, medicines = catalogue) {
  return {
    findMany: vi.fn(async ({ where, select }: BranchArgs) =>
      branches
        .filter(
          (branch) =>
            branch.organizationId === where.organizationId &&
            branch.active === where.active &&
            branch.id !== where.id.not &&
            lots.some(
              (lot) =>
                lot.branchId === branch.id && matchesLot(lot, where.inventoryLots.some, medicines)
            )
        )
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((branch) => ({
          id: branch.id,
          name: branch.name,
          inventoryLots: lots
            .filter(
              (lot) =>
                lot.branchId === branch.id && matchesLot(lot, select.inventoryLots.where, medicines)
            )
            .map((lot) => ({ batch: { medicineId: lot.medicineId } })),
        }))
    ),
  };
}

function counterMedicine(id: string, controlled = false) {
  return {
    id,
    organizationId: 'org-a',
    productName: id,
    brandName: id,
    manufacturer: null,
    saleable: true,
    strengths: [],
    rx: false,
    otc: true,
    restricted: false,
    controlled,
    highAlert: false,
    lasa: false,
    coldChain: false,
    presentations: [
      { id: `p-${id}`, presentation: 'Box of 10', dosageForm: 'Tablet', route: 'Oral' },
    ],
  };
}

function fixture(branches = defaultBranches, lots = defaultLots) {
  const medicines = [
    counterMedicine('nalbin'),
    counterMedicine('morphine', true),
    counterMedicine('stocked'),
  ];
  const local = lots.filter((lot) => lot.branchId === scope.branchId);
  const db = {
    medicineBarcode: { findFirst: vi.fn(async () => null) },
    medicineAlias: { findMany: vi.fn(async () => []) },
    medicineStrengthComponent: { findMany: vi.fn(async () => []) },
    presentation: { findMany: vi.fn(async () => []) },
    medicine: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        where.id
          ? medicines.filter((entry) => where.id!.in.includes(entry.id))
          : medicines.map(({ id }) => ({ id }))
      ),
    },
    pharmacyInventoryLot: {
      findMany: vi.fn(async () =>
        local.map((lot) => ({
          id: lot.id,
          packLevelId: `pack-${lot.medicineId}`,
          unitsPerPack: 10,
          printedMrpMinor: 2000,
          receivedAt: lot.receivedAt,
          batch: {
            batchNumber: lot.id,
            expiresAt: lot.expiresAt,
            state: lot.state,
            medicineId: lot.medicineId,
          },
        }))
      ),
    },
    packLevel: {
      findMany: vi.fn(async () =>
        medicines.map((entry) => ({
          id: `pack-${entry.id}`,
          level: 'BOX',
          parentPackLevelId: null,
          unitsPerParent: 10,
          presentationId: `p-${entry.id}`,
          effectiveFrom: new Date('2025-01-01'),
          effectiveTo: null,
          versionGroupId: `v-${entry.id}`,
        }))
      ),
    },
    medicinePackMrp: { findMany: vi.fn(async () => []) },
    // DEV-957 phase 2: no units are set aside for an offline counter in these cases.
    pharmacyDeviceLotQuota: { findMany: vi.fn(async () => []) },
    pharmacyStockBalance: {
      findMany: vi.fn(async () =>
        local.map((lot) => ({
          inventoryLotId: lot.id,
          stockLocationId: 'rack-a',
          disposition: lot.disposition,
          onHandUnits: lot.onHandUnits,
        }))
      ),
    },
    pharmacyStockLocation: {
      findMany: vi.fn(async () => [
        { id: 'rack-a', kind: 'RACK_BIN', code: 'A1', name: 'Rack A1' },
      ]),
    },
    pharmacyBranch: branchDb(branches, lots),
  };
  const search = (otherBranchAvailability?: boolean) =>
    searchCounterCatalog(db as never, scope, { query: 'na', at, otherBranchAvailability });
  const row = async (medicineId: string, enabled?: boolean) =>
    (await search(enabled)).rows.find((entry) => entry.medicineId === medicineId)!;
  return { db, search, row };
}

describe('DEV-907 other-branch availability at the counter', () => {
  it('changes nothing on the counter while the owner switch is off', async () => {
    for (const enabled of [undefined, false]) {
      const f = fixture();
      const { rows } = await f.search(enabled);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).not.toHaveProperty('otherBranchAvailability');
      expect(f.db.pharmacyBranch.findMany).not.toHaveBeenCalled();
    }
  });

  it('names another active branch of the same organization for an out-of-stock item', async () => {
    const f = fixture();
    const row = await f.row('nalbin', true);
    expect(row.onHandUnits).toBe(0);
    expect(row.otherBranchAvailability).toEqual({ branchNames: ['Gulberg'], more: false });
  });

  it("never shows another organization's stock, an inactive branch or this branch", async () => {
    const f = fixture();
    const names = (await f.row('nalbin', true)).otherBranchAvailability!.branchNames;
    expect(names).not.toContain('Rival');
    expect(names).not.toContain('Closed');
    expect(names).not.toContain('Main');
    expect(f.db.pharmacyBranch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-a',
          active: true,
          id: { not: 'branch-a' },
        }),
      })
    );
    // With only the other organization holding stock, there is no line at all.
    const rival = fixture(defaultBranches, [stock('r-nalbin', 'branch-r', 'nalbin')]);
    expect(await rival.row('nalbin', true)).not.toHaveProperty('otherBranchAvailability');
  });

  it('ignores expired, recalled, quarantined, empty and unreceived stock elsewhere', async () => {
    const f = fixture(
      defaultBranches,
      defaultLots.filter((lot) => lot.id.startsWith('d-'))
    );
    expect(await f.row('nalbin', true)).not.toHaveProperty('otherBranchAvailability');
  });

  it('DEV-853: names a branch whose stock has no recorded expiry, never treating it as expired', async () => {
    const f = fixture(defaultBranches, [
      stock('d-legacy', 'branch-d', 'nalbin', { expiresAt: null }),
      stock('g-expired', 'branch-g', 'nalbin', { expiresAt: new Date('2026-10-01T00:00:00Z') }),
    ]);
    expect((await f.row('nalbin', true)).otherBranchAvailability).toEqual({
      branchNames: ['DHA'],
      more: false,
    });
    for (const [args] of f.db.pharmacyBranch.findMany.mock.calls) {
      expect(args.where.inventoryLots.some.batch.OR).toEqual([
        { expiresAt: null },
        { expiresAt: { gt: expect.any(Date) } },
      ]);
    }
  });

  it('never shows a controlled drug, even when another branch holds it', async () => {
    const f = fixture();
    const row = await f.row('morphine', true);
    expect(row.restriction.controlled).toBe(true);
    expect(row).not.toHaveProperty('otherBranchAvailability');
    for (const [args] of f.db.pharmacyBranch.findMany.mock.calls) {
      expect(args.where.inventoryLots.some.batch.medicineId.in).not.toContain('morphine');
    }
    // The stored controlled flag is checked in the read itself, too: asked
    // directly about a controlled medicine, the read finds no branch.
    const direct = await readOtherBranchAvailability(
      { pharmacyBranch: branchDb() } as never,
      scope,
      ['morphine'],
      at
    );
    expect(direct.size).toBe(0);
  });

  it('gives a cashier branch names only: no quantity, price, batch, lot or customer', async () => {
    const f = fixture();
    const row = await f.row('nalbin', true);
    expect(Object.keys(row.otherBranchAvailability!).sort()).toEqual(['branchNames', 'more']);
    for (const name of row.otherBranchAvailability!.branchNames) expect(typeof name).toBe('string');
    const [args] = f.db.pharmacyBranch.findMany.mock.calls[0]!;
    expect(args.select).toEqual({
      id: true,
      name: true,
      inventoryLots: {
        where: args.where.inventoryLots.some,
        select: { batch: { select: { medicineId: true } } },
      },
    });
  });

  it('adds no line to an item this branch can sell', async () => {
    const f = fixture();
    const row = await f.row('stocked', true);
    expect(row.onHandUnits).toBeGreaterThan(0);
    expect(row).not.toHaveProperty('otherBranchAvailability');
  });

  it('names at most three branches and says when more hold it', async () => {
    const many: Branch[] = ['B1', 'B2', 'B3', 'B4'].map((name) => ({
      id: `branch-${name}`,
      organizationId: 'org-a',
      name,
      active: true,
    }));
    const f = fixture(
      [...defaultBranches, ...many],
      [...defaultLots, ...many.map((branch) => stock(`${branch.id}-nalbin`, branch.id, 'nalbin'))]
    );
    expect((await f.row('nalbin', true)).otherBranchAvailability).toEqual({
      branchNames: ['B1', 'B2', 'B3'],
      more: true,
    });
  });
});
