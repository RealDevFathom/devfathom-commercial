/**
 * Catalogue preload hold fix, against migrated PostgreSQL with FORCED row level
 * security, as a NOSUPERUSER NOBYPASSRLS role. Skipped (never silently passed)
 * when TEST_DATABASE_URL is absent.
 *
 *   1. Every catalogue price and availability mutation is authorized server-side
 *      and fails closed: the real procedures (capabilityProcedure + `can()`) and
 *      the writers called directly, with grants read from organization roles and
 *      user overrides in the database.
 *   2. Concurrent price writes are atomic and race-safe: real concurrent
 *      transactions, where one holds its locks while the other runs.
 *   3. Catalogue medicines start unsaleable through the onboarding job path and the
 *      platform backfill, and the database refuses every unpriced route to saleable.
 *
 * An expected database error aborts its transaction, so a case that provokes a
 * trigger reads back from a new one.
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
const suffix = randomBytes(5).toString('hex');
const ORG = {
  a: `org_catfix_a_${suffix}`,
  b: `org_catfix_b_${suffix}`,
  toggle: `org_catfix_t_${suffix}`,
  toggleFirst: `org_catfix_u_${suffix}`,
  seedRace: `org_catfix_s_${suffix}`,
  job: `org_catfix_j_${suffix}`,
  backfill: `org_catfix_k_${suffix}`,
};
const USER = {
  owner: `user_catfix_owner_${suffix}`,
  manager: `user_catfix_manager_${suffix}`,
  roleDenied: `user_catfix_roledeny_${suffix}`,
  userDenied: `user_catfix_userdeny_${suffix}`,
  pharmacist: `user_catfix_pharmacist_${suffix}`,
  ownerB: `user_catfix_owner_b_${suffix}`,
  ownerT: `user_catfix_owner_t_${suffix}`,
  ownerU: `user_catfix_owner_u_${suffix}`,
  ownerS: `user_catfix_owner_s_${suffix}`,
};

type Scoped = typeof import('@/lib/tenancy/scoped-db');
type Commercial = typeof import('./commercial');
type Router = (typeof import('@/server/routers/pharmacy-medicine'))['pharmacyMedicineRouter'];
type Api = ReturnType<Router['createCaller']>;

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

function inOrg<T>(organizationId: string, work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return scoped.withTenantDb(organizationId, work, { timeout: 60_000 });
}

/** Run work that is EXPECTED to fail (at a statement or at commit) in its own transaction. */
async function rejection(organizationId: string, work: (db: ScopedDb) => Promise<unknown>) {
  return inOrg(organizationId, work).then(
    () => 'ACCEPTED: the write was expected to fail',
    (error: Error) => error.message
  );
}

function caller(db: ScopedDb, organizationId: string, userId: string): Api {
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
      user: {
        id: userId,
        role: 'EMPLOYEE',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId,
      },
    },
    organization: { id: organizationId, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

function act<T>(organizationId: string, userId: string, run: (api: Api) => Promise<T>) {
  return inOrg(organizationId, (db) => run(caller(db, organizationId, userId)));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/**
 * Run `work` in a transaction, signal once it returns (its row locks are held),
 * keep the transaction open for `ms`, then commit.
 */
async function holding<T>(
  organizationId: string,
  work: (db: ScopedDb) => Promise<T>,
  held: () => void,
  ms = 500
): Promise<{ value: T; committedAt: number }> {
  const value = await inOrg(organizationId, async (db) => {
    const result = await work(db);
    held();
    await db.$executeRawUnsafe(`SELECT pg_sleep(${ms / 1000})`);
    return result;
  });
  return { value, committedAt: Date.now() };
}

type CatalogMedicine = { id: string; name: string; packId: string };

async function catalogMedicines(organizationId: string): Promise<CatalogMedicine[]> {
  const medicines = await inOrg(organizationId, (db) =>
    db.medicine.findMany({
      where: { catalogVersion: CATALOG.version },
      select: {
        id: true,
        productName: true,
        presentations: { select: { packLevels: { select: { id: true } } } },
      },
    })
  );
  return medicines
    .map((medicine) => ({
      id: medicine.id,
      name: medicine.productName,
      packId: medicine.presentations[0]!.packLevels[0]!.id,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function packPrices(organizationId: string, packId: string) {
  return inOrg(organizationId, (db) =>
    db.packLevel.findFirstOrThrow({
      where: { id: packId },
      select: { sellingPriceMinor: true, purchasePriceMinor: true },
    })
  );
}

async function saleable(organizationId: string, medicineId: string) {
  const medicine = await inOrg(organizationId, (db) =>
    db.medicine.findFirstOrThrow({ where: { id: medicineId }, select: { saleable: true } })
  );
  return medicine.saleable;
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

async function createTenant(
  organizationId: string,
  people: { id: string; capabilities: { capability: string; effect: 'ALLOW' | 'DENY' }[] }[]
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
    for (const person of people) {
      const role = await db.organizationRole.create({
        data: {
          key: `role-${person.id}`,
          name: `Role ${person.id}`,
          permissions: { create: person.capabilities },
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
    }
  });
}

const OWNER_GRANTS = [{ capability: 'pharmacy:*', effect: 'ALLOW' as const }];

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

  await createTenant(ORG.a, [
    { id: USER.owner, capabilities: OWNER_GRANTS },
    { id: USER.manager, capabilities: [{ capability: 'pharmacy:manage', effect: 'ALLOW' }] },
    {
      id: USER.roleDenied,
      capabilities: [...OWNER_GRANTS, { capability: 'pharmacy:catalog-settings', effect: 'DENY' }],
    },
    { id: USER.userDenied, capabilities: OWNER_GRANTS },
    {
      id: USER.pharmacist,
      capabilities: [{ capability: 'pharmacy:catalogue-review', effect: 'ALLOW' }],
    },
  ]);
  await inOrg(ORG.a, (db) =>
    db.userPermissionOverride.create({
      data: {
        userId: USER.userDenied,
        capability: 'pharmacy:catalog-settings',
        effect: 'DENY',
        reason: 'fixture: explicit user deny beats the role grant',
      },
    })
  );
  await createTenant(ORG.b, [{ id: USER.ownerB, capabilities: OWNER_GRANTS }]);
  await createTenant(ORG.toggle, [{ id: USER.ownerT, capabilities: OWNER_GRANTS }]);
  await createTenant(ORG.toggleFirst, [{ id: USER.ownerU, capabilities: OWNER_GRANTS }]);
  await createTenant(ORG.seedRace, [{ id: USER.ownerS, capabilities: OWNER_GRANTS }]);
  await createTenant(ORG.job, []);
  await createTenant(ORG.backfill, []);
  for (const organizationId of [ORG.a, ORG.b, ORG.toggle, ORG.toggleFirst]) {
    await inOrg(organizationId, (db) =>
      preload.seedPharmacyCatalog(db, organizationId, CATALOG, undefined)
    );
  }
}, 180_000);

afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase('finding 1: catalogue price and availability writes are authorized', () => {
  it('refuses every catalogue mutation without the grant, with a role DENY or a user DENY, and changes nothing', async () => {
    const [medicine] = await catalogMedicines(ORG.a);
    for (const userId of [USER.manager, USER.roleDenied, USER.userDenied, USER.pharmacist]) {
      await act(ORG.a, userId, async (api) => {
        await expect(api.setCatalogDefaultPrices({ enabled: true })).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        await expect(
          api.setCatalogPackPrice({
            packLevelId: medicine!.packId,
            sellingPriceMinor: 999,
            purchasePriceMinor: null,
            expected: { sellingPriceMinor: null, purchasePriceMinor: null },
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(
          api.setCatalogMedicineAvailability({ medicineId: medicine!.id, saleable: true })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(api.catalogMedicine({ medicineId: medicine!.id })).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
      });
    }
    expect(await packPrices(ORG.a, medicine!.packId)).toEqual({
      sellingPriceMinor: null,
      purchasePriceMinor: null,
    });
    expect(await saleable(ORG.a, medicine!.id)).toBe(false);
    const setting = await inOrg(ORG.a, (db) => db.pharmacyCatalogSetting.findFirst());
    expect(setting?.useCatalogDefaultPrices ?? false).toBe(false);
  });

  it('re-checks the capability inside each writer, so a direct caller without it is refused', async () => {
    const [medicine] = await catalogMedicines(ORG.a);
    for (const userId of [USER.manager, USER.roleDenied, USER.userDenied]) {
      const actor = actorOf(ORG.a, userId);
      const attempts: (() => Promise<unknown>)[] = [
        () => inOrg(ORG.a, (db) => commercial.setCatalogDefaultPrices(db, actor, true)),
        () =>
          inOrg(ORG.a, (db) =>
            commercial.setCatalogPackPrice(db, actor, {
              packLevelId: medicine!.packId,
              sellingPriceMinor: 999,
              purchasePriceMinor: null,
              expected: { sellingPriceMinor: null, purchasePriceMinor: null },
            })
          ),
        () =>
          inOrg(ORG.a, (db) =>
            commercial.setCatalogMedicineAvailability(db, actor, {
              medicineId: medicine!.id,
              saleable: true,
            })
          ),
      ];
      for (const attempt of attempts) {
        await expect(attempt()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
    }
    expect(await packPrices(ORG.a, medicine!.packId)).toEqual({
      sellingPriceMinor: null,
      purchasePriceMinor: null,
    });
  });

  it('lets the Owner role through pharmacy:* and never reaches another tenant', async () => {
    const [, medicine] = await catalogMedicines(ORG.a);
    await act(ORG.a, USER.owner, async (api) => {
      await expect(api.catalogMedicine({ medicineId: medicine!.id })).resolves.toMatchObject({
        id: medicine!.id,
        saleable: false,
      });
      await expect(
        api.setCatalogPackPrice({
          packLevelId: medicine!.packId,
          sellingPriceMinor: 1_234,
          purchasePriceMinor: 800,
          expected: { sellingPriceMinor: null, purchasePriceMinor: null },
        })
      ).resolves.toMatchObject({ sellingPriceMinor: 1_234 });
    });
    // Another tenant's Owner cannot see the pack through its own scope ...
    await act(ORG.b, USER.ownerB, async (api) => {
      await expect(
        api.setCatalogPackPrice({
          packLevelId: medicine!.packId,
          sellingPriceMinor: 1,
          purchasePriceMinor: null,
          expected: { sellingPriceMinor: 1_234, purchasePriceMinor: 800 },
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
    // ... and is not a user of this tenant, so its subject holds no grant here.
    await expect(
      inOrg(ORG.a, (db) =>
        commercial.setCatalogMedicineAvailability(db, actorOf(ORG.a, USER.ownerB), {
          medicineId: medicine!.id,
          saleable: false,
        })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await packPrices(ORG.a, medicine!.packId)).toEqual({
      sellingPriceMinor: 1_234,
      purchasePriceMinor: 800,
    });
  });
});

describeIfDatabase('finding 2: concurrent catalogue price writes are atomic and race-safe', () => {
  it('lets exactly one of several concurrent writers with the same expected price win', async () => {
    const medicine = (await catalogMedicines(ORG.a))[2]!;
    const owner = actorOf(ORG.a, USER.owner);
    const prices = [1_501, 1_502, 1_503, 1_504, 1_505, 1_506];
    const outcomes = await Promise.allSettled(
      prices.map((price) =>
        inOrg(ORG.a, (db) =>
          commercial.setCatalogPackPrice(db, owner, {
            packLevelId: medicine.packId,
            sellingPriceMinor: price,
            purchasePriceMinor: price - 500,
            expected: { sellingPriceMinor: null, purchasePriceMinor: null },
          })
        )
      )
    );
    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const lost = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(prices.length - 1);
    for (const outcome of lost) {
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: 'CONFLICT' });
    }
    const winner = (won[0] as PromiseFulfilledResult<{ sellingPriceMinor: number | null }>).value;
    // Selling and purchase price come from the same writer: no torn update.
    expect(await packPrices(ORG.a, medicine.packId)).toEqual({
      sellingPriceMinor: winner.sellingPriceMinor,
      purchasePriceMinor: winner.sellingPriceMinor! - 500,
    });
    const audits = await inOrg(ORG.a, (db) =>
      db.auditLog.count({
        where: { action: 'pharmacyCatalog.setPackPrice', targetId: medicine.packId },
      })
    );
    expect(audits).toBe(1);
  });

  it('makes a stale writer wait for the one holding the pack, then CONFLICT instead of overwriting', async () => {
    const medicine = (await catalogMedicines(ORG.a))[3]!;
    const owner = actorOf(ORG.a, USER.owner);
    const write = (price: number) => (db: ScopedDb) =>
      commercial.setCatalogPackPrice(db, owner, {
        packLevelId: medicine.packId,
        sellingPriceMinor: price,
        purchasePriceMinor: null,
        expected: { sellingPriceMinor: null, purchasePriceMinor: null },
      });
    const held = deferred();
    const first = holding(ORG.a, write(2_100), held.resolve);
    await held.promise;
    const second = inOrg(ORG.a, write(2_200)).then(
      () => ({ outcome: 'won', at: Date.now() }),
      (error: { code?: string }) => ({ outcome: error.code, at: Date.now() })
    );
    const [{ committedAt }, stale] = await Promise.all([first, second]);
    expect(stale.outcome).toBe('CONFLICT');
    expect(stale.at).toBeGreaterThanOrEqual(committedAt);
    expect(await packPrices(ORG.a, medicine.packId)).toEqual({
      sellingPriceMinor: 2_100,
      purchasePriceMinor: null,
    });
  });

  it('turning default prices on never replaces a price an owner is writing concurrently, and counts exactly', async () => {
    const [manual, untouched] = await catalogMedicines(ORG.toggle);
    const owner = actorOf(ORG.toggle, USER.ownerT);
    const held = deferred();
    const ownerWrite = holding(
      ORG.toggle,
      (db) =>
        commercial.setCatalogPackPrice(db, owner, {
          packLevelId: manual!.packId,
          sellingPriceMinor: 2_500,
          purchasePriceMinor: null,
          expected: { sellingPriceMinor: null, purchasePriceMinor: null },
        }),
      held.resolve
    );
    await held.promise;
    const toggle = inOrg(ORG.toggle, (db) => commercial.setCatalogDefaultPrices(db, owner, true));
    const [, applied] = await Promise.all([ownerWrite, toggle]);
    // Five packs carry a default sale price; the one the owner priced first is skipped.
    expect(applied).toEqual({ enabled: true, saleApplied: 4, purchaseApplied: 5 });
    expect(await packPrices(ORG.toggle, manual!.packId)).toEqual({
      sellingPriceMinor: 2_500,
      purchasePriceMinor: 700,
    });
    expect(await packPrices(ORG.toggle, untouched!.packId)).toEqual({
      sellingPriceMinor: 1_100,
      purchasePriceMinor: 800,
    });
  });

  it('an owner write that read the price before defaults were applied gets CONFLICT, not a lost update', async () => {
    const [target] = await catalogMedicines(ORG.toggleFirst);
    const owner = actorOf(ORG.toggleFirst, USER.ownerU);
    const held = deferred();
    const toggle = holding(
      ORG.toggleFirst,
      (db) => commercial.setCatalogDefaultPrices(db, owner, true),
      held.resolve
    );
    await held.promise;
    const stale = inOrg(ORG.toggleFirst, (db) =>
      commercial.setCatalogPackPrice(db, owner, {
        packLevelId: target!.packId,
        sellingPriceMinor: 3_000,
        purchasePriceMinor: null,
        expected: { sellingPriceMinor: null, purchasePriceMinor: null },
      })
    ).then(
      () => 'won',
      (error: { code?: string }) => error.code
    );
    const [, outcome] = await Promise.all([toggle, stale]);
    expect(outcome).toBe('CONFLICT');
    expect(await packPrices(ORG.toggleFirst, target!.packId)).toEqual({
      sellingPriceMinor: 1_000,
      purchasePriceMinor: 700,
    });
  });

  it('serializes a seed with the toggle, so packs seeded after it was turned on carry the defaults', async () => {
    const owner = actorOf(ORG.seedRace, USER.ownerS);
    const held = deferred();
    const toggle = holding(
      ORG.seedRace,
      (db) => commercial.setCatalogDefaultPrices(db, owner, true),
      held.resolve
    );
    await held.promise;
    const seed = inOrg(ORG.seedRace, (db) =>
      preload.seedPharmacyCatalog(db, ORG.seedRace, CATALOG, undefined)
    );
    await Promise.all([toggle, seed]);
    const packs = await inOrg(ORG.seedRace, (db) =>
      db.packLevel.findMany({
        select: {
          sellingPriceMinor: true,
          catalogDefaultSalePriceMinor: true,
          purchasePriceMinor: true,
          catalogDefaultPurchasePriceMinor: true,
        },
      })
    );
    expect(packs).toHaveLength(CATALOG.count);
    for (const pack of packs) {
      expect(pack.sellingPriceMinor).toBe(pack.catalogDefaultSalePriceMinor);
      expect(pack.purchasePriceMinor).toBe(pack.catalogDefaultPurchasePriceMinor);
    }
  });
});

describeIfDatabase('finding 3: catalogue medicines start unsaleable', () => {
  async function counts(organizationId: string) {
    return inOrg(organizationId, async (db) => ({
      catalogue: await db.medicine.count({ where: { catalogVersion: CATALOG.version } }),
      saleable: await db.medicine.count({
        where: { catalogVersion: CATALOG.version, saleable: true },
      }),
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
    expect(await counts(ORG.job)).toEqual({ catalogue: CATALOG.count, saleable: 0 });
  });

  it('seeds every medicine unsaleable through the platform backfill', async () => {
    const result = await backfill.backfillPharmacyCatalog(
      { id: `platform_${suffix}`, role: 'SUPER_ADMIN' },
      { organizationId: ORG.backfill },
      true
    );
    expect(result.organizations).toEqual([
      expect.objectContaining({ organizationId: ORG.backfill, status: 'completed' }),
    ]);
    expect(await counts(ORG.backfill)).toEqual({ catalogue: CATALOG.count, saleable: 0 });
  });

  it('refuses a saleable catalogue insert and an unpriced switch to saleable, and keeps the origin immutable', async () => {
    const medicine = (await catalogMedicines(ORG.b))[0]!;
    expect(
      await rejection(ORG.b, (db) =>
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
      await rejection(ORG.b, (db) =>
        db.medicine.update({ where: { id: medicine.id }, data: { saleable: true } })
      )
    ).toContain('needs a positive selling price');
    expect(
      await rejection(ORG.b, (db) =>
        db.medicine.update({ where: { id: medicine.id }, data: { catalogVersion: null } })
      )
    ).toContain('immutable');
    expect(await saleable(ORG.b, medicine.id)).toBe(false);
    // Medicines outside the catalogue keep their existing rules.
    await inOrg(ORG.b, (db) =>
      db.medicine.create({
        data: { productName: 'Front-shop item', productFamily: 'FRONT_SHOP', saleable: true },
      })
    );
  });

  it('makes a catalogue medicine saleable only through the explicit action, with a price and the regulated rules', async () => {
    const medicine = (await catalogMedicines(ORG.b))[1]!;
    const owner = actorOf(ORG.b, USER.ownerB);
    const makeAvailable = () =>
      inOrg(ORG.b, (db) =>
        commercial.setCatalogMedicineAvailability(db, owner, {
          medicineId: medicine.id,
          saleable: true,
        })
      );
    await expect(makeAvailable()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('selling price'),
    });
    await inOrg(ORG.b, (db) =>
      commercial.setCatalogPackPrice(db, owner, {
        packLevelId: medicine.packId,
        sellingPriceMinor: 1_800,
        purchasePriceMinor: null,
        expected: { sellingPriceMinor: null, purchasePriceMinor: null },
      })
    );
    await expect(makeAvailable()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('DRAP registration'),
    });
    await meetRegulatedRules(ORG.b, medicine.id, `avail-${suffix}`);
    await expect(makeAvailable()).resolves.toEqual({
      medicineId: medicine.id,
      saleable: true,
      changed: true,
    });
    expect(await saleable(ORG.b, medicine.id)).toBe(true);
  });

  it('never lets a writer leave a saleable catalogue medicine without its price', async () => {
    const medicine = (await catalogMedicines(ORG.b))[1]!;
    const owner = actorOf(ORG.b, USER.ownerB);
    expect(await saleable(ORG.b, medicine.id)).toBe(true);
    await expect(
      inOrg(ORG.b, (db) =>
        commercial.setCatalogPackPrice(db, owner, {
          packLevelId: medicine.packId,
          sellingPriceMinor: null,
          purchasePriceMinor: null,
          expected: { sellingPriceMinor: 1_800, purchasePriceMinor: null },
        })
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // Writers outside the module are stopped by the commit-time guard.
    expect(
      await rejection(ORG.b, (db) =>
        db.packLevel.update({ where: { id: medicine.packId }, data: { sellingPriceMinor: null } })
      )
    ).toContain('must keep a positive selling price');
    expect(
      await rejection(ORG.b, async (db) => {
        const current = await db.packLevel.findFirstOrThrow({ where: { id: medicine.packId } });
        await db.packLevel.update({
          where: { id: current.id },
          data: { effectiveTo: new Date('2026-10-20T00:00:00.000Z') },
        });
        await db.packLevel.create({
          data: {
            presentationId: current.presentationId,
            versionGroupId: current.versionGroupId,
            version: current.version + 1,
            level: current.level,
            unitsPerParent: current.unitsPerParent,
            effectiveFrom: new Date('2026-10-20T00:00:00.000Z'),
            supersedesPackLevelId: current.id,
          },
        });
      })
    ).toContain('must keep a positive selling price');
    expect(await packPrices(ORG.b, medicine.packId)).toEqual({
      sellingPriceMinor: 1_800,
      purchasePriceMinor: null,
    });
    // Unavailable first, then the price may go.
    await inOrg(ORG.b, (db) =>
      commercial.setCatalogMedicineAvailability(db, owner, {
        medicineId: medicine.id,
        saleable: false,
      })
    );
    await inOrg(ORG.b, (db) =>
      commercial.setCatalogPackPrice(db, owner, {
        packLevelId: medicine.packId,
        sellingPriceMinor: null,
        purchasePriceMinor: null,
        expected: { sellingPriceMinor: 1_800, purchasePriceMinor: null },
      })
    );
    expect(await saleable(ORG.b, medicine.id)).toBe(false);
  });

  it('a make-available racing a price removal never ends saleable without a price, in either order', async () => {
    const [, , first, second] = await catalogMedicines(ORG.b);
    const owner = actorOf(ORG.b, USER.ownerB);
    for (const medicine of [first!, second!]) {
      await inOrg(ORG.b, (db) =>
        commercial.setCatalogPackPrice(db, owner, {
          packLevelId: medicine.packId,
          sellingPriceMinor: 1_900,
          purchasePriceMinor: null,
          expected: { sellingPriceMinor: null, purchasePriceMinor: null },
        })
      );
      await meetRegulatedRules(ORG.b, medicine.id, `race-${medicine.id}`);
    }
    const available = (medicineId: string) => (db: ScopedDb) =>
      commercial.setCatalogMedicineAvailability(db, owner, { medicineId, saleable: true });
    const removePrice = (packLevelId: string) => (db: ScopedDb) =>
      commercial.setCatalogPackPrice(db, owner, {
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

    // Availability first: the removal waits, then sees a saleable medicine.
    let held = deferred();
    const availableFirst = holding(ORG.b, available(first!.id), held.resolve);
    await held.promise;
    const lateRemoval = outcome(inOrg(ORG.b, removePrice(first!.packId)));
    await availableFirst;
    expect(await lateRemoval).toBe('BAD_REQUEST');
    expect(await saleable(ORG.b, first!.id)).toBe(true);
    expect((await packPrices(ORG.b, first!.packId)).sellingPriceMinor).toBe(1_900);

    // Removal first: availability waits, then finds no price.
    held = deferred();
    const removalFirst = holding(ORG.b, removePrice(second!.packId), held.resolve);
    await held.promise;
    const lateAvailability = outcome(inOrg(ORG.b, available(second!.id)));
    await removalFirst;
    expect(await lateAvailability).toBe('BAD_REQUEST');
    expect(await saleable(ORG.b, second!.id)).toBe(false);
    expect((await packPrices(ORG.b, second!.packId)).sellingPriceMinor).toBeNull();
  });

  it('a reviewed publication of an unpriced catalogue medicine is refused until it has a price', async () => {
    const medicine = (await catalogMedicines(ORG.a))[4]!;
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
    const assertionIds = await inOrg(ORG.a, async (db) => {
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
      act(ORG.a, USER.pharmacist, (api) => api.publishAssertions({ assertionIds }))
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('price') });
    expect(await saleable(ORG.a, medicine.id)).toBe(false);

    await inOrg(ORG.a, (db) =>
      commercial.setCatalogPackPrice(db, actorOf(ORG.a, USER.owner), {
        packLevelId: medicine.packId,
        sellingPriceMinor: 2_000,
        purchasePriceMinor: null,
        expected: { sellingPriceMinor: null, purchasePriceMinor: null },
      })
    );
    await act(ORG.a, USER.pharmacist, (api) => api.publishAssertions({ assertionIds }));
    expect(await saleable(ORG.a, medicine.id)).toBe(true);
  });
});
