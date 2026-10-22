/**
 * Catalogue preload hold fix (round 2), against migrated PostgreSQL with FORCED
 * row level security, as a NOSUPERUSER NOBYPASSRLS role. Skipped (never
 * silently passed) when TEST_DATABASE_URL is absent.
 *
 *   CAT-SEC-01  Every catalogue write path refuses conflicting grants and changes
 *               nothing: no setting, price or audit row. User ALLOW + role DENY
 *               needs the central fix on fix/abac-deny-precedence (6b120a50), so
 *               those cases are `it.fails` here; they pass on a merge with it.
 *   CAT-SEC-02  The platform backfill (central can() for the modeled platform
 *               actor) and the onboarding job seed reference rows only.
 *   CAT-SEC-03  Applied prices and the default-price setting are branch-scoped:
 *               writers, RLS USING / WITH CHECK, and cross-branch denials.
 *   CAT-SEC-04  One transaction per writer: a failed price write and a failed
 *               audit insert roll everything back; retries are idempotent.
 *
 * An expected database error aborts its transaction, so a case that provokes one
 * reads back from a new transaction.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Subject } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { PharmacyCatalog } from './preload';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

// The backfill loads the private bundled asset. These cases need only its shape
// (every source row `active: true`), so a synthetic catalogue stands in for it.
const fixtures = vi.hoisted(() => {
  const items = Array.from({ length: 6 }, (_, index) => ({
    name: `Synthetic catalogue ${index}`,
    alias: `SYN-${index}`,
    active: true,
    packUnits: 'tablet',
    packQty: 10,
    class: index === 0 ? 'NARCOTICS' : 'GENERAL',
    category: 'synthetic',
    defaultSalePriceMinor: index === 5 ? null : 1_000 + index * 100,
    defaultPurchasePriceMinor: index === 5 ? null : 700 + index * 100,
  }));
  return { catalog: { version: 'pharmacy-catalog-v1' as const, count: items.length, items } };
});
vi.mock('./preload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./preload')>();
  return { ...actual, loadBundledPharmacyCatalog: vi.fn(async () => fixtures.catalog) };
});

const CATALOG: PharmacyCatalog = fixtures.catalog;
/** Items 0-4 carry a default sale and purchase price; item 5 carries neither. */
const DEFAULTED = 5;
const suffix = randomBytes(5).toString('hex');
const ORG = {
  main: `org_cat2_m_${suffix}`,
  other: `org_cat2_o_${suffix}`,
  mixed: `org_cat2_x_${suffix}`,
  tx: `org_cat2_t_${suffix}`,
  job: `org_cat2_j_${suffix}`,
  backfill: `org_cat2_k_${suffix}`,
};
const BRANCH = {
  a: `br_cat2_a_${suffix}`,
  b: `br_cat2_b_${suffix}`,
  denied: `br_cat2_d_${suffix}`,
  closed: `br_cat2_c_${suffix}`,
  other: `br_cat2_o_${suffix}`,
  mixed: `br_cat2_x_${suffix}`,
  t1: `br_cat2_t1_${suffix}`,
  t2: `br_cat2_t2_${suffix}`,
  t3: `br_cat2_t3_${suffix}`,
  t4: `br_cat2_t4_${suffix}`,
  t5: `br_cat2_t5_${suffix}`,
};
const USER = {
  ownerA: `user_cat2_owner_a_${suffix}`,
  ownerB: `user_cat2_owner_b_${suffix}`,
  ownerAB: `user_cat2_owner_ab_${suffix}`,
  observer: `user_cat2_observer_${suffix}`,
  manager: `user_cat2_manager_${suffix}`,
  roleDenied: `user_cat2_roledeny_${suffix}`,
  userDenied: `user_cat2_userdeny_${suffix}`,
  unassignedAdmin: `user_cat2_admin_${suffix}`,
  inactive: `user_cat2_inactive_${suffix}`,
  pharmacist: `user_cat2_pharmacist_${suffix}`,
  ownerO: `user_cat2_owner_o_${suffix}`,
  observerO: `user_cat2_observer_o_${suffix}`,
  mixedAllow: `user_cat2_mixed_${suffix}`,
  observerX: `user_cat2_observer_x_${suffix}`,
  ownerT: `user_cat2_owner_t_${suffix}`,
  writerT: `user_cat2_writer_t_${suffix}`,
  observerT: `user_cat2_observer_t_${suffix}`,
};

type Scoped = typeof import('@/lib/tenancy/scoped-db');
type Commercial = typeof import('./commercial');
type Router = (typeof import('@/server/routers/pharmacy-medicine'))['pharmacyMedicineRouter'];
type Api = ReturnType<Router['createCaller']>;
type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };

let scoped: Scoped;
let commercial: Commercial;
let preload: typeof import('./preload');
let backfill: typeof import('./backfill');
let medicineRouter: Router;
let disconnect: (() => Promise<void>) | null = null;

function subject(id: string): Subject {
  return { id, role: 'EMPLOYEE', department: 'LEADERSHIP', status: 'ACTIVE' };
}

function actorOf(organizationId: string, userId: string) {
  return { organizationId, subject: subject(userId) };
}

/** A tenant transaction acting as `userId` (withTenantDb sets app.current_user_id). */
function inOrg<T>(
  organizationId: string,
  work: (db: ScopedDb) => Promise<T>,
  userId?: string
): Promise<T> {
  return scoped.withTenantDb(organizationId, work, { timeout: 60_000, userId });
}

/** Run work that is EXPECTED to fail in its own transaction; resolves to the error message. */
async function rejection(
  organizationId: string,
  work: (db: ScopedDb) => Promise<unknown>,
  userId?: string
) {
  return inOrg(organizationId, work, userId).then(
    () => 'ACCEPTED: the write was expected to fail',
    (error: Error) => error.message
  );
}

function caller(db: ScopedDb, organizationId: string, userId: string, role = 'EMPLOYEE'): Api {
  return medicineRouter.createCaller({
    db,
    entitlements: {
      organizationId,
      enabledModules: ['pharmacy-core'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: { id: userId, role, department: 'LEADERSHIP', status: 'ACTIVE', organizationId },
    },
    organization: { id: organizationId, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

function act<T>(
  organizationId: string,
  userId: string,
  run: (api: Api) => Promise<T>,
  role = 'EMPLOYEE'
) {
  return inOrg(organizationId, (db) => run(caller(db, organizationId, userId, role)), userId);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/**
 * Run `work` in a transaction, signal once it returns (its locks are held), keep
 * the transaction open for `ms`, then commit.
 */
async function holding<T>(
  organizationId: string,
  work: (db: ScopedDb) => Promise<T>,
  held: () => void,
  ms = 500,
  userId?: string
): Promise<{ value: T; committedAt: number }> {
  const value = await inOrg(
    organizationId,
    async (db) => {
      const result = await work(db);
      held();
      await db.$executeRawUnsafe(`SELECT pg_sleep(${ms / 1000})`);
      return result;
    },
    userId
  );
  return { value, committedAt: Date.now() };
}

/** The writer's database, except that its audit insert fails inside PostgreSQL. */
function withFailingAudit(db: ScopedDb): ScopedDb {
  const proxy: ScopedDb = new Proxy(db, {
    get(target, key) {
      if (key === '$transaction') {
        return (work: (tx: ScopedDb) => Promise<unknown>) => target.$transaction(() => work(proxy));
      }
      if (key === 'auditLog') {
        return {
          // A NOT NULL violation: a real failed INSERT that aborts the transaction.
          create: async () =>
            target.$executeRawUnsafe(
              `INSERT INTO "audit_logs" ("id", "source", "category", "action")
               VALUES (NULL, 'TRPC', 'PHARMACY', 'pharmacyCatalog.forcedFailure')`
            ),
        };
      }
      return Reflect.get(target, key) as unknown;
    },
  });
  return proxy;
}

type CatalogMedicine = { id: string; name: string; packId: string };

/** Each catalogue medicine with the seeded (version 1) pack of its seeded presentation. */
async function catalogMedicines(organizationId: string): Promise<CatalogMedicine[]> {
  const medicines = await inOrg(organizationId, (db) =>
    db.medicine.findMany({
      where: { catalogVersion: CATALOG.version },
      select: {
        id: true,
        productName: true,
        presentations: {
          select: {
            packLevels: { where: { version: 1 }, orderBy: { id: 'asc' }, select: { id: true } },
          },
        },
      },
    })
  );
  return medicines
    .map((medicine) => ({
      id: medicine.id,
      name: medicine.productName,
      packId: medicine.presentations.find((presentation) => presentation.packLevels.length > 0)!
        .packLevels[0]!.id,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

const OBSERVER: Record<string, string> = {};

/** Everything a branch holds, read by a user assigned to every branch of the tenant. */
async function branchState(organizationId: string, branchId: string) {
  return inOrg(
    organizationId,
    async (db) => ({
      setting: await db.pharmacyCatalogBranchSetting.findFirst({
        where: { branchId },
        select: { useCatalogDefaultPrices: true, enabledById: true },
      }),
      prices: await db.pharmacyCatalogBranchPrice.findMany({
        where: { branchId },
        orderBy: { packLevelId: 'asc' },
        select: {
          id: true,
          packLevelId: true,
          medicineId: true,
          sellingPriceMinor: true,
          purchasePriceMinor: true,
        },
      }),
      audits: await db.auditLog.count({
        where: {
          action: { startsWith: 'pharmacyCatalog.' },
          metadata: { path: ['branchId'], equals: branchId },
        },
      }),
    }),
    OBSERVER[organizationId]
  );
}

/** The organization-wide coverage counts. */
async function coverage(organizationId: string) {
  return inOrg(organizationId, async (db) => ({
    medicines: await db.medicine.findMany({
      where: { catalogVersion: CATALOG.version },
      orderBy: { id: 'asc' },
      select: { id: true, saleable: true, catalogSellingPriceCount: true },
    }),
    packs: await db.packLevel.findMany({
      where: { presentation: { medicine: { catalogVersion: CATALOG.version } } },
      orderBy: { id: 'asc' },
      select: { id: true, catalogSellingPriceCount: true },
    }),
  }));
}

/** The counts equal the positive branch selling prices the observer sees, everywhere. */
async function expectCoverageConsistent(organizationId: string) {
  const rows = await inOrg(
    organizationId,
    (db) =>
      db.pharmacyCatalogBranchPrice.findMany({
        select: { medicineId: true, packLevelId: true, sellingPriceMinor: true },
      }),
    OBSERVER[organizationId]
  );
  const { medicines, packs } = await coverage(organizationId);
  const priced = rows.filter((row) => (row.sellingPriceMinor ?? 0) > 0);
  for (const medicine of medicines) {
    expect(medicine.catalogSellingPriceCount).toBe(
      priced.filter((row) => row.medicineId === medicine.id).length
    );
    if (medicine.saleable) expect(medicine.catalogSellingPriceCount).toBeGreaterThan(0);
  }
  for (const pack of packs) {
    expect(pack.catalogSellingPriceCount).toBe(
      priced.filter((row) => row.packLevelId === pack.id).length
    );
  }
}

/** Strength, DRAP registration and its accepted provenance: what `assertSaleable` needs. */
async function meetRegulatedRules(organizationId: string, medicineId: string, label: string) {
  await inOrg(organizationId, async (db) => {
    const ingredient = await db.ingredient.create({ data: { name: `Ingredient ${label}` } });
    await db.medicineStrengthComponent.create({
      data: { medicineId, ingredientId: ingredient.id, value: 500, unit: 'mg' },
    });
    await db.medicine.update({
      where: { id: medicineId },
      data: { drapRegistrationNumber: `DRAP-${label}` },
    });
    await db.medicineProvenance.create({
      data: {
        medicineId,
        field: 'drapRegistrationNumber',
        source: 'regulator-register',
        sourceType: 'REGULATOR',
        retrievedAt: new Date('2026-10-01T00:00:00.000Z'),
        reviewer: USER.pharmacist,
        status: 'ACCEPTED',
        assertedValue: { value: `DRAP-${label}` },
      },
    });
  });
}

type Person = {
  id: string;
  role?: Rule[];
  overrides?: Rule[];
  branches?: string[];
  inactiveBranches?: string[];
};

async function createTenant(
  organizationId: string,
  branches: { id: string; active?: boolean }[],
  people: Person[]
) {
  await scoped.withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, 'Catalogue fixture', 'Catalogue fixture', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      organizationId
    )
  );
  const { seedDepartments } = await import('@/lib/test-support/departments');
  await inOrg(organizationId, async (db) => {
    await seedDepartments(db, [organizationId], ['LEADERSHIP']);
    for (const [index, branch] of branches.entries()) {
      await db.pharmacyBranch.create({
        data: {
          id: branch.id,
          code: `B${index}`,
          name: `Branch ${index}`,
          addressLine: '1 Road',
          city: 'Lahore',
          provinceCode: 'PB',
          active: branch.active ?? true,
        },
      });
    }
    for (const person of people) {
      const role = await db.organizationRole.create({
        data: {
          key: `role-${person.id}`,
          name: `Role ${person.id}`,
          permissions: { create: person.role ?? [] },
        },
      });
      await db.user.create({
        data: {
          id: person.id,
          name: person.id,
          email: `${person.id}@example.test`,
          department: 'LEADERSHIP',
          title: 'Fixture',
          role: 'EMPLOYEE',
          organizationRoleId: role.id,
        },
      });
      for (const rule of person.overrides ?? []) {
        await db.userPermissionOverride.create({
          data: { userId: person.id, ...rule, reason: 'fixture: conflicting grant' },
        });
      }
      for (const branchId of person.branches ?? []) {
        await db.pharmacyBranchAssignment.create({ data: { userId: person.id, branchId } });
      }
      for (const branchId of person.inactiveBranches ?? []) {
        await db.pharmacyBranchAssignment.create({
          data: { userId: person.id, branchId, active: false },
        });
      }
    }
  });
}

const OWNER_GRANTS: Rule[] = [{ capability: 'pharmacy:*', effect: 'ALLOW' }];
const SETTINGS_DENY: Rule = { capability: 'pharmacy:catalog-settings', effect: 'DENY' };
const SETTINGS_ALLOW: Rule = { capability: 'pharmacy:catalog-settings', effect: 'ALLOW' };
const T_BRANCHES = [BRANCH.t1, BRANCH.t2, BRANCH.t3, BRANCH.t4, BRANCH.t5];

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  scoped = await import('@/lib/tenancy/scoped-db');
  commercial = await import('./commercial');
  preload = await import('./preload');
  backfill = await import('./backfill');
  medicineRouter = (await import('@/server/routers/pharmacy-medicine')).pharmacyMedicineRouter;
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  const { db } = await import('@/lib/db');
  disconnect = () => db.$disconnect();
  await assertRlsEnforcingRole(scoped.withPlatformDb);

  OBSERVER[ORG.main] = USER.observer;
  OBSERVER[ORG.other] = USER.observerO;
  OBSERVER[ORG.mixed] = USER.observerX;
  OBSERVER[ORG.tx] = USER.observerT;

  await createTenant(
    ORG.main,
    [
      { id: BRANCH.a },
      { id: BRANCH.b },
      { id: BRANCH.denied },
      { id: BRANCH.closed, active: false },
    ],
    [
      { id: USER.ownerA, role: OWNER_GRANTS, branches: [BRANCH.a] },
      { id: USER.ownerB, role: OWNER_GRANTS, branches: [BRANCH.b] },
      { id: USER.ownerAB, role: OWNER_GRANTS, branches: [BRANCH.a, BRANCH.b, BRANCH.closed] },
      { id: USER.observer, branches: [BRANCH.a, BRANCH.b, BRANCH.denied, BRANCH.closed] },
      {
        id: USER.manager,
        role: [{ capability: 'pharmacy:manage', effect: 'ALLOW' }],
        branches: [BRANCH.denied],
      },
      { id: USER.roleDenied, role: [...OWNER_GRANTS, SETTINGS_DENY], branches: [BRANCH.denied] },
      // CAT-SEC-01: user DENY + role ALLOW.
      {
        id: USER.userDenied,
        role: OWNER_GRANTS,
        overrides: [SETTINGS_DENY],
        branches: [BRANCH.denied],
      },
      { id: USER.unassignedAdmin, role: OWNER_GRANTS },
      { id: USER.inactive, role: OWNER_GRANTS, inactiveBranches: [BRANCH.a] },
      { id: USER.pharmacist, role: [{ capability: 'pharmacy:catalogue-review', effect: 'ALLOW' }] },
    ]
  );
  await createTenant(
    ORG.other,
    [{ id: BRANCH.other }],
    [
      { id: USER.ownerO, role: OWNER_GRANTS, branches: [BRANCH.other] },
      { id: USER.observerO, branches: [BRANCH.other] },
    ]
  );
  // CAT-SEC-01: user ALLOW + role DENY, isolated because the central defect lets it write.
  await createTenant(
    ORG.mixed,
    [{ id: BRANCH.mixed }],
    [
      {
        id: USER.mixedAllow,
        role: [...OWNER_GRANTS, SETTINGS_DENY],
        overrides: [SETTINGS_ALLOW],
        branches: [BRANCH.mixed],
      },
      { id: USER.observerX, branches: [BRANCH.mixed] },
    ]
  );
  await createTenant(
    ORG.tx,
    T_BRANCHES.map((id) => ({ id })),
    [
      { id: USER.ownerT, role: OWNER_GRANTS, branches: T_BRANCHES },
      { id: USER.writerT, role: OWNER_GRANTS, branches: T_BRANCHES },
      { id: USER.observerT, branches: T_BRANCHES },
    ]
  );
  await createTenant(ORG.job, [], []);
  await createTenant(ORG.backfill, [], []);
  for (const organizationId of [ORG.main, ORG.other, ORG.mixed, ORG.tx]) {
    await inOrg(organizationId, (db) => preload.seedPharmacyCatalog(db, organizationId, CATALOG));
  }
}, 240_000);

afterAll(async () => {
  await disconnect?.();
});

type Actor = ReturnType<typeof actorOf>;
type ProcedureWrite = readonly [string, (api: Api) => Promise<unknown>];
type DirectWrite = readonly [string, (db: ScopedDb, actor: Actor) => Promise<unknown>];

/** The three catalogue write paths, through the real procedures. */
function procedureWrites(branchId: string, medicine: CatalogMedicine): readonly ProcedureWrite[] {
  return [
    [
      'setCatalogDefaultPrices',
      (api: Api) => api.setCatalogDefaultPrices({ branchId, enabled: true }),
    ],
    [
      'setCatalogPackPrice',
      (api: Api) =>
        api.setCatalogPackPrice({
          branchId,
          packLevelId: medicine.packId,
          sellingPriceMinor: 999,
          purchasePriceMinor: null,
          expected: { sellingPriceMinor: null, purchasePriceMinor: null },
        }),
    ],
    [
      'setCatalogMedicineAvailability',
      (api: Api) =>
        api.setCatalogMedicineAvailability({ branchId, medicineId: medicine.id, saleable: true }),
    ],
  ];
}

/** The same three write paths, calling the writers directly (the in-writer check). */
function directWrites(branchId: string, medicine: CatalogMedicine): readonly DirectWrite[] {
  return [
    [
      'setCatalogDefaultPrices',
      (db: ScopedDb, actor: Actor) =>
        commercial.setCatalogDefaultPrices(db, actor, { branchId, enabled: true }),
    ],
    [
      'setCatalogPackPrice',
      (db: ScopedDb, actor: Actor) =>
        commercial.setCatalogPackPrice(db, actor, {
          branchId,
          packLevelId: medicine.packId,
          sellingPriceMinor: 999,
          purchasePriceMinor: null,
          expected: { sellingPriceMinor: null, purchasePriceMinor: null },
        }),
    ],
    [
      'setCatalogMedicineAvailability',
      (db: ScopedDb, actor: Actor) =>
        commercial.setCatalogMedicineAvailability(db, actor, {
          branchId,
          medicineId: medicine.id,
          saleable: true,
        }),
    ],
  ];
}

async function expectBranchUntouched(organizationId: string, branchId: string) {
  expect(await branchState(organizationId, branchId)).toEqual({
    setting: null,
    prices: [],
    audits: 0,
  });
  const { medicines, packs } = await coverage(organizationId);
  expect(medicines.every((medicine) => !medicine.saleable)).toBe(true);
  expect(medicines.every((medicine) => medicine.catalogSellingPriceCount === 0)).toBe(true);
  expect(packs.every((pack) => pack.catalogSellingPriceCount === 0)).toBe(true);
}

describeIfDatabase(
  'CAT-SEC-01: conflicting grants on every catalogue write path',
  { timeout: 120_000 },
  () => {
    it('refuses no grant, a role DENY and user DENY + role ALLOW, through the procedures and the writers, writing nothing', async () => {
      const [medicine] = await catalogMedicines(ORG.main);
      for (const userId of [USER.manager, USER.roleDenied, USER.userDenied]) {
        for (const [, write] of procedureWrites(BRANCH.denied, medicine!)) {
          await expect(act(ORG.main, userId, write)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        }
        await expect(
          act(ORG.main, userId, (api) =>
            api.catalogMedicine({ branchId: BRANCH.denied, medicineId: medicine!.id })
          )
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        for (const [, write] of directWrites(BRANCH.denied, medicine!)) {
          await expect(
            inOrg(ORG.main, (db) => write(db, actorOf(ORG.main, userId)), userId)
          ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        }
      }
      await expectBranchUntouched(ORG.main, BRANCH.denied);
    });

    // KNOWN central defect, fixed on fix/abac-deny-precedence (6b120a50), which this branch
    // does not contain: customDecision() in src/lib/abac/index.ts returns on the user ALLOW
    // before it reads the role DENY, so these writes go through here. Each case passes on a
    // local merge with 6b120a50; flip `it.fails` to `it` once that fix is on the base.
    for (const [name] of procedureWrites(BRANCH.mixed, { id: '', name: '', packId: '' })) {
      it.fails(
        `user ALLOW + role DENY is refused on ${name} and writes nothing [needs 6b120a50]`,
        async () => {
          const [medicine] = await catalogMedicines(ORG.mixed);
          const procedure = procedureWrites(BRANCH.mixed, medicine!).find(([key]) => key === name)!;
          const direct = directWrites(BRANCH.mixed, medicine!).find(([key]) => key === name)!;
          await expect(act(ORG.mixed, USER.mixedAllow, procedure[1])).rejects.toMatchObject({
            code: 'FORBIDDEN',
          });
          await expect(
            inOrg(
              ORG.mixed,
              (db) => direct[1](db, actorOf(ORG.mixed, USER.mixedAllow)),
              USER.mixedAllow
            )
          ).rejects.toMatchObject({ code: 'FORBIDDEN' });
          await expectBranchUntouched(ORG.mixed, BRANCH.mixed);
        }
      );
    }
  }
);

describeIfDatabase(
  'CAT-SEC-03: applied prices and the setting are branch-scoped',
  { timeout: 120_000 },
  () => {
    it('prices each branch independently and reads back only the requested branch', async () => {
      const medicine = (await catalogMedicines(ORG.main))[1]!;
      const price = (userId: string, branchId: string, selling: number) =>
        inOrg(
          ORG.main,
          (db) =>
            commercial.setCatalogPackPrice(db, actorOf(ORG.main, userId), {
              branchId,
              packLevelId: medicine.packId,
              sellingPriceMinor: selling,
              purchasePriceMinor: selling - 300,
              expected: { sellingPriceMinor: null, purchasePriceMinor: null },
            }),
          userId
        );
      await price(USER.ownerA, BRANCH.a, 1_000);
      await price(USER.ownerB, BRANCH.b, 2_000);
      const detail = (userId: string, branchId: string) =>
        act(ORG.main, userId, (api) => api.catalogMedicine({ branchId, medicineId: medicine.id }));
      expect((await detail(USER.ownerA, BRANCH.a)).presentations[0]!.packLevels[0]).toMatchObject({
        sellingPriceMinor: 1_000,
        purchasePriceMinor: 700,
      });
      expect((await detail(USER.ownerB, BRANCH.b)).presentations[0]!.packLevels[0]).toMatchObject({
        sellingPriceMinor: 2_000,
        purchasePriceMinor: 1_700,
      });
      // Two branches price this pack; each audit names its branch.
      const { medicines } = await coverage(ORG.main);
      expect(medicines.find((row) => row.id === medicine.id)!.catalogSellingPriceCount).toBe(2);
      expect((await branchState(ORG.main, BRANCH.a)).audits).toBeGreaterThanOrEqual(1);
      expect((await branchState(ORG.main, BRANCH.b)).audits).toBeGreaterThanOrEqual(1);
      await expectCoverageConsistent(ORG.main);
    });

    it('refuses every write and read for a branch the caller is not assigned to, and for an unassigned administrator', async () => {
      const medicine = (await catalogMedicines(ORG.main))[1]!;
      const before = await branchState(ORG.main, BRANCH.b);
      for (const [, write] of procedureWrites(BRANCH.b, medicine)) {
        await expect(act(ORG.main, USER.ownerA, write)).rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: 'Branch is outside your scope.',
        });
        // No administrator bypass: the session role ADMIN without an assignment is refused.
        await expect(act(ORG.main, USER.unassignedAdmin, write, 'ADMIN')).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
      }
      await expect(
        act(ORG.main, USER.ownerA, (api) =>
          api.catalogMedicine({ branchId: BRANCH.b, medicineId: medicine.id })
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await branchState(ORG.main, BRANCH.b)).toEqual(before);
    });

    it('refuses an inactive assignment, an inactive branch and another tenant’s branch', async () => {
      const medicine = (await catalogMedicines(ORG.main))[1]!;
      for (const [, write] of procedureWrites(BRANCH.a, medicine)) {
        await expect(act(ORG.main, USER.inactive, write)).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
      }
      for (const [, write] of procedureWrites(BRANCH.closed, medicine)) {
        await expect(act(ORG.main, USER.ownerAB, write)).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
      }
      // Another tenant's owner, with another tenant's branch id: assignment and RLS both miss.
      const [foreign] = await catalogMedicines(ORG.other);
      for (const [, write] of procedureWrites(BRANCH.other, foreign!)) {
        await expect(act(ORG.main, USER.ownerA, write)).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
      }
      expect((await branchState(ORG.other, BRANCH.other)).prices).toEqual([]);
    });

    it('applying defaults in one branch writes that branch only', async () => {
      const before = await branchState(ORG.tx, BRANCH.t5);
      const result = await inOrg(
        ORG.tx,
        (db) =>
          commercial.setCatalogDefaultPrices(db, actorOf(ORG.tx, USER.ownerT), {
            branchId: BRANCH.t4,
            enabled: true,
          }),
        USER.ownerT
      );
      expect(result).toMatchObject({ changed: true, created: DEFAULTED, filled: 0 });
      const t4 = await branchState(ORG.tx, BRANCH.t4);
      expect(t4.setting).toEqual({ useCatalogDefaultPrices: true, enabledById: USER.ownerT });
      expect(t4.prices).toHaveLength(DEFAULTED);
      expect(t4.audits).toBe(1);
      expect(await branchState(ORG.tx, BRANCH.t5)).toEqual(before);
      await expectCoverageConsistent(ORG.tx);
    });

    it('enforces the branch boundary in RLS itself (USING and WITH CHECK)', async () => {
      const medicine = (await catalogMedicines(ORG.main))[1]!;
      const count = (userId: string | undefined, bind?: string) =>
        inOrg(
          ORG.main,
          async (db) => {
            if (bind)
              await db.$queryRawUnsafe(
                `SELECT set_config('app.current_branch_id', $1, true)`,
                bind
              );
            const rows = await db.$queryRawUnsafe<{ branchId: string }[]>(
              `SELECT "branchId" FROM "pharmacy_catalog_branch_prices" WHERE "medicineId" = $1`,
              medicine.id
            );
            return rows.map((row) => row.branchId).sort();
          },
          userId
        );
      expect(await count(USER.ownerAB)).toEqual([BRANCH.a, BRANCH.b].sort());
      expect(await count(USER.ownerA)).toEqual([BRANCH.a]);
      // A bound branch confines even a user assigned to both.
      expect(await count(USER.ownerAB, BRANCH.a)).toEqual([BRANCH.a]);
      // No user (a platform job, the backfill) sees nothing.
      expect(await count(undefined)).toEqual([]);
      expect(await count(USER.unassignedAdmin)).toEqual([]);

      // WITH CHECK: an assigned-to-A user cannot write a row for B, even with raw SQL.
      expect(
        await rejection(
          ORG.main,
          (db) =>
            db.$executeRawUnsafe(
              `INSERT INTO "pharmacy_catalog_branch_prices"
               ("id", "organizationId", "branchId", "medicineId", "packLevelId", "sellingPriceMinor")
             VALUES ($1, $2, $3, $4, $5, 5)`,
              `planted_${suffix}`,
              ORG.main,
              BRANCH.b,
              medicine.id,
              medicine.packId
            ),
          USER.ownerA
        )
      ).toContain('row-level security');
      // USING: an update aimed at B's row reaches nothing.
      const updated = await inOrg(
        ORG.main,
        (db) =>
          db.$executeRawUnsafe(
            `UPDATE "pharmacy_catalog_branch_prices" SET "sellingPriceMinor" = 1 WHERE "branchId" = $1`,
            BRANCH.b
          ),
        USER.ownerA
      );
      expect(updated).toBe(0);
      // A transaction bound to A may not act for B through the writer either.
      await expect(
        inOrg(
          ORG.main,
          async (db) => {
            await db.$queryRawUnsafe(
              `SELECT set_config('app.current_branch_id', $1, true)`,
              BRANCH.a
            );
            return commercial.setCatalogDefaultPrices(db, actorOf(ORG.main, USER.ownerAB), {
              branchId: BRANCH.b,
              enabled: true,
            });
          },
          USER.ownerAB
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // The platform job context (no user) cannot write a branch setting either. A savepoint
      // keeps the transaction usable, so the job helper can restore its scope afterwards.
      expect(
        await scoped.withPlatformDb((db) =>
          scoped.withOrganizationDefaults(db, ORG.main, async (tenantDb) => {
            await tenantDb.$executeRawUnsafe('SAVEPOINT catalog_probe');
            const message = await tenantDb
              .$executeRawUnsafe(
                `INSERT INTO "pharmacy_catalog_branch_settings" ("organizationId", "branchId") VALUES ($1, $2)`,
                ORG.main,
                BRANCH.a
              )
              .then(
                () => 'ACCEPTED',
                (error: Error) => error.message
              );
            await tenantDb.$executeRawUnsafe('ROLLBACK TO SAVEPOINT catalog_probe');
            return message;
          })
        )
      ).toContain('row-level security');
    });
  }
);

describeIfDatabase(
  'CAT-SEC-04: one transaction per writer, all or nothing, idempotent',
  { timeout: 120_000 },
  () => {
    const owner = () => actorOf(ORG.tx, USER.ownerT);
    const applyDefaults = (branchId: string, db: ScopedDb) =>
      commercial.setCatalogDefaultPrices(db, owner(), { branchId, enabled: true });

    it('a failed price write (a row planted between lock and write) rolls everything back; the retry then succeeds', async () => {
      const before = await branchState(ORG.tx, BRANCH.t1);
      const counts = await coverage(ORG.tx);
      const [target] = await catalogMedicines(ORG.tx);
      // A writer that skipped the lock order holds an uncommitted, purchase-only row.
      const held = deferred();
      const planted = holding(
        ORG.tx,
        (db) =>
          db.$executeRawUnsafe(
            `INSERT INTO "pharmacy_catalog_branch_prices"
             ("id", "organizationId", "branchId", "medicineId", "packLevelId", "purchasePriceMinor", "updatedById")
           VALUES ($1, $2, $3, $4, $5, 1, $6)`,
            `planted_t1_${suffix}`,
            ORG.tx,
            BRANCH.t1,
            target!.id,
            target!.packId,
            USER.writerT
          ),
        held.resolve,
        1_500,
        USER.writerT
      );
      await held.promise;
      const outcome = inOrg(ORG.tx, (db) => applyDefaults(BRANCH.t1, db), USER.ownerT).then(
        () => 'applied',
        (error: { code?: string }) => error.code ?? 'error'
      );
      const [, result] = await Promise.all([planted, outcome]);
      expect(result).toBe('CONFLICT');
      // Nothing of the application landed: setting, other packs' rows, counts, audit.
      const after = await branchState(ORG.tx, BRANCH.t1);
      expect(after.setting).toEqual(before.setting);
      expect(after.audits).toBe(before.audits);
      expect(after.prices).toEqual([
        expect.objectContaining({
          id: `planted_t1_${suffix}`,
          sellingPriceMinor: null,
          purchasePriceMinor: 1,
        }),
      ]);
      expect(await coverage(ORG.tx)).toEqual(counts);

      // Retry: the planted row is now an existing price; only its empty selling price fills.
      const retry = await inOrg(ORG.tx, (db) => applyDefaults(BRANCH.t1, db), USER.ownerT);
      expect(retry).toMatchObject({ changed: true, created: DEFAULTED - 1, filled: 1 });
      const done = await branchState(ORG.tx, BRANCH.t1);
      expect(done.prices).toHaveLength(DEFAULTED);
      expect(done.prices.find((row) => row.id === `planted_t1_${suffix}`)).toMatchObject({
        sellingPriceMinor: 1_000,
        purchasePriceMinor: 1,
      });
      expect(done.audits).toBe(before.audits + 1);
      await expectCoverageConsistent(ORG.tx);
    });

    it('a price write that fails after earlier writes landed rolls all of them back', async () => {
      const medicines = await catalogMedicines(ORG.tx);
      const fill = medicines[1]!;
      // An existing branch row with an empty selling price: the application must fill it.
      await inOrg(
        ORG.tx,
        (db) =>
          commercial.setCatalogPackPrice(db, owner(), {
            branchId: BRANCH.t2,
            packLevelId: fill.packId,
            sellingPriceMinor: null,
            purchasePriceMinor: 5,
            expected: { sellingPriceMinor: null, purchasePriceMinor: null },
          }),
        USER.ownerT
      );
      const before = await branchState(ORG.tx, BRANCH.t2);
      const counts = await coverage(ORG.tx);
      // Another transaction holds the fill target's pack, so the fill statement (which
      // runs after the INSERT of the other packs has landed) cannot take its lock.
      const held = deferred();
      const blocker = holding(
        ORG.tx,
        (db) =>
          db.$queryRawUnsafe(
            `SELECT "id" FROM "pharmacy_pack_levels" WHERE "id" = $1 FOR SHARE`,
            fill.packId
          ),
        held.resolve,
        2_500
      );
      await held.promise;
      const outcome = await inOrg(
        ORG.tx,
        async (db) => {
          await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1s'`);
          return applyDefaults(BRANCH.t2, db);
        },
        USER.ownerT
      ).then(
        () => 'applied',
        (error: Error) => error.message
      );
      await blocker;
      expect(outcome).not.toBe('applied');
      expect(await branchState(ORG.tx, BRANCH.t2)).toEqual(before);
      expect(await coverage(ORG.tx)).toEqual(counts);

      const retry = await inOrg(ORG.tx, (db) => applyDefaults(BRANCH.t2, db), USER.ownerT);
      expect(retry).toMatchObject({ changed: true, created: DEFAULTED - 1, filled: 1 });
      expect(
        (await branchState(ORG.tx, BRANCH.t2)).prices.find((row) => row.packLevelId === fill.packId)
      ).toMatchObject({ sellingPriceMinor: 1_100, purchasePriceMinor: 5 });
      await expectCoverageConsistent(ORG.tx);
    });

    it('a failed audit insert rolls back the setting and every price; retry succeeds once and then is a no-op', async () => {
      const before = await branchState(ORG.tx, BRANCH.t3);
      const counts = await coverage(ORG.tx);
      const failed = await rejection(
        ORG.tx,
        (db) => applyDefaults(BRANCH.t3, withFailingAudit(db)),
        USER.ownerT
      );
      expect(failed).toMatch(/null value|not-null|NOT NULL/i);
      expect(await branchState(ORG.tx, BRANCH.t3)).toEqual(before);
      expect(await coverage(ORG.tx)).toEqual(counts);

      const first = await inOrg(ORG.tx, (db) => applyDefaults(BRANCH.t3, db), USER.ownerT);
      expect(first).toMatchObject({ changed: true, created: DEFAULTED, filled: 0 });
      const applied = await branchState(ORG.tx, BRANCH.t3);
      expect(applied.prices).toHaveLength(DEFAULTED);
      expect(applied.audits).toBe(1);
      const appliedCounts = await coverage(ORG.tx);

      const again = await inOrg(ORG.tx, (db) => applyDefaults(BRANCH.t3, db), USER.ownerT);
      expect(again).toMatchObject({ changed: false, created: 0, filled: 0 });
      expect(await branchState(ORG.tx, BRANCH.t3)).toEqual(applied);
      expect(await coverage(ORG.tx)).toEqual(appliedCounts);
    });

    it('two concurrent applications serialize on the branch setting: one applies, the other is a no-op', async () => {
      const both = await Promise.all(
        [0, 1].map(() => inOrg(ORG.tx, (db) => applyDefaults(BRANCH.t5, db), USER.ownerT))
      );
      expect(both.map((result) => result.changed).sort()).toEqual([false, true]);
      expect(both.map((result) => result.created).sort()).toEqual([0, DEFAULTED]);
      const state = await branchState(ORG.tx, BRANCH.t5);
      expect(state.prices).toHaveLength(DEFAULTED);
      expect(state.audits).toBe(1);
      await expectCoverageConsistent(ORG.tx);
    });

    it('a failed audit rolls back a pack price and an availability change; an identical retry is a no-op', async () => {
      const medicine = (await catalogMedicines(ORG.tx))[DEFAULTED]!;
      const price = {
        branchId: BRANCH.t4,
        packLevelId: medicine.packId,
        sellingPriceMinor: 1_750,
        purchasePriceMinor: 900,
        expected: { sellingPriceMinor: null, purchasePriceMinor: null },
      };
      const before = await branchState(ORG.tx, BRANCH.t4);
      const counts = await coverage(ORG.tx);
      expect(
        await rejection(
          ORG.tx,
          (db) => commercial.setCatalogPackPrice(withFailingAudit(db), owner(), price),
          USER.ownerT
        )
      ).toMatch(/null value|not-null|NOT NULL/i);
      expect(await branchState(ORG.tx, BRANCH.t4)).toEqual(before);
      expect(await coverage(ORG.tx)).toEqual(counts);

      await expect(
        inOrg(ORG.tx, (db) => commercial.setCatalogPackPrice(db, owner(), price), USER.ownerT)
      ).resolves.toMatchObject({ changed: true });
      await expect(
        inOrg(ORG.tx, (db) => commercial.setCatalogPackPrice(db, owner(), price), USER.ownerT)
      ).resolves.toMatchObject({ changed: false });
      expect((await branchState(ORG.tx, BRANCH.t4)).audits).toBe(before.audits + 1);

      await meetRegulatedRules(ORG.tx, medicine.id, `tx-${suffix}`);
      const available = { branchId: BRANCH.t4, medicineId: medicine.id, saleable: true };
      expect(
        await rejection(
          ORG.tx,
          (db) =>
            commercial.setCatalogMedicineAvailability(withFailingAudit(db), owner(), available),
          USER.ownerT
        )
      ).toMatch(/null value|not-null|NOT NULL/i);
      expect(
        (await coverage(ORG.tx)).medicines.find((row) => row.id === medicine.id)!.saleable
      ).toBe(false);
      await expect(
        inOrg(
          ORG.tx,
          (db) => commercial.setCatalogMedicineAvailability(db, owner(), available),
          USER.ownerT
        )
      ).resolves.toMatchObject({ changed: true, saleable: true });
      await expectCoverageConsistent(ORG.tx);
    });

    it('lets exactly one of several concurrent pack writers with the same expected price win', async () => {
      const medicine = (await catalogMedicines(ORG.tx))[2]!;
      const prices = [1_501, 1_502, 1_503, 1_504, 1_505, 1_506];
      const outcomes = await Promise.allSettled(
        prices.map((selling) =>
          inOrg(
            ORG.tx,
            (db) =>
              commercial.setCatalogPackPrice(db, owner(), {
                branchId: BRANCH.t4,
                packLevelId: medicine.packId,
                sellingPriceMinor: selling,
                purchasePriceMinor: selling - 500,
                expected: { sellingPriceMinor: 1_200, purchasePriceMinor: 900 },
              }),
            USER.ownerT
          )
        )
      );
      const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const lost = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(won).toHaveLength(1);
      for (const outcome of lost) {
        expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: 'CONFLICT' });
      }
      const winner = (won[0] as PromiseFulfilledResult<{ sellingPriceMinor: number | null }>).value;
      const row = (await branchState(ORG.tx, BRANCH.t4)).prices.find(
        (price) => price.packLevelId === medicine.packId
      );
      // Selling and purchase price come from the same writer: no torn update.
      expect(row).toMatchObject({
        sellingPriceMinor: winner.sellingPriceMinor,
        purchasePriceMinor: winner.sellingPriceMinor! - 500,
      });
      await expectCoverageConsistent(ORG.tx);
    });
  }
);

describeIfDatabase(
  'CAT-SEC-02: platform paths seed reference rows only',
  { timeout: 120_000 },
  () => {
    async function counts(organizationId: string) {
      return inOrg(organizationId, async (db) => ({
        catalogue: await db.medicine.count({ where: { catalogVersion: CATALOG.version } }),
        saleable: await db.medicine.count({
          where: { catalogVersion: CATALOG.version, saleable: true },
        }),
        covered: await db.medicine.count({ where: { catalogSellingPriceCount: { gt: 0 } } }),
      }));
    }

    it('seeds every medicine unsaleable through the onboarding job path, although every source row is active', async () => {
      expect(CATALOG.items.every((item) => item.active)).toBe(true);
      await scoped.withPlatformDb(
        (db) =>
          scoped.withOrganizationDefaults(db, ORG.job, (tenantDb) =>
            preload.seedPharmacyCatalog(tenantDb, ORG.job, CATALOG, undefined)
          ),
        { timeout: 60_000 }
      );
      expect(await counts(ORG.job)).toEqual({ catalogue: CATALOG.count, saleable: 0, covered: 0 });
    });

    it('seeds every medicine unsaleable through the platform backfill, authorized by the central decision', async () => {
      await expect(
        backfill.backfillPharmacyCatalog(
          { id: `platform_${suffix}`, role: 'OPERATIONS' },
          { organizationId: ORG.backfill },
          true
        )
      ).rejects.toMatchObject({ status: 403 });
      expect((await counts(ORG.backfill)).catalogue).toBe(0);
      const result = await backfill.backfillPharmacyCatalog(
        { id: `platform_${suffix}`, role: 'SUPER_ADMIN' },
        { organizationId: ORG.backfill },
        true
      );
      expect(result.organizations).toEqual([
        expect.objectContaining({ organizationId: ORG.backfill, status: 'completed' }),
      ]);
      expect(await counts(ORG.backfill)).toEqual({
        catalogue: CATALOG.count,
        saleable: 0,
        covered: 0,
      });
    });
  }
);

describeIfDatabase('saleability stays tied to a branch price', { timeout: 120_000 }, () => {
  it('refuses a saleable catalogue insert, an unpriced switch to saleable, an origin change and counter tampering', async () => {
    const medicine = (await catalogMedicines(ORG.other))[0]!;
    expect(
      await rejection(ORG.other, (db) =>
        db.medicine.create({
          data: {
            productName: 'Planted saleable catalogue row',
            productFamily: 'PHARMACEUTICAL',
            saleable: true,
            catalogVersion: CATALOG.version,
          },
        })
      )
    ).toContain('catalogue medicines must be created unsaleable');
    expect(
      await rejection(ORG.other, (db) =>
        db.medicine.update({ where: { id: medicine.id }, data: { saleable: true } })
      )
    ).toContain('needs a positive selling price in at least one branch');
    expect(
      await rejection(ORG.other, (db) =>
        db.medicine.update({ where: { id: medicine.id }, data: { catalogVersion: null } })
      )
    ).toContain('immutable');
    expect(
      await rejection(ORG.other, (db) =>
        db.medicine.update({ where: { id: medicine.id }, data: { catalogSellingPriceCount: 3 } })
      )
    ).toContain('maintained by the database');
    expect(
      await rejection(ORG.other, (db) =>
        db.packLevel.update({
          where: { id: medicine.packId },
          data: { catalogSellingPriceCount: 1 },
        })
      )
    ).toContain('maintained by the database');
    // Medicines outside the catalogue keep their existing rules.
    await inOrg(ORG.other, (db) =>
      db.medicine.create({
        data: { productName: 'Front-shop item', productFamily: 'FRONT_SHOP', saleable: true },
      })
    );
  });

  it('refuses to price a superseded pack version, in the writer and in the database', async () => {
    const medicine = (await catalogMedicines(ORG.other))[1]!;
    const current = await inOrg(ORG.other, (db) =>
      db.packLevel.findFirstOrThrow({ where: { id: medicine.packId } })
    );
    // Unpriced, so the pack may be revised.
    await act(ORG.other, USER.ownerO, (api) =>
      api.revisePackLevel({
        id: current.id,
        unitsPerParent: 20,
        effectiveFrom: new Date('2026-10-20T00:00:00.000Z'),
      })
    );
    await expect(
      inOrg(
        ORG.other,
        (db) =>
          commercial.setCatalogPackPrice(db, actorOf(ORG.other, USER.ownerO), {
            branchId: BRANCH.other,
            packLevelId: current.id,
            sellingPriceMinor: 1_000,
            purchasePriceMinor: null,
            expected: { sellingPriceMinor: null, purchasePriceMinor: null },
          }),
        USER.ownerO
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(
      await rejection(
        ORG.other,
        (db) =>
          db.$executeRawUnsafe(
            `INSERT INTO "pharmacy_catalog_branch_prices"
               ("id", "organizationId", "branchId", "medicineId", "packLevelId", "sellingPriceMinor")
             VALUES ($1, $2, $3, $4, $5, 1000)`,
            `superseded_${suffix}`,
            ORG.other,
            BRANCH.other,
            medicine.id,
            current.id
          ),
        USER.ownerO
      )
    ).toContain('needs the current pack version');
  });

  it('makes a catalogue medicine saleable only with a price in the caller’s branch and the regulated rules', async () => {
    const medicine = (await catalogMedicines(ORG.main))[2]!;
    const available = (userId: string, branchId: string) =>
      inOrg(
        ORG.main,
        (db) =>
          commercial.setCatalogMedicineAvailability(db, actorOf(ORG.main, userId), {
            branchId,
            medicineId: medicine.id,
            saleable: true,
          }),
        userId
      );
    await inOrg(
      ORG.main,
      (db) =>
        commercial.setCatalogPackPrice(db, actorOf(ORG.main, USER.ownerB), {
          branchId: BRANCH.b,
          packLevelId: medicine.packId,
          sellingPriceMinor: 1_800,
          purchasePriceMinor: null,
          expected: { sellingPriceMinor: null, purchasePriceMinor: null },
        }),
      USER.ownerB
    );
    await meetRegulatedRules(ORG.main, medicine.id, `avail-${suffix}`);
    // Branch B's price does not let branch A's owner make it available from A.
    await expect(available(USER.ownerA, BRANCH.a)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('selling price'),
    });
    await expect(available(USER.ownerA, BRANCH.b)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(available(USER.ownerB, BRANCH.b)).resolves.toMatchObject({
      branchId: BRANCH.b,
      saleable: true,
      changed: true,
    });
    await expectCoverageConsistent(ORG.main);
  });

  it('never lets a writer leave a saleable catalogue medicine without a branch price, or revise its priced pack', async () => {
    const medicine = (await catalogMedicines(ORG.main))[2]!;
    const removeB = () =>
      inOrg(
        ORG.main,
        (db) =>
          commercial.setCatalogPackPrice(db, actorOf(ORG.main, USER.ownerB), {
            branchId: BRANCH.b,
            packLevelId: medicine.packId,
            sellingPriceMinor: null,
            purchasePriceMinor: null,
            expected: { sellingPriceMinor: 1_800, purchasePriceMinor: null },
          }),
        USER.ownerB
      );
    await expect(removeB()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // Writers outside the module are stopped by the database guards.
    expect(
      await rejection(
        ORG.main,
        (db) =>
          db.$executeRawUnsafe(
            `UPDATE "pharmacy_catalog_branch_prices" SET "sellingPriceMinor" = NULL WHERE "packLevelId" = $1`,
            medicine.packId
          ),
        USER.ownerB
      )
    ).toContain('needs a positive selling price in at least one branch');
    await expect(
      act(ORG.main, USER.ownerB, (api) =>
        api.revisePackLevel({
          id: medicine.packId,
          unitsPerParent: 30,
          effectiveFrom: new Date('2026-10-20T00:00:00.000Z'),
        })
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(
      await rejection(ORG.main, (db) =>
        db.packLevel.update({
          where: { id: medicine.packId },
          data: { effectiveTo: new Date('2026-10-20T00:00:00.000Z') },
        })
      )
    ).toContain('cannot be superseded or moved');
    // A second branch's price lets the first go; the medicine stays covered.
    await inOrg(
      ORG.main,
      (db) =>
        commercial.setCatalogPackPrice(db, actorOf(ORG.main, USER.ownerA), {
          branchId: BRANCH.a,
          packLevelId: medicine.packId,
          sellingPriceMinor: 1_900,
          purchasePriceMinor: null,
          expected: { sellingPriceMinor: null, purchasePriceMinor: null },
        }),
      USER.ownerA
    );
    await expect(removeB()).resolves.toMatchObject({ changed: true, sellingPriceMinor: null });
    await expectCoverageConsistent(ORG.main);
    // Unavailable first, then the last price may go.
    await inOrg(
      ORG.main,
      (db) =>
        commercial.setCatalogMedicineAvailability(db, actorOf(ORG.main, USER.ownerA), {
          branchId: BRANCH.a,
          medicineId: medicine.id,
          saleable: false,
        }),
      USER.ownerA
    );
    await inOrg(
      ORG.main,
      (db) =>
        commercial.setCatalogPackPrice(db, actorOf(ORG.main, USER.ownerA), {
          branchId: BRANCH.a,
          packLevelId: medicine.packId,
          sellingPriceMinor: null,
          purchasePriceMinor: null,
          expected: { sellingPriceMinor: 1_900, purchasePriceMinor: null },
        }),
      USER.ownerA
    );
    await expectCoverageConsistent(ORG.main);
  });

  it('a make-available racing a price removal never ends saleable without a price, in either order', async () => {
    const [, , , first, second] = await catalogMedicines(ORG.main);
    const owner = actorOf(ORG.main, USER.ownerA);
    for (const medicine of [first!, second!]) {
      await inOrg(
        ORG.main,
        (db) =>
          commercial.setCatalogPackPrice(db, owner, {
            branchId: BRANCH.a,
            packLevelId: medicine.packId,
            sellingPriceMinor: 1_900,
            purchasePriceMinor: null,
            expected: { sellingPriceMinor: null, purchasePriceMinor: null },
          }),
        USER.ownerA
      );
      await meetRegulatedRules(ORG.main, medicine.id, `race-${medicine.id}`);
    }
    const available = (medicineId: string) => (db: ScopedDb) =>
      commercial.setCatalogMedicineAvailability(db, owner, {
        branchId: BRANCH.a,
        medicineId,
        saleable: true,
      });
    const removePrice = (packLevelId: string) => (db: ScopedDb) =>
      commercial.setCatalogPackPrice(db, owner, {
        branchId: BRANCH.a,
        packLevelId,
        sellingPriceMinor: null,
        purchasePriceMinor: null,
        expected: { sellingPriceMinor: 1_900, purchasePriceMinor: null },
      });
    const outcome = (promise: Promise<unknown>) =>
      promise.then(
        () => 'ok',
        (error: { code?: string }) => error.code ?? 'error'
      );
    const saleable = async (medicineId: string) =>
      (await coverage(ORG.main)).medicines.find((row) => row.id === medicineId)!.saleable;

    // Availability first: the removal waits, then sees a saleable medicine.
    let held = deferred();
    const availableFirst = holding(ORG.main, available(first!.id), held.resolve, 500, USER.ownerA);
    await held.promise;
    const lateRemoval = outcome(inOrg(ORG.main, removePrice(first!.packId), USER.ownerA));
    await availableFirst;
    expect(await lateRemoval).toBe('BAD_REQUEST');
    expect(await saleable(first!.id)).toBe(true);

    // Removal first: availability waits, then finds no price.
    held = deferred();
    const removalFirst = holding(
      ORG.main,
      removePrice(second!.packId),
      held.resolve,
      500,
      USER.ownerA
    );
    await held.promise;
    const lateAvailability = outcome(inOrg(ORG.main, available(second!.id), USER.ownerA));
    await removalFirst;
    expect(await lateAvailability).toBe('BAD_REQUEST');
    expect(await saleable(second!.id)).toBe(false);
    await expectCoverageConsistent(ORG.main);
  });

  it('a reviewed publication of an unpriced catalogue medicine is refused until a branch prices it', async () => {
    const medicine = (await catalogMedicines(ORG.main))[5]!;
    const rights = {
      acquisition: 'fixture',
      cache: 'fixture',
      redistribution: 'fixture',
      deletion: 'fixture',
    };
    const values: Record<string, string> = {
      productName: medicine.name,
      strength: '500mg',
      dosageForm: 'Tablet',
      pack: '10 tablets',
      drapRegistrationNumber: `DRAP-pub-${suffix}`,
    };
    const assertionIds = await inOrg(ORG.main, async (db) => {
      const ids: string[] = [];
      for (const [field, value] of Object.entries(values)) {
        const assertion = await db.medicineProvenance.create({
          data: {
            medicineId: medicine.id,
            field,
            source: 'manual-file:fixture',
            sourceType: 'IMPORT',
            retrievedAt: new Date('2026-10-01T00:00:00.000Z'),
            reviewer: USER.pharmacist,
            status: 'ACCEPTED',
            assertedValue: {
              value,
              connectorId: 'manual-file',
              sourceLabel: 'fixture.csv',
              batchId: 'batch-1',
              rowSourceKey: 'row-1',
              rights,
              blockingIssues: [],
            },
          },
        });
        ids.push(assertion.id);
      }
      await db.medicineReviewDecision.create({
        data: {
          duplicateKey: `fixture:${medicine.id}`,
          action: 'ACCEPT',
          medicineIds: [medicine.id],
          payload: { assertionIds: ids },
          reviewerId: USER.pharmacist,
        },
      });
      return ids;
    });
    await expect(
      act(ORG.main, USER.pharmacist, (api) => api.publishAssertions({ assertionIds }))
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('price') });

    await inOrg(
      ORG.main,
      (db) =>
        commercial.setCatalogPackPrice(db, actorOf(ORG.main, USER.ownerA), {
          branchId: BRANCH.a,
          packLevelId: medicine.packId,
          sellingPriceMinor: 2_000,
          purchasePriceMinor: null,
          expected: { sellingPriceMinor: null, purchasePriceMinor: null },
        }),
      USER.ownerA
    );
    await act(ORG.main, USER.pharmacist, (api) => api.publishAssertions({ assertionIds }));
    expect(
      (await coverage(ORG.main)).medicines.find((row) => row.id === medicine.id)!.saleable
    ).toBe(true);
    await expectCoverageConsistent(ORG.main);
  });
});
