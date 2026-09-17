/**
 * PROP-05 — `hotel_extras` under real, forced row-level security.
 *
 * The same three guarantees `property.db.test.ts` proves for the property record,
 * proved again for the catalog, because every hotel table is tenant-scoped like
 * pharmacy and a catalog is where a property's prices live:
 *
 *  - a tenant connection reads its own catalog and **not** another tenant's;
 *  - a write naming another tenant is refused by the policy's `WITH CHECK`; and
 *  - the table is ENABLE **and** FORCE row level security, so the owning role —
 *    a migration, a maintenance job — is filtered too.
 *
 * On top of that, the two rules the application also enforces are proved to hold
 * in the database, where an import or a hand-written row would land: one code per
 * property, and no offer price on an item that may not be offered.
 *
 * Skipped (never silently passed) when the database URL is absent.
 */
import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_HOTEL_EXTRA_RECURRENCE } from '@/lib/hotel/extras';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { seedDepartments } from '@/lib/test-support/departments';

const TEST_DATABASE_URL =
  process.env.HOTEL_EXTRAS_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const OWNER_DATABASE_URL = process.env.HOTEL_EXTRAS_TEST_OWNER_DATABASE_URL;

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const describeIfOwner = TEST_DATABASE_URL && OWNER_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_hotel_extras_a_${suffix}`;
const ORG_B = `org_hotel_extras_b_${suffix}`;

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
};
let deps: Deps;

/**
 * PROP-04 — each tenant acts as a named user. `hotel_extras` is plain
 * tenant-scoped, but its properties are not: the restrictive policy on
 * `hotel_properties` resolves `app.current_user_id` against
 * `hotel_property_assignments`, so a tenant with no assignment cannot create,
 * read or delete the property these catalogs hang off.
 */
const ACTOR: Record<string, string> = {
  [ORG_A]: `user_extras_a_${suffix}`,
  [ORG_B]: `user_extras_b_${suffix}`,
};
const ROLE: Record<string, string> = {
  [ORG_A]: `role_extras_a_${suffix}`,
  [ORG_B]: `role_extras_b_${suffix}`,
};

function inOrg<T>(organizationId: string, work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(organizationId, work, { userId: ACTOR[organizationId] });
}

/** As the control plane — `app.is_platform_admin = 'true'`, no tenant, no user. */
function asPlatform<T>(work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withPlatformDb(work);
}

/**
 * One property per tenant, **arranged** through the control plane and then
 * explicitly assigned to that tenant's actor.
 *
 * Only the arrange step moved. After PROP-04 a tenant connection cannot create a
 * property — the restrictive `FOR ALL USING` doubles as the write check and no
 * assignment can exist before the row — which is proven where it belongs, in
 * `property.db.test.ts`. The assignment row is what keeps every catalog assertion
 * below honest: without it the tenant could not reach its own property either,
 * and the isolation cases would pass because nothing is visible to anyone.
 *
 * Raw SQL for the assignment because the `HotelPropertyAssignment` delegate is
 * not in the generated client yet (G4); `id` and `updatedAt` are supplied because
 * neither column has a database default.
 */
async function propertyFixture(organizationId: string, label: string) {
  const property = await asPlatform((db) =>
    db.hotelProperty.create({
      data: {
        organizationId,
        name: `Property ${label}`,
        addressLine: '12 Main Boulevard',
        city: 'Lahore',
        timezone: 'Asia/Karachi',
        bookingEngineSlug: `extras-${label}`,
      },
    })
  );
  await asPlatform((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO "hotel_property_assignments"
         ("id", "organizationId", "branchId", "userId", "organizationRoleId", "active", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, true, CURRENT_TIMESTAMP)`,
      `hpa_extras_${label}`,
      organizationId,
      property.branchId,
      ACTOR[organizationId]!,
      ROLE[organizationId]!
    )
  );
  return property;
}

function extraData(organizationId: string, branchId: string, code: string) {
  return {
    organizationId,
    branchId,
    code,
    name: 'Laundry service',
    nameUr: 'کپڑے دھلائی',
    priceMinor: 45_000,
    taxClass: 'SERVICES',
    department: 'LAUNDRY' as const,
  };
}

let mine: { branchId: string } | undefined;
let theirs: { branchId: string } | undefined;
let myExtra: { id: string } | undefined;
let theirExtra: { id: string } | undefined;

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  deps = { withTenantDb: scoped.withTenantDb, withPlatformDb: scoped.withPlatformDb };

  // The assignment's composite foreign keys reach `users` and
  // `organization_roles`, so both tenants need a real organization, a real
  // hospitality role and a real ACTIVE user before any property is assigned.
  await asPlatform(async (db) => {
    for (const organizationId of [ORG_A, ORG_B]) {
      const slug = organizationId.replaceAll('_', '-');
      await db.organization.create({
        data: {
          id: organizationId,
          slug,
          legalName: `Hotel ${slug}`,
          displayName: `Hotel ${slug}`,
          vertical: 'HOSPITALITY',
          status: 'ACTIVE',
          primaryContactName: 'Ops',
          primaryContactEmail: `ops@${slug}.test`,
        },
      });
      // WHA-278: `User.department` is half a composite foreign key onto
      // `organization_departments(organizationId, key)`, so the actor below
      // cannot be written until this organization's catalog holds the key it is
      // filed under. Provisioning seeds the whole vertical catalog; a fixture
      // seeds only the key it uses. `FRONT_OFFICE` is a real HOSPITALITY key,
      // not an invented one, so this is the same row shape production writes.
      await seedDepartments(db, [organizationId], ['FRONT_OFFICE']);
      await db.organizationRole.create({
        data: {
          id: ROLE[organizationId]!,
          organizationId,
          key: 'general-manager',
          name: 'General Manager',
          isSystem: true,
        },
      });
      await db.user.create({
        data: {
          id: ACTOR[organizationId]!,
          organizationId,
          organizationRoleId: ROLE[organizationId]!,
          name: ACTOR[organizationId]!,
          email: `${ACTOR[organizationId]}@example.test`,
          password: 'x',
          department: 'FRONT_OFFICE',
          title: 'General Manager',
          role: 'EMPLOYEE',
          status: 'ACTIVE',
        },
      });
    }
  });

  mine = await propertyFixture(ORG_A, `a-${suffix}`);
  theirs = await propertyFixture(ORG_B, `b-${suffix}`);
  myExtra = await inOrg(ORG_A, (db) =>
    db.hotelExtra.create({ data: extraData(ORG_A, mine!.branchId, 'LAUNDRY') })
  );
  theirExtra = await inOrg(ORG_B, (db) =>
    db.hotelExtra.create({ data: extraData(ORG_B, theirs!.branchId, 'LAUNDRY') })
  );
});

describeIfDatabase('hotel_extras tenant isolation', () => {
  it('applies the column defaults PROP-05 specifies', async () => {
    const extra = await inOrg(ORG_A, (db) =>
      db.hotelExtra.findUniqueOrThrow({ where: { id: myExtra!.id } })
    );
    expect(extra.recurring).toBe('NONE');
    expect(DEFAULT_HOTEL_EXTRA_RECURRENCE).toBe('NONE');
    expect(extra.upsellable).toBe(false);
    expect(extra.upsellPriceMinor).toBeNull();
    expect(extra.postingRule).toEqual({});
    expect(extra.active).toBe(true);
    // Money is minor units all the way down: 450.00 PKR is stored as 45000.
    expect(extra.priceMinor).toBe(45_000);
  });

  it('reads its own catalog and never the other tenant’s', async () => {
    const ours = await inOrg(ORG_A, (db) => db.hotelExtra.findMany({}));
    expect(ours.map((row) => row.id)).toEqual([myExtra!.id]);

    // Addressed by primary key — the id is correct and belongs to ORG_B, so only
    // the policy can be what withholds it.
    const stolen = await inOrg(ORG_A, (db) =>
      db.hotelExtra.findUnique({ where: { id: theirExtra!.id } })
    );
    expect(stolen).toBeNull();
  });

  it('refuses an update aimed at another tenant’s catalog item', async () => {
    const result = await inOrg(ORG_A, (db) =>
      db.hotelExtra.updateMany({
        where: { id: theirExtra!.id },
        data: { priceMinor: 1 },
      })
    );
    expect(result.count).toBe(0);

    const untouched = await inOrg(ORG_B, (db) =>
      db.hotelExtra.findUniqueOrThrow({ where: { id: theirExtra!.id } })
    );
    expect(untouched.priceMinor).toBe(45_000);
  });

  it('refuses a row written under another tenant’s organization id', async () => {
    await expect(
      inOrg(ORG_A, (db) =>
        db.hotelExtra.create({ data: extraData(ORG_B, theirs!.branchId, `PLANTED`) })
      )
    ).rejects.toThrow();

    const theirCatalog = await inOrg(ORG_B, (db) => db.hotelExtra.findMany({}));
    expect(theirCatalog.map((row) => row.id)).toEqual([theirExtra!.id]);
  });

  it('refuses a catalog item hung off another tenant’s property', async () => {
    // The foreign key is composite — (organizationId, branchId) — so a correct
    // branch id belonging to someone else does not resolve to a property here.
    await expect(
      inOrg(ORG_A, (db) =>
        db.hotelExtra.create({ data: extraData(ORG_A, theirs!.branchId, 'BORROWED') })
      )
    ).rejects.toThrow();
  });

  it('keeps one code per property, and lets two properties share a code', async () => {
    await expect(
      inOrg(ORG_A, (db) =>
        db.hotelExtra.create({ data: extraData(ORG_A, mine!.branchId, 'LAUNDRY') })
      )
    ).rejects.toThrow();
    // ORG_B already has its own LAUNDRY, created in `beforeAll`: the uniqueness is
    // per property, not per platform.
    const theirCatalog = await inOrg(ORG_B, (db) => db.hotelExtra.findMany({}));
    expect(theirCatalog.map((row) => row.code)).toEqual(['LAUNDRY']);
  });

  it('refuses an offer price on an item that may not be offered', async () => {
    await expect(
      inOrg(ORG_A, (db) =>
        db.hotelExtra.create({
          data: {
            ...extraData(ORG_A, mine!.branchId, 'EARLYIN'),
            upsellable: false,
            upsellPriceMinor: 39_000,
          },
        })
      )
    ).rejects.toThrow();

    // The same rule holds on the way in from an update, not only on create.
    await expect(
      inOrg(ORG_A, (db) =>
        db.hotelExtra.update({
          where: { id: myExtra!.id },
          data: { upsellPriceMinor: 39_000 },
        })
      )
    ).rejects.toThrow();
  });

  it('accepts an offerable item priced for the offer', async () => {
    const offered = await inOrg(ORG_A, (db) =>
      db.hotelExtra.create({
        data: {
          ...extraData(ORG_A, mine!.branchId, 'LATEOUT'),
          name: 'Late checkout',
          upsellable: true,
          upsellPriceMinor: 39_000,
          recurring: 'PER_STAY',
        },
      })
    );
    expect(offered.upsellPriceMinor).toBe(39_000);
    expect(offered.recurring).toBe('PER_STAY');
  });

  it('refuses codes, tax classes, names and prices the rest of the vertical could not read', async () => {
    for (const [label, invalid] of [
      ['a code with a space', { code: 'LATE CHECKOUT' }],
      ['a lowercase code', { code: 'laundry2' }],
      ['a tax class with punctuation', { taxClass: 'SERVICES!' }],
      ['a blank name', { name: '   ' }],
      ['a blank Urdu name that should have been null', { nameUr: '  ' }],
      ['a negative price', { priceMinor: -1 }],
    ] as const) {
      await expect(
        inOrg(ORG_A, (db) =>
          db.hotelExtra.create({
            data: {
              ...extraData(
                ORG_A,
                mine!.branchId,
                `X${randomBytes(3).toString('hex').toUpperCase()}`
              ),
              ...invalid,
            },
          })
        ),
        label
      ).rejects.toThrow();
    }
  });

  it('cascades with the property, so a removed property leaves no orphan prices', async () => {
    const scratch = await propertyFixture(ORG_A, `scratch-${suffix}`);
    await inOrg(ORG_A, (db) =>
      db.hotelExtra.create({ data: extraData(ORG_A, scratch.branchId, 'BREAKFAST') })
    );
    await inOrg(ORG_A, (db) =>
      db.hotelProperty.deleteMany({ where: { branchId: scratch.branchId } })
    );
    const left = await inOrg(ORG_A, (db) =>
      db.hotelExtra.findMany({ where: { branchId: scratch.branchId } })
    );
    expect(left).toEqual([]);
  });
});

describeIfOwner('hotel_extras forced row-level security', () => {
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
          AND relname = 'hotel_extras'`
    );
    expect(result.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  it('filters the owning role too, which is what FORCE means', async () => {
    const unscoped = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "hotel_extras"`
    );
    expect(unscoped.rows[0]!.count).toBe('0');

    await owner.query(`SELECT set_config('app.current_organization_id', $1, false)`, [ORG_B]);
    const scoped = await owner.query<{ id: string }>(`SELECT "id" FROM "hotel_extras"`);
    expect(scoped.rows.map((row) => row.id)).toEqual([theirExtra!.id]);
    await owner.query(`SELECT set_config('app.current_organization_id', '', false)`);
  });
});
