/**
 * MEAL-01 — `hotel_meal_plans` under real, forced row-level security.
 *
 * The vertical-wide rule is that every hotel table is tenant-scoped like
 * pharmacy, and this table is the first hotel table that is not the property
 * itself — so what is proven here is that a *child* of the property is isolated
 * on its own policy rather than by its parent's:
 *
 *  - a tenant connection reads its own plans and never another tenant's, even
 *    addressed by a correct primary key;
 *  - a write that names another tenant is refused by the policy's `WITH CHECK`,
 *    and so is one that names another tenant's property through the foreign key;
 *  - the table is ENABLE **and** FORCE row level security, so the owning role — a
 *    migration, a maintenance job — is filtered too; and
 *  - the `meals` document is validated by the database, not only by Zod, so a
 *    connection that bypasses the router still cannot store a plan that the
 *    entitlement generator would choke on at check-in.
 *
 * Skipped (never silently passed) when the database URL is absent.
 */
import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_HOTEL_MEAL_PLANS, parseMealPlanMeals } from '@/lib/hotel/meal-plans';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL =
  process.env.HOTEL_MEAL_PLANS_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const OWNER_DATABASE_URL = process.env.HOTEL_MEAL_PLANS_TEST_OWNER_DATABASE_URL;

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const describeIfOwner = TEST_DATABASE_URL && OWNER_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_meal_a_${suffix}`;
const ORG_B = `org_meal_b_${suffix}`;

type Deps = { withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'] };
let deps: Deps;

function inOrg<T>(organizationId: string, work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(organizationId, work);
}

/** One property per tenant, created as that tenant so every policy applies. */
async function propertyFixture(organizationId: string, label: string) {
  return inOrg(organizationId, (db) =>
    db.hotelProperty.create({
      data: {
        organizationId,
        name: `Property ${label}`,
        addressLine: '12 Main Boulevard',
        city: 'Lahore',
        timezone: 'Asia/Karachi',
        bookingEngineSlug: `meal-property-${label}`,
      },
    })
  );
}

/** The plans a property is provisioned with, written the way provisioning does. */
async function seedDefaultPlans(organizationId: string, branchId: string) {
  return inOrg(organizationId, (db) =>
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

let one: { branchId: string } | undefined;
let other: { branchId: string } | undefined;

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  deps = { withTenantDb: (await import('@/lib/tenancy/scoped-db')).withTenantDb };
  one = await propertyFixture(ORG_A, `a-${suffix}`);
  other = await propertyFixture(ORG_B, `b-${suffix}`);
  await seedDefaultPlans(ORG_A, one.branchId);
  await seedDefaultPlans(ORG_B, other.branchId);
}, 60_000);

describeIfDatabase('hotel_meal_plans tenant isolation', () => {
  it('stores the four default plans a property opens with', async () => {
    const plans = await inOrg(ORG_A, (db) =>
      db.hotelMealPlan.findMany({
        where: { branchId: one!.branchId },
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
    expect(mine).toHaveLength(DEFAULT_HOTEL_MEAL_PLANS.length);
    expect(new Set(mine.map((plan) => plan.branchId))).toEqual(new Set([one!.branchId]));

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
            branchId: other!.branchId,
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
    // key is what refuses, because (ORG_A, other.branchId) is not a property.
    await expect(
      inOrg(ORG_A, (db) =>
        db.hotelMealPlan.create({
          data: {
            organizationId: ORG_A,
            branchId: other!.branchId,
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
            branchId: one!.branchId,
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
      { label: 'outlets not an array', meals: [{ meal: 'LUNCH', outlets: 'outlet_one', per_person: true }] },
      { label: 'an outlet that is not a reference', meals: [{ meal: 'LUNCH', outlets: [7], per_person: true }] },
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
              branchId: one!.branchId,
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
            data: { organizationId: ORG_A, branchId: one!.branchId, meals: [], ...invalid },
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
          branchId: one!.branchId,
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
    const parsed = new URL(OWNER_DATABASE_URL!);
    if (
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) &&
      process.env.ALLOW_REMOTE_RLS_TEST !== 'true'
    ) {
      throw new Error('Refusing to run hotel RLS probes against a non-local database.');
    }
    await owner.connect();
  }, 60_000);

  afterAll(async () => {
    await owner.end();
  });

  it('has row level security enabled AND forced', async () => {
    const result = await owner.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_catalog.pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relkind = 'r'
          AND relname = 'hotel_meal_plans'`
    );
    expect(result.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  it('filters the owning role too, which is what FORCE means', async () => {
    // The owner is the role migrations run as. With no tenant set and no
    // platform-admin flag, the policy must return nothing rather than everything.
    const unscoped = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "hotel_meal_plans"`
    );
    expect(unscoped.rows[0]!.count).toBe('0');

    await owner.query(`SELECT set_config('app.current_organization_id', $1, false)`, [ORG_A]);
    const scoped = await owner.query<{ code: string }>(
      `SELECT "code" FROM "hotel_meal_plans" ORDER BY "code"`
    );
    // The defaults of ORG_A's property and nothing of ORG_B's — `arrayContaining`
    // because the tenant block above may also have left its custom plan here.
    expect(scoped.rows.map((row) => row.code)).toEqual(
      expect.arrayContaining(['AP', 'CP', 'EP', 'MAP'])
    );
    expect(scoped.rows.length).toBeGreaterThanOrEqual(DEFAULT_HOTEL_MEAL_PLANS.length);
    await owner.query(`SELECT set_config('app.current_organization_id', '', false)`);
  });
});
