/**
 * PROP-01 / PROP-04 — `hotel_properties` under real, forced row-level security.
 *
 * The acceptance criterion behind PROP-04 is "Property A user cannot read
 * property B (RLS negative test)", and the vertical-wide rule is that every
 * hotel table is tenant-scoped like pharmacy. Three things are proven here, and
 * they fail in different places on purpose:
 *
 *  - a tenant connection reads its own property and **not** another tenant's —
 *    the policy filters the row out rather than the query remembering to;
 *  - a write that names another tenant is refused by the policy's `WITH CHECK`,
 *    so a crafted `organizationId` cannot plant a row in someone else's
 *    workspace; and
 *  - the table is ENABLE **and** FORCE row level security, so even the owning
 *    role — a migration, a maintenance job — is filtered. FORCE is what makes
 *    the first two guarantees hold for connections that are not the app's.
 *
 * Skipped (never silently passed) when the database URL is absent.
 */
import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_HOTEL_PROPERTY_MODE } from '@/lib/hotel/property';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { seedDepartments } from '@/lib/test-support/departments';

const TEST_DATABASE_URL =
  process.env.HOTEL_PROPERTY_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const OWNER_DATABASE_URL = process.env.HOTEL_PROPERTY_TEST_OWNER_DATABASE_URL;

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const describeIfOwner = TEST_DATABASE_URL && OWNER_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_hotel_a_${suffix}`;
const ORG_B = `org_hotel_b_${suffix}`;

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
};
let deps: Deps;

/**
 * PROP-04 — each tenant now acts as a named user, because the restrictive
 * property policy resolves `app.current_user_id` against
 * `hotel_property_assignments`. An organization GUC on its own reaches nothing.
 */
const ACTOR: Record<string, string> = {
  [ORG_A]: `user_hotel_a_${suffix}`,
  [ORG_B]: `user_hotel_b_${suffix}`,
};
const ROLE: Record<string, string> = {
  [ORG_A]: `role_hotel_a_${suffix}`,
  [ORG_B]: `role_hotel_b_${suffix}`,
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
 * This used to create the property as the tenant. After PROP-04 no tenant
 * connection can create the first property of its own organization — the
 * restrictive `FOR ALL USING` doubles as the write check, no assignment can exist
 * before the row does, and there is no tenant self-bootstrap policy. That is the
 * policy working, and the denial is asserted explicitly below rather than being
 * left implicit in a fixture that fails.
 *
 * The assignment row is what keeps the isolation assertions honest. Without it
 * every read in this file would return nothing, and "ORG_A cannot see ORG_B's
 * property" would be true only because ORG_A can see nothing at all — a denial
 * that fires for everybody proves nothing about tenancy. Written with raw SQL
 * because the `HotelPropertyAssignment` delegate is not in the generated client
 * yet (G4); `id` and `updatedAt` are supplied because neither column has a
 * database default.
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
        bookingEngineSlug: `property-${label}`,
      },
    })
  );
  await asPlatform((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO "hotel_property_assignments"
         ("id", "organizationId", "branchId", "userId", "organizationRoleId", "active", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, true, CURRENT_TIMESTAMP)`,
      `hpa_${label}`,
      organizationId,
      property.branchId,
      ACTOR[organizationId]!,
      ROLE[organizationId]!
    )
  );
  return property;
}

let one: { branchId: string } | undefined;
let other: { branchId: string } | undefined;

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  deps = { withTenantDb: scoped.withTenantDb, withPlatformDb: scoped.withPlatformDb };

  // The assignment's composite foreign keys reach `users` and
  // `organization_roles`, so both tenants need a real organization, a real
  // hospitality role and a real ACTIVE user. `general-manager` is a hospitality
  // template key, which is what `requireHotelPropertyScope` filters on — a role
  // outside that set would be a row that grants SQL visibility and no tRPC scope.
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

  one = await propertyFixture(ORG_A, `a-${suffix}`);
  other = await propertyFixture(ORG_B, `b-${suffix}`);
});

describeIfDatabase('hotel_properties tenant isolation', () => {
  it('applies the column defaults the pack specifies', async () => {
    const property = await inOrg(ORG_A, (db) =>
      db.hotelProperty.findUniqueOrThrow({ where: { branchId: one!.branchId } })
    );
    // H-D14 default mode, PKR money, bilingual by default. The column default
    // and the constant the application reads are asserted to be the same value,
    // so a change to either without the other fails here rather than in a lane
    // that assumed a mode nobody chose.
    expect(property.mode).toBe('HOTEL');
    expect(DEFAULT_HOTEL_PROPERTY_MODE).toBe('HOTEL');
    expect(property.currency).toBe('PKR');
    expect(property.languages).toEqual(['en', 'ur']);
    expect(property.checkInTime).toBe('14:00');
    expect(property.checkOutTime).toBe('12:00');
    expect(property.auditTime).toBe('03:00');
    // Neither the tax profile nor the business-date policy is pre-seeded: the
    // onboarding checklist has to have something real to refuse.
    expect(property.taxProfileId).toBeNull();
    expect(property.businessDatePolicy).toEqual({});
  });

  it('reads its own property and never the other tenant’s', async () => {
    const mine = await inOrg(ORG_A, (db) => db.hotelProperty.findMany({}));
    expect(mine.map((row) => row.branchId)).toEqual([one!.branchId]);

    // Addressed by primary key — the id is correct and belongs to ORG_B, so only
    // the policy can be what withholds it.
    const stolen = await inOrg(ORG_A, (db) =>
      db.hotelProperty.findUnique({ where: { branchId: other!.branchId } })
    );
    expect(stolen).toBeNull();

    const theirs = await inOrg(ORG_B, (db) => db.hotelProperty.findMany({}));
    expect(theirs.map((row) => row.branchId)).toEqual([other!.branchId]);
  });

  it('refuses an update aimed at another tenant’s property', async () => {
    const result = await inOrg(ORG_A, (db) =>
      db.hotelProperty.updateMany({
        where: { branchId: other!.branchId },
        data: { name: 'Renamed by the wrong tenant' },
      })
    );
    expect(result.count).toBe(0);

    const untouched = await inOrg(ORG_B, (db) =>
      db.hotelProperty.findUniqueOrThrow({ where: { branchId: other!.branchId } })
    );
    expect(untouched.name).toBe(`Property b-${suffix}`);
  });

  it('refuses a row written under another tenant’s organization id', async () => {
    await expect(
      inOrg(ORG_A, (db) =>
        db.hotelProperty.create({
          data: {
            organizationId: ORG_B,
            name: 'Planted',
            addressLine: '1 Nowhere',
            city: 'Lahore',
            timezone: 'Asia/Karachi',
            bookingEngineSlug: `planted-${suffix}`,
          },
        })
      )
    ).rejects.toThrow();

    const theirs = await inOrg(ORG_B, (db) => db.hotelProperty.findMany({}));
    expect(theirs.map((row) => row.branchId)).toEqual([other!.branchId]);
  });

  // PROP-04 — the capability this file's fixture used to exercise implicitly, now
  // asserted explicitly as a denial rather than silently dropped. A tenant cannot
  // create the first property of its own organization: the restrictive policy's
  // `FOR ALL USING` doubles as the write check, the new row has no assignment, and
  // there is no tenant self-bootstrap policy. Provisioning and the audited
  // platform commands are the only writers.
  it('refuses a tenant creating a property of its own organization', async () => {
    await expect(
      inOrg(ORG_A, (db) =>
        db.hotelProperty.create({
          data: {
            organizationId: ORG_A,
            name: 'Self-bootstrapped',
            addressLine: '2 Nowhere',
            city: 'Lahore',
            timezone: 'Asia/Karachi',
            bookingEngineSlug: `self-${suffix}`,
          },
        })
      )
    ).rejects.toThrow();

    // And nothing landed: the tenant still sees exactly its one assigned property.
    const mine = await inOrg(ORG_A, (db) => db.hotelProperty.findMany({}));
    expect(mine.map((row) => row.branchId)).toEqual([one!.branchId]);
  });

  // The two cases below assert database CONSTRAINTS, so they are issued on the
  // control-plane connection — the one connection the restrictive policy admits.
  // On a tenant connection they would now be refused by RLS before PostgreSQL
  // ever consulted the index or the CHECK, and `rejects.toThrow()` would pass
  // while proving nothing about either. The claim is preserved by moving the
  // connection; re-scoping a tenant SECURITY assertion would not be.
  it('keeps one booking-engine address per organization', async () => {
    await expect(
      asPlatform((db) =>
        db.hotelProperty.create({
          data: {
            organizationId: ORG_A,
            name: 'Second property, same public address',
            addressLine: '13 Main Boulevard',
            city: 'Lahore',
            timezone: 'Asia/Karachi',
            bookingEngineSlug: `property-a-${suffix}`,
          },
        })
      )
    ).rejects.toThrow();

    // A different address under the same organization is accepted, so the refusal
    // above is the unique index and not the connection.
    const second = await asPlatform((db) =>
      db.hotelProperty.create({
        data: {
          organizationId: ORG_A,
          name: 'Second property, its own public address',
          addressLine: '13 Main Boulevard',
          city: 'Lahore',
          timezone: 'Asia/Karachi',
          bookingEngineSlug: `property-a2-${suffix}`,
        },
      })
    );
    expect(second.branchId).toBeTruthy();
    // Unassigned, so the tenant still reaches only the property it holds — the
    // positive control that this file's reads are assignment-scoped and not
    // merely organization-scoped.
    const mine = await inOrg(ORG_A, (db) => db.hotelProperty.findMany({}));
    expect(mine.map((row) => row.branchId)).toEqual([one!.branchId]);
  });

  it('refuses times and money the rest of the vertical could not read', async () => {
    for (const invalid of [
      { checkInTime: '2pm' },
      { checkOutTime: '25:00' },
      { auditTime: '3' },
      { currency: 'rupee' },
      { starCategory: 9 },
    ]) {
      await expect(
        asPlatform((db) =>
          db.hotelProperty.create({
            data: {
              organizationId: ORG_A,
              name: 'Invalid',
              addressLine: '1 Nowhere',
              city: 'Lahore',
              timezone: 'Asia/Karachi',
              bookingEngineSlug: `invalid-${randomBytes(4).toString('hex')}`,
              ...invalid,
            },
          })
        ),
        JSON.stringify(invalid)
      ).rejects.toThrow();
    }
  });
});

describeIfOwner('hotel_properties forced row-level security', () => {
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
          AND relname = 'hotel_properties'`
    );
    expect(result.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  it('filters the owning role too, which is what FORCE means', async () => {
    // The owner is the role migrations run as. With no tenant set and no
    // platform-admin flag, the policy must return nothing rather than everything.
    const unscoped = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "hotel_properties"`
    );
    expect(unscoped.rows[0]!.count).toBe('0');

    // PROP-04 — and the organization GUC alone is no longer enough, for the owning
    // role or anyone else. This used to return the property here; the restrictive
    // policy resolves `app.current_user_id` against the assignment table, and an
    // unset user GUC matches no row.
    await owner.query(`SELECT set_config('app.current_organization_id', $1, false)`, [ORG_A]);
    const withoutUser = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "hotel_properties"`
    );
    expect(withoutUser.rows[0]!.count).toBe('0');

    // With the assigned user named, the owning role sees exactly what that tenant
    // user sees — one property, not the table.
    await owner.query(`SELECT set_config('app.current_user_id', $1, false)`, [ACTOR[ORG_A]!]);
    const scoped = await owner.query<{ branchId: string }>(
      `SELECT "branchId" FROM "hotel_properties"`
    );
    expect(scoped.rows.map((row) => row.branchId)).toEqual([one!.branchId]);

    await owner.query(`SELECT set_config('app.current_organization_id', '', false)`);
    await owner.query(`SELECT set_config('app.current_user_id', '', false)`);
  });
});
