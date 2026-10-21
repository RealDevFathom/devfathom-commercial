/**
 * @vitest-environment node
 *
 * MEAL-01 — `hotel_meal_plans` under real, forced row-level security.
 *
 * The vertical-wide rule is that every hotel table is tenant-scoped like
 * pharmacy, and what is proven here is that a *child* of the property is
 * isolated on its own policy rather than by its parent's:
 *
 *  - a tenant connection reads its own plans and never another tenant's, even
 *    addressed by a correct primary key;
 *  - a write that names another tenant is refused by the policy's `WITH CHECK`,
 *    and so is one that names another tenant's property through the composite
 *    foreign key;
 *  - the table is ENABLE **and** FORCE row level security, so the owning role — a
 *    migration, a maintenance job — is filtered too; and
 *  - the `meals` document is validated by the database, not only by Zod, so a
 *    connection that bypasses the router still cannot store a plan that the
 *    entitlement generator would choke on at check-in.
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the
 * restricted runtime role (neither SUPERUSER nor BYPASSRLS — asserted first).
 * The owner probes additionally need OWNER_DATABASE_URL. Without the URLs the
 * suite reports itself skipped rather than passing vacuously.
 *
 * The tenants are seeded from the control plane (`seedHotelTenant`), the way
 * provisioning creates them: the RESTRICTIVE property policy makes a property
 * unreachable from inside the tenant until an assignment names the acting user.
 */
import { randomBytes } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '@/generated/prisma/client';
import { DEFAULT_HOTEL_MEAL_PLANS, parseMealPlanMeals } from '@/lib/hotel/meal-plans';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const OWNER_DATABASE_URL = process.env.OWNER_DATABASE_URL;

// See jobs.purge.db.test.ts: a connection string avoids the cross-realm pg.Pool
// instanceof failure the shared client hits under Vitest.
vi.mock('@/lib/db', () => ({
  db: new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL, max: 10 }),
    log: ['error'],
  }),
}));

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const describeIfOwner = TEST_DATABASE_URL && OWNER_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `hotel_meal_a_${suffix}`;
const ORG_B = `hotel_meal_b_${suffix}`;

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];
function assertLocal(url: string, label: string) {
  if (
    !LOCAL_HOSTS.includes(new URL(url).hostname) &&
    process.env.ALLOW_REMOTE_RLS_TEST !== 'true'
  ) {
    throw new Error(`Refusing to run the ${label} meal-plan probes against a non-local database.`);
  }
}

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
};
let deps: Deps;
let db: PrismaClient;
const tenant = { a: { userId: '', branchId: '' }, b: { userId: '', branchId: '' } };

function inOrg<T>(organizationId: string, work: (db: ScopedDb) => Promise<T>): Promise<T> {
  const who = organizationId === ORG_A ? tenant.a : tenant.b;
  return deps.withTenantDb(organizationId, work, { userId: who.userId });
}

/** The plans a property is provisioned with, written the way provisioning does. */
async function seedDefaultPlans(organizationId: string, branchId: string) {
  return deps.withPlatformDb((db) =>
    db.hotelMealPlan.createMany({
      data: DEFAULT_HOTEL_MEAL_PLANS.map((plan) => ({
        organizationId,
        branchId,
        code: plan.code,
        name: plan.name,
        nameUr: plan.nameUr,
        meals: plan.meals,
        active: plan.active,
      })),
    })
  );
}

describeIfDatabase('hotel_meal_plans tenant isolation', () => {
  beforeAll(async () => {
    assertLocal(TEST_DATABASE_URL!, 'runtime');
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      const posture = await client.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      expect(posture.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    } finally {
      await client.end();
    }
    const scoped = await import('@/lib/tenancy/scoped-db');
    deps = { withTenantDb: scoped.withTenantDb, withPlatformDb: scoped.withPlatformDb };
    ({ db } = await import('@/lib/db'));
    const { seedHotelTenant } = await import('@/lib/testing/hotel-tenant-fixture');
    const a = await seedHotelTenant(deps.withPlatformDb, {
      organizationId: ORG_A,
      properties: [{ name: 'Property A' }],
    });
    const b = await seedHotelTenant(deps.withPlatformDb, {
      organizationId: ORG_B,
      properties: [{ name: 'Property B' }],
    });
    tenant.a = { userId: a.userId, branchId: a.branchIds[0]! };
    tenant.b = { userId: b.userId, branchId: b.branchIds[0]! };
    await seedDefaultPlans(ORG_A, tenant.a.branchId);
    await seedDefaultPlans(ORG_B, tenant.b.branchId);
  }, 60_000);

  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  it('stores the four default plans a property opens with', async () => {
    const plans = await inOrg(ORG_A, (db) =>
      db.hotelMealPlan.findMany({
        where: { branchId: tenant.a.branchId },
        orderBy: { code: 'asc' },
      })
    );
    expect(plans.map((plan) => plan.code)).toEqual(['AP', 'CP', 'EP', 'MAP']);
    // H-D15: EP and CP are sold; MAP and AP exist and wait.
    expect(plans.filter((plan) => plan.active).map((plan) => plan.code)).toEqual(['CP', 'EP']);
    const cp = plans.find((plan) => plan.code === 'CP')!;
    expect(cp.nameUr).toBe('کمرہ اور ناشتہ');
    // The document survives the JSONB round trip in the shape the generator reads.
    expect(parseMealPlanMeals(cp.meals)).toEqual([
      { meal: 'BREAKFAST', outlets: [], cutoff_time: null, per_person: true },
    ]);
  });

  it('reads its own plans and never the other tenant’s', async () => {
    const mine = await inOrg(ORG_A, (db) => db.hotelMealPlan.findMany({}));
    expect(mine.length).toBeGreaterThanOrEqual(DEFAULT_HOTEL_MEAL_PLANS.length);
    expect(new Set(mine.map((plan) => plan.organizationId))).toEqual(new Set([ORG_A]));
    expect(new Set(mine.map((plan) => plan.branchId))).toEqual(new Set([tenant.a.branchId]));

    // Addressed by primary key — the id is correct and belongs to ORG_B, so only
    // the policy can be what withholds it.
    const theirCp = await inOrg(ORG_B, (db) =>
      db.hotelMealPlan.findFirstOrThrow({ where: { code: 'CP' } })
    );
    const stolen = await inOrg(ORG_A, (db) =>
      db.hotelMealPlan.findUnique({ where: { id: theirCp.id } })
    );
    expect(stolen).toBeNull();
  });

  it('refuses an update aimed at another tenant’s plan', async () => {
    const theirCp = await inOrg(ORG_B, (db) =>
      db.hotelMealPlan.findFirstOrThrow({ where: { code: 'CP' } })
    );
    const result = await inOrg(ORG_A, (db) =>
      db.hotelMealPlan.updateMany({
        where: { id: theirCp.id },
        data: { name: 'Renamed by the wrong tenant', active: false },
      })
    );
    expect(result.count).toBe(0);
    const untouched = await inOrg(ORG_B, (db) =>
      db.hotelMealPlan.findUniqueOrThrow({ where: { id: theirCp.id } })
    );
    expect(untouched.name).toBe('Bed & breakfast');
    expect(untouched.active).toBe(true);
  });

  it('refuses a row written under another tenant’s organization id', async () => {
    await expect(
      inOrg(ORG_A, (db) =>
        db.hotelMealPlan.create({
          data: {
            organizationId: ORG_B,
            branchId: tenant.b.branchId,
            code: 'PLANTED',
            name: 'Planted',
            meals: [],
          },
        })
      )
    ).rejects.toThrow();
    const theirs = await inOrg(ORG_B, (db) => db.hotelMealPlan.findMany({}));
    expect(theirs.map((plan) => plan.code).sort()).toEqual(['AP', 'CP', 'EP', 'MAP']);
  });

  it('refuses a plan hung off another tenant’s property', async () => {
    // The tenant is its own, so the policy is satisfied; the composite foreign
    // key is what refuses, because (ORG_A, property B) is not a property.
    await expect(
      inOrg(ORG_A, (db) =>
        db.hotelMealPlan.create({
          data: {
            organizationId: ORG_A,
            branchId: tenant.b.branchId,
            code: 'BORROWED',
            name: 'Borrowed property',
            meals: [],
          },
        })
      )
    ).rejects.toThrow();
  });

  it('keeps one plan per code per property', async () => {
    await expect(
      inOrg(ORG_A, (db) =>
        db.hotelMealPlan.create({
          data: {
            organizationId: ORG_A,
            branchId: tenant.a.branchId,
            code: 'CP',
            name: 'A second bed & breakfast',
            meals: [],
          },
        })
      )
    ).rejects.toThrow();
  });

  it('refuses a document the entitlement generator could not read', async () => {
    const invalid: { label: string; meals: unknown }[] = [
      { label: 'not an array', meals: { meal: 'BREAKFAST' } },
      { label: 'unknown service', meals: [{ meal: 'BRUNCH', outlets: [], per_person: true }] },
      {
        label: 'the same service twice',
        meals: [
          { meal: 'BREAKFAST', outlets: [], per_person: true },
          { meal: 'BREAKFAST', outlets: [], per_person: false },
        ],
      },
      { label: 'no per_person decision', meals: [{ meal: 'LUNCH', outlets: [] }] },
      {
        label: 'outlets not an array',
        meals: [{ meal: 'LUNCH', outlets: 'outlet_one', per_person: true }],
      },
      {
        label: 'an outlet that is not a reference',
        meals: [{ meal: 'LUNCH', outlets: [7], per_person: true }],
      },
      {
        label: 'a cut-off no clock shows',
        meals: [{ meal: 'LUNCH', outlets: [], per_person: true, cutoff_time: '2pm' }],
      },
    ];
    for (const { label, meals } of invalid) {
      await expect(
        inOrg(ORG_A, (db) =>
          db.hotelMealPlan.create({
            data: {
              organizationId: ORG_A,
              branchId: tenant.a.branchId,
              code: `X${randomBytes(3).toString('hex').toUpperCase()}`,
              name: 'Invalid document',
              meals: meals as never,
            },
          })
        ),
        label
      ).rejects.toThrow();
    }
  });

  it('refuses a code or a name no voucher could print', async () => {
    for (const invalid of [
      { code: 'cp2', name: 'Lowercase code' },
      { code: 'A PLAN', name: 'Spaced code' },
      { code: 'GOODCODE', name: '   ' },
      { code: 'GOODCODE2', name: 'Empty Urdu name', nameUr: '  ' },
    ]) {
      await expect(
        inOrg(ORG_A, (db) =>
          db.hotelMealPlan.create({
            data: { organizationId: ORG_A, branchId: tenant.a.branchId, meals: [], ...invalid },
          })
        ),
        JSON.stringify(invalid)
      ).rejects.toThrow();
    }
  });

  it('accepts a custom plan with outlets and a cut-off', async () => {
    const custom = await inOrg(ORG_A, (db) =>
      db.hotelMealPlan.create({
        data: {
          organizationId: ORG_A,
          branchId: tenant.a.branchId,
          code: 'HB-TERRACE',
          name: 'Half board on the terrace',
          nameUr: 'چھت پر ناشتہ اور رات کا کھانا',
          meals: [
            {
              meal: 'BREAKFAST',
              outlets: ['outlet_terrace'],
              cutoff_time: '10:30',
              per_person: true,
            },
            { meal: 'DINNER', outlets: ['outlet_terrace'], cutoff_time: null, per_person: false },
          ],
          active: false,
        },
      })
    );
    expect(parseMealPlanMeals(custom.meals)).toEqual([
      { meal: 'BREAKFAST', outlets: ['outlet_terrace'], cutoff_time: '10:30', per_person: true },
      { meal: 'DINNER', outlets: ['outlet_terrace'], cutoff_time: null, per_person: false },
    ]);
  });
});

describeIfOwner('hotel_meal_plans forced row-level security', () => {
  const owner = new pg.Client({ connectionString: OWNER_DATABASE_URL });

  beforeAll(async () => {
    assertLocal(OWNER_DATABASE_URL!, 'owner');
    await owner.connect();
    const posture = await owner.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    expect(posture.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  }, 60_000);

  afterAll(async () => {
    await owner.end();
  });

  it('has row level security enabled AND forced, owned by this role', async () => {
    const result = await owner.query(
      `SELECT relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) = current_user AS owned
         FROM pg_catalog.pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname = 'hotel_meal_plans'`
    );
    expect(result.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true, owned: true }]);
  });

  it('filters the owning role too, which is what FORCE means', async () => {
    // The owner is the role migrations run as. With no tenant set and no
    // platform-admin flag, the policy must return nothing rather than everything.
    await owner.query('BEGIN');
    try {
      const unscoped = await owner.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "hotel_meal_plans"`
      );
      expect(unscoped.rows[0]!.count).toBe('0');
      await owner.query(`SELECT set_config('app.current_organization_id', $1, true)`, [ORG_A]);
      const scoped = await owner.query<{ code: string; organizationId: string }>(
        `SELECT "code", "organizationId" FROM "hotel_meal_plans" ORDER BY "code"`
      );
      // The defaults of ORG_A's property and nothing of ORG_B's — `arrayContaining`
      // because the tenant block above also left its custom plan here.
      expect(scoped.rows.map((row) => row.code)).toEqual(
        expect.arrayContaining(['AP', 'CP', 'EP', 'MAP'])
      );
      expect(new Set(scoped.rows.map((row) => row.organizationId))).toEqual(new Set([ORG_A]));
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
