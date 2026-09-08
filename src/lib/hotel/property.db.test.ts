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
        bookingEngineSlug: `property-${label}`,
      },
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

  it('keeps one booking-engine address per organization', async () => {
    await expect(
      inOrg(ORG_A, (db) =>
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
        inOrg(ORG_A, (db) =>
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

    await owner.query(`SELECT set_config('app.current_organization_id', $1, false)`, [ORG_A]);
    const scoped = await owner.query<{ branchId: string }>(
      `SELECT "branchId" FROM "hotel_properties"`
    );
    expect(scoped.rows.map((row) => row.branchId)).toEqual([one!.branchId]);
    await owner.query(`SELECT set_config('app.current_organization_id', '', false)`);
  });
});
