import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/abac', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/abac')>();
  return { ...actual, can: vi.fn(actual.can) };
});

import { can, type Subject } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  catalogMedicineDetail,
  setCatalogDefaultPrices,
  setCatalogMedicineAvailability,
  setCatalogPackPrice,
  type CatalogPackPriceInput,
} from './commercial';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
type RawRow = Record<string, unknown>;
type Query = { strings: readonly string[]; values: readonly unknown[] };

const OWNER: Rule = { capability: 'pharmacy:*', effect: 'ALLOW' };
const SETTINGS_ALLOW: Rule = { capability: 'pharmacy:catalog-settings', effect: 'ALLOW' };
const SETTINGS_DENY: Rule = { capability: 'pharmacy:catalog-settings', effect: 'DENY' };

/** Each case is the user's organization-role rules and user-level override rules. */
const GRANTS = {
  OWNER: { role: [OWNER], user: [] },
  NO_GRANT: { role: [{ capability: 'pharmacy:manage', effect: 'ALLOW' }], user: [] },
  ROLE_DENY: { role: [OWNER, SETTINGS_DENY], user: [] },
  USER_DENY: { role: [OWNER], user: [SETTINGS_DENY] },
  // CAT-SEC-01 conflicting-grant permutations.
  USER_DENY_ROLE_ALLOW: { role: [SETTINGS_ALLOW], user: [SETTINGS_DENY] },
  USER_ALLOW_ROLE_DENY: { role: [OWNER, SETTINGS_DENY], user: [SETTINGS_ALLOW] },
} satisfies Record<string, { role: Rule[]; user: Rule[] }>;
type Grant = keyof typeof GRANTS | 'MISSING_USER' | 'LOOKUP_ERROR';

const subject: Subject = { id: 'user-a', role: 'EMPLOYEE', status: 'ACTIVE' };
const actor = { organizationId: 'org-a', subject };
const BRANCH = 'branch-a';

function sqlOf(query: unknown): string {
  return (query as Query).strings.join('?');
}

/** The JSON payload of a set-based statement, or null. */
function payloadOf(query: unknown): unknown[] | null {
  const json = (query as Query).values.find(
    (value) => typeof value === 'string' && value.startsWith('[')
  );
  return typeof json === 'string' ? (JSON.parse(json) as unknown[]) : null;
}

type State = {
  grant?: Grant;
  assigned?: boolean;
  boundBranch?: string;
  setting?: boolean;
  medicine?: { saleable: boolean; catalogSellingPriceCount: number };
  pack?: { effectiveTo: Date | null } | null;
  /** This branch's row for pack-a in the per-pack writer. */
  priceRow?: { sellingPriceMinor: number | null; purchasePriceMinor: number | null } | null;
  /** Bulk targets and this branch's existing rows for them. */
  bulkPacks?: RawRow[];
  bulkExisting?: RawRow[];
  pricedInBranch?: boolean;
  /** Override the affected-row count of the set-based price statements. */
  affected?: (sql: string, rows: number) => number;
  executeError?: (sql: string) => unknown;
};

/** A tenant database double that records every statement in order. */
function fakeDb(state: State = {}) {
  const grant = state.grant ?? 'OWNER';
  const statements: string[] = [];
  const writes: string[] = [];
  const mock = {
    $transaction: vi.fn(async (work: (tx: ScopedDb) => Promise<unknown>) => work(db)),
    user: {
      findUnique: vi.fn(async () => {
        if (grant === 'LOOKUP_ERROR') throw new Error('connection reset');
        if (grant === 'MISSING_USER') return null;
        return {
          organizationRole: { permissions: GRANTS[grant].role },
          permissionOverrides: GRANTS[grant].user,
        };
      }),
    },
    pharmacyBranchAssignment: {
      findFirst: vi.fn(async () => (state.assigned === false ? null : { id: 'assignment-a' })),
    },
    $queryRaw: vi.fn(async (query: unknown): Promise<RawRow[]> => {
      const sql = sqlOf(query);
      statements.push(sql);
      if (sql.includes("current_setting('app.current_branch_id'"))
        return [{ branch: state.boundBranch ?? '' }];
      if (sql.includes('set_config')) return [{}];
      if (sql.includes('FROM "pharmacy_catalog_branch_settings"'))
        return [{ useCatalogDefaultPrices: state.setting ?? false }];
      if (sql.includes('AS "packLevelId"')) return state.bulkPacks ?? [];
      if (sql.includes('SELECT presentation."medicineId"')) return [{ medicineId: 'med-a' }];
      if (sql.includes('FOR NO KEY UPDATE OF medicine'))
        return [...new Set((state.bulkPacks ?? []).map((pack) => pack.medicineId))].map((id) => ({
          id,
        }));
      if (sql.includes('FOR NO KEY UPDATE'))
        return [
          {
            id: 'med-a',
            ...(state.medicine ?? { saleable: false, catalogSellingPriceCount: 0 }),
          },
        ];
      if (sql.includes('SELECT pack."id", pack."effectiveTo"'))
        return state.pack === null ? [] : [{ id: 'pack-a', effectiveTo: null, ...state.pack }];
      if (sql.includes('"packLevelId" = ANY(')) return state.bulkExisting ?? [];
      if (sql.includes('FROM "pharmacy_catalog_branch_prices"') && sql.includes('FOR UPDATE'))
        return state.priceRow ? [{ id: 'price-a', packLevelId: 'pack-a', ...state.priceRow }] : [];
      if (sql.includes('price."sellingPriceMinor" > 0'))
        return state.pricedInBranch ? [{ id: 'price-a' }] : [];
      return [];
    }),
    $executeRaw: vi.fn(async (query: unknown) => {
      const sql = sqlOf(query);
      statements.push(sql);
      const failure = state.executeError?.(sql);
      if (failure) throw failure;
      if (!sql.includes('ON CONFLICT')) writes.push(sql);
      const rows = payloadOf(query)?.length ?? 1;
      return state.affected ? state.affected(sql, rows) : rows;
    }),
    medicine: {
      findFirst: vi.fn(async () => null as unknown),
      update: vi.fn(async () => {
        writes.push('medicine.update');
        return {};
      }),
    },
    pharmacyCatalogBranchPrice: { findMany: vi.fn(async () => []) },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        writes.push('audit');
        return args;
      }),
    },
  };
  const db = mock as unknown as ScopedDb;
  return { db, mock, statements, writes };
}

const priceInput: CatalogPackPriceInput = {
  branchId: BRANCH,
  packLevelId: 'pack-a',
  sellingPriceMinor: 1500,
  purchasePriceMinor: null,
  expected: { sellingPriceMinor: null, purchasePriceMinor: null },
};

const writers = [
  [
    'setCatalogDefaultPrices',
    (db: ScopedDb) => setCatalogDefaultPrices(db, actor, { branchId: BRANCH, enabled: true }),
  ],
  ['setCatalogPackPrice', (db: ScopedDb) => setCatalogPackPrice(db, actor, priceInput)],
  [
    'setCatalogMedicineAvailability',
    (db: ScopedDb) =>
      setCatalogMedicineAvailability(db, actor, {
        branchId: BRANCH,
        medicineId: 'med-a',
        saleable: false,
      }),
  ],
] as const;

/** A state in which every writer would succeed once authorized. */
const WRITABLE: State = {
  medicine: { saleable: true, catalogSellingPriceCount: 2 },
  bulkPacks: [
    { packLevelId: 'pack-a', medicineId: 'med-a', defaultSale: 1200, defaultPurchase: 900 },
  ],
};

function expectNothingTouched(fake: ReturnType<typeof fakeDb>) {
  expect(fake.mock.$queryRaw).not.toHaveBeenCalled();
  expect(fake.mock.$executeRaw).not.toHaveBeenCalled();
  expect(fake.mock.medicine.update).not.toHaveBeenCalled();
  expect(fake.mock.auditLog.create).not.toHaveBeenCalled();
  expect(fake.writes).toEqual([]);
}

afterEach(() => {
  vi.mocked(can).mockClear();
  vi.restoreAllMocks();
});

describe.each(writers)('%s authorization (CAT-SEC-01)', (_name, run) => {
  it.each(['NO_GRANT', 'ROLE_DENY', 'USER_DENY', 'MISSING_USER', 'LOOKUP_ERROR'] as const)(
    'fails closed with FORBIDDEN for %s before any read or write',
    async (grant) => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const fake = fakeDb({ ...WRITABLE, grant });
      await expect(run(fake.db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(fake.mock.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'user-a' } })
      );
      expectNothingTouched(fake);
    }
  );

  it('denies user DENY + role ALLOW (conflicting grants), with no settings, price or audit write', async () => {
    const fake = fakeDb({ ...WRITABLE, grant: 'USER_DENY_ROLE_ALLOW' });
    await expect(run(fake.db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expectNothingTouched(fake);
  });

  // KNOWN central defect, fixed on fix/abac-deny-precedence (6b120a50), which this branch
  // does not contain: customDecision() in src/lib/abac/index.ts returns on a user ALLOW
  // before it reads the role DENY. Proven to pass on a local merge with 6b120a50; flip this
  // `it.fails` to `it` once that fix is on the base branch.
  it.fails(
    'denies user ALLOW + role DENY (conflicting grants), with no settings, price or audit write [needs 6b120a50]',
    async () => {
      const fake = fakeDb({ ...WRITABLE, grant: 'USER_ALLOW_ROLE_DENY' });
      await expect(run(fake.db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expectNothingTouched(fake);
    }
  );

  it('refuses a caller who is not assigned to the branch, before any catalogue read or write', async () => {
    const fake = fakeDb({ ...WRITABLE, assigned: false });
    await expect(run(fake.db)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Branch is outside your scope.',
    });
    expect(fake.mock.pharmacyBranchAssignment.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-a',
        branchId: BRANCH,
        userId: 'user-a',
        active: true,
        branch: { organizationId: 'org-a', active: true },
      },
      select: { id: true },
    });
    expectNothingTouched(fake);
  });

  it('refuses a transaction already bound to another branch, before any write', async () => {
    const fake = fakeDb({ ...WRITABLE, boundBranch: 'branch-b' });
    await expect(run(fake.db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fake.mock.$executeRaw).not.toHaveBeenCalled();
    expect(fake.mock.auditLog.create).not.toHaveBeenCalled();
  });

  it('decides through the central can() with the branch as a resource attribute', async () => {
    const fake = fakeDb(WRITABLE);
    await run(fake.db);
    expect(can).toHaveBeenCalledWith(
      subject,
      'pharmacy:catalog-settings',
      { type: 'PharmacyCatalogBranch', organizationId: 'org-a', branchId: BRANCH },
      { db: fake.db }
    );
  });

  it('binds the branch for its RLS before the first catalogue statement and restores it after', async () => {
    const fake = fakeDb(WRITABLE);
    await run(fake.db);
    const binds = fake.statements
      .map((sql, index) => ({ sql, index }))
      .filter(({ sql }) => sql.includes("set_config('app.current_branch_id'"));
    expect(binds).toHaveLength(2);
    expect(binds[0]!.index).toBe(1);
    expect(binds[1]!.index).toBe(fake.statements.length - 1);
  });
});

describe('catalogMedicineDetail authorization', () => {
  it.each(['NO_GRANT', 'USER_DENY_ROLE_ALLOW', 'MISSING_USER'] as const)(
    'refuses %s before reading prices',
    async (grant) => {
      const fake = fakeDb({ grant });
      await expect(
        catalogMedicineDetail(fake.db, actor, { branchId: BRANCH, medicineId: 'med-a' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(fake.mock.medicine.findFirst).not.toHaveBeenCalled();
      expect(fake.mock.pharmacyCatalogBranchPrice.findMany).not.toHaveBeenCalled();
    }
  );

  it('reads only the requested branch prices', async () => {
    const fake = fakeDb();
    fake.mock.medicine.findFirst.mockResolvedValue({ id: 'med-a', presentations: [] });
    await catalogMedicineDetail(fake.db, actor, { branchId: BRANCH, medicineId: 'med-a' });
    expect(fake.mock.pharmacyCatalogBranchPrice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-a', branchId: BRANCH, medicineId: 'med-a' },
      })
    );
  });
});

describe('setCatalogDefaultPrices: one branch, one transaction, all or nothing (CAT-SEC-03/04)', () => {
  const packs = [
    { packLevelId: 'pack-1', medicineId: 'med-1', defaultSale: 1200, defaultPurchase: 900 },
    { packLevelId: 'pack-2', medicineId: 'med-1', defaultSale: null, defaultPurchase: 400 },
    { packLevelId: 'pack-3', medicineId: 'med-2', defaultSale: 800, defaultPurchase: null },
  ];

  it('locks setting, medicines, packs and branch rows in that order, then writes one statement per kind', async () => {
    const fake = fakeDb({
      bulkPacks: packs,
      bulkExisting: [
        { id: 'row-3', packLevelId: 'pack-3', sellingPriceMinor: null, purchasePriceMinor: 50 },
      ],
    });
    const result = await setCatalogDefaultPrices(fake.db, actor, {
      branchId: BRANCH,
      enabled: true,
    });
    expect(result).toEqual({
      branchId: BRANCH,
      enabled: true,
      changed: true,
      created: 2,
      filled: 1,
      saleApplied: 2,
      purchaseApplied: 2,
    });
    const order = [
      'FROM "pharmacy_catalog_branch_settings"',
      'FOR NO KEY UPDATE OF medicine',
      'FOR SHARE OF pack',
      '"packLevelId" = ANY(',
      'INSERT INTO "pharmacy_catalog_branch_prices"',
      'UPDATE "pharmacy_catalog_branch_prices" price',
    ].map((marker) => fake.statements.findIndex((sql) => sql.includes(marker)));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(
      fake.statements.find(
        (sql) => sql.includes('pharmacy_catalog_branch_settings') && sql.includes('SELECT')
      )
    ).toContain('FOR UPDATE');
    // Set-based: one INSERT and one fill UPDATE for the whole target set.
    const inserts = fake.mock.$executeRaw.mock.calls.filter(([query]) =>
      sqlOf(query).includes('INSERT INTO "pharmacy_catalog_branch_prices"')
    );
    const fills = fake.mock.$executeRaw.mock.calls.filter(([query]) =>
      sqlOf(query).includes('UPDATE "pharmacy_catalog_branch_prices"')
    );
    expect(inserts).toHaveLength(1);
    expect(fills).toHaveLength(1);
    expect(payloadOf(inserts[0]![0])).toEqual([
      { packLevelId: 'pack-1', medicineId: 'med-1', selling: 1200, purchase: 900 },
      { packLevelId: 'pack-2', medicineId: 'med-1', selling: null, purchase: 400 },
    ]);
    // Only the empty selling price is filled; the branch's own purchase price stays.
    expect(payloadOf(fills[0]![0])).toEqual([{ id: 'row-3', selling: 800, purchase: null }]);
    expect(sqlOf(fills[0]![0])).toContain('COALESCE(price."sellingPriceMinor"');
    expect((inserts[0]![0] as Query).values).toContain(BRANCH);
    expect(fake.mock.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-a',
        actorId: 'user-a',
        action: 'pharmacyCatalog.setDefaultPrices',
        targetId: BRANCH,
        metadata: { branchId: BRANCH },
        changes: { branchId: BRANCH, useCatalogDefaultPrices: { from: false, to: true } },
      }),
    });
    // The audit is the last write of the transaction.
    expect(fake.writes.at(-1)).toBe('audit');
  });

  it('fails the whole application with CONFLICT when a row appears between lock and write', async () => {
    const fake = fakeDb({
      bulkPacks: packs,
      executeError: (sql) =>
        sql.includes('INSERT INTO "pharmacy_catalog_branch_prices"')
          ? Object.assign(new Error('duplicate key value violates unique constraint'), {
              code: 'P2010',
              meta: { code: '23505' },
            })
          : null,
    });
    await expect(
      setCatalogDefaultPrices(fake.db, actor, { branchId: BRANCH, enabled: true })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fake.mock.auditLog.create).not.toHaveBeenCalled();
  });

  it('fails with CONFLICT when a set-based write reaches fewer rows than it locked', async () => {
    const fake = fakeDb({
      bulkPacks: packs,
      affected: (sql, rows) => (sql.includes('INSERT INTO') ? rows - 1 : rows),
    });
    await expect(
      setCatalogDefaultPrices(fake.db, actor, { branchId: BRANCH, enabled: true })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fake.mock.auditLog.create).not.toHaveBeenCalled();
  });

  it('propagates a failed audit insert out of the transaction', async () => {
    const fake = fakeDb({ bulkPacks: packs });
    fake.mock.auditLog.create.mockRejectedValueOnce(new Error('audit insert failed'));
    await expect(
      setCatalogDefaultPrices(fake.db, actor, { branchId: BRANCH, enabled: true })
    ).rejects.toThrow('audit insert failed');
    expect(fake.mock.$transaction).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a retry with nothing left to apply writes nothing and records no audit', async () => {
    const fake = fakeDb({
      setting: true,
      bulkPacks: packs,
      bulkExisting: [
        { id: 'row-1', packLevelId: 'pack-1', sellingPriceMinor: 1200, purchasePriceMinor: 900 },
        { id: 'row-2', packLevelId: 'pack-2', sellingPriceMinor: null, purchasePriceMinor: 400 },
        { id: 'row-3', packLevelId: 'pack-3', sellingPriceMinor: 800, purchasePriceMinor: 50 },
      ],
    });
    await expect(
      setCatalogDefaultPrices(fake.db, actor, { branchId: BRANCH, enabled: true })
    ).resolves.toMatchObject({ changed: false, created: 0, filled: 0 });
    expect(fake.writes).toEqual([]);
  });

  it('turning the setting off never touches a price', async () => {
    const fake = fakeDb({ setting: true, bulkPacks: packs });
    await expect(
      setCatalogDefaultPrices(fake.db, actor, { branchId: BRANCH, enabled: false })
    ).resolves.toMatchObject({ changed: true, created: 0, filled: 0 });
    expect(fake.writes.filter((sql) => sql.includes('pharmacy_catalog_branch_prices'))).toEqual([]);
    expect(fake.writes).toEqual([
      expect.stringContaining('UPDATE "pharmacy_catalog_branch_settings"'),
      'audit',
    ]);
  });
});

describe('setCatalogPackPrice: branch compare-and-set (CAT-SEC-03/04)', () => {
  it('rejects a stale expected price with CONFLICT and writes nothing', async () => {
    const fake = fakeDb({ priceRow: { sellingPriceMinor: 1200, purchasePriceMinor: null } });
    await expect(setCatalogPackPrice(fake.db, actor, priceInput)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(fake.writes).toEqual([]);
  });

  it('locks setting, medicine, pack and branch row in that order and inserts this branch only', async () => {
    const fake = fakeDb();
    await expect(setCatalogPackPrice(fake.db, actor, priceInput)).resolves.toMatchObject({
      branchId: BRANCH,
      packLevelId: 'pack-a',
      sellingPriceMinor: 1500,
      changed: true,
    });
    const order = [
      'FROM "pharmacy_catalog_branch_settings"',
      'FOR NO KEY UPDATE',
      'FOR SHARE OF pack',
      'FROM "pharmacy_catalog_branch_prices"',
      'INSERT INTO "pharmacy_catalog_branch_prices"',
    ].map((marker) => fake.statements.findIndex((sql) => sql.includes(marker)));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const insert = fake.mock.$executeRaw.mock.calls.find(([query]) =>
      sqlOf(query).includes('INSERT INTO "pharmacy_catalog_branch_prices"')
    )!;
    expect((insert[0] as Query).values).toEqual(
      expect.arrayContaining(['org-a', BRANCH, 'pack-a'])
    );
    expect(fake.writes).toEqual([expect.stringContaining('INSERT INTO'), 'audit']);
    expect(fake.mock.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        targetId: `${BRANCH}:pack-a`,
        metadata: { branchId: BRANCH },
        changes: expect.objectContaining({ branchId: BRANCH, packLevelId: 'pack-a' }),
      }),
    });
  });

  it('updates an existing branch row only where the expected values still hold', async () => {
    const fake = fakeDb({ priceRow: { sellingPriceMinor: 1200, purchasePriceMinor: null } });
    await setCatalogPackPrice(fake.db, actor, {
      ...priceInput,
      expected: { sellingPriceMinor: 1200, purchasePriceMinor: null },
    });
    const update = fake.writes.find((sql) =>
      sql.includes('UPDATE "pharmacy_catalog_branch_prices"')
    )!;
    expect(update).toContain('"branchId" = ');
    expect(update).toContain('"sellingPriceMinor" IS NOT DISTINCT FROM');
    expect(update).toContain('"purchasePriceMinor" IS NOT DISTINCT FROM');
  });

  it('turns a lost compare-and-set into CONFLICT', async () => {
    const fake = fakeDb({
      priceRow: { sellingPriceMinor: 1200, purchasePriceMinor: null },
      affected: () => 0,
    });
    await expect(
      setCatalogPackPrice(fake.db, actor, {
        ...priceInput,
        expected: { sellingPriceMinor: 1200, purchasePriceMinor: null },
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fake.mock.auditLog.create).not.toHaveBeenCalled();
  });

  it('is idempotent: an identical retry writes nothing and records no second audit', async () => {
    const fake = fakeDb({ priceRow: { sellingPriceMinor: 1500, purchasePriceMinor: null } });
    await expect(setCatalogPackPrice(fake.db, actor, priceInput)).resolves.toMatchObject({
      changed: false,
    });
    expect(fake.writes).toEqual([]);
  });

  it('refuses to price a superseded pack version', async () => {
    const fake = fakeDb({ pack: { effectiveTo: new Date(0) } });
    await expect(setCatalogPackPrice(fake.db, actor, priceInput)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(fake.writes).toEqual([]);
  });

  it('refuses to remove the last branch selling price of a saleable catalogue medicine', async () => {
    const fake = fakeDb({
      medicine: { saleable: true, catalogSellingPriceCount: 1 },
      priceRow: { sellingPriceMinor: 1500, purchasePriceMinor: null },
    });
    await expect(
      setCatalogPackPrice(fake.db, actor, {
        ...priceInput,
        sellingPriceMinor: null,
        expected: { sellingPriceMinor: 1500, purchasePriceMinor: null },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(fake.writes).toEqual([]);
  });

  it('lets a branch remove its price while another branch still prices the medicine', async () => {
    const fake = fakeDb({
      medicine: { saleable: true, catalogSellingPriceCount: 2 },
      priceRow: { sellingPriceMinor: 1500, purchasePriceMinor: null },
    });
    await expect(
      setCatalogPackPrice(fake.db, actor, {
        ...priceInput,
        sellingPriceMinor: null,
        expected: { sellingPriceMinor: 1500, purchasePriceMinor: null },
      })
    ).resolves.toMatchObject({ changed: true, sellingPriceMinor: null });
  });
});

describe('setCatalogMedicineAvailability', () => {
  const makeSaleable = { branchId: BRANCH, medicineId: 'med-a', saleable: true };

  it('needs a positive current-pack selling price in the caller branch', async () => {
    const fake = fakeDb({ pricedInBranch: false });
    await expect(
      setCatalogMedicineAvailability(fake.db, actor, makeSaleable)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const priced = fake.statements.find((sql) => sql.includes('price."sellingPriceMinor" > 0'))!;
    expect(priced).toContain('price."branchId" = ');
    expect(priced).toContain('pack."effectiveTo" IS NULL');
    expect(fake.writes).toEqual([]);
  });

  it('still applies the regulated saleability rules when a price exists', async () => {
    const fake = fakeDb({ pricedInBranch: true });
    fake.mock.medicine.findFirst.mockResolvedValue({
      productFamily: 'PHARMACEUTICAL',
      drapRegistrationNumber: null,
      presentations: [{ id: 'pres-a' }],
      strengths: [],
      provenance: [],
    });
    await expect(
      setCatalogMedicineAvailability(fake.db, actor, makeSaleable)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(fake.writes).toEqual([]);
  });

  it('makes a reviewed, branch-priced catalogue medicine saleable and audits it with the branch', async () => {
    const fake = fakeDb({ pricedInBranch: true });
    fake.mock.medicine.findFirst.mockResolvedValue({
      productFamily: 'PHARMACEUTICAL',
      drapRegistrationNumber: 'DRAP-1',
      presentations: [{ id: 'pres-a' }],
      strengths: [{ id: 'strength-a' }],
      provenance: [{ field: 'drapRegistrationNumber' }],
    });
    await expect(setCatalogMedicineAvailability(fake.db, actor, makeSaleable)).resolves.toEqual({
      branchId: BRANCH,
      medicineId: 'med-a',
      saleable: true,
      changed: true,
    });
    expect(fake.mock.medicine.update).toHaveBeenCalledWith({
      where: { id: 'med-a' },
      data: { saleable: true },
    });
    expect(fake.writes).toEqual(['medicine.update', 'audit']);
    expect(fake.mock.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ metadata: { branchId: BRANCH } }),
    });
  });

  it('is idempotent when the availability already matches', async () => {
    const fake = fakeDb({ medicine: { saleable: true, catalogSellingPriceCount: 1 } });
    await expect(
      setCatalogMedicineAvailability(fake.db, actor, makeSaleable)
    ).resolves.toMatchObject({ changed: false });
    expect(fake.writes).toEqual([]);
  });
});
