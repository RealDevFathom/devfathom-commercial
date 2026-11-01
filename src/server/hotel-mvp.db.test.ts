/**
 * @vitest-environment node
 *
 * Hotel MVP (PR #964) against a REAL migrated PostgreSQL, as the restricted
 * runtime role: forced RLS on every new table, cross-tenant invisibility,
 * reservation idempotency (exact replay and payload conflict), the last room
 * sold exactly once under two concurrent bookings, prices marked used, and the
 * folio ledger's append-only, single-reversal, open-folio and currency rules.
 *
 * Requires TEST_DATABASE_URL (a disposable, migrated, local database reached as
 * a role that is neither SUPERUSER nor BYPASSRLS — asserted first). Without the
 * URL the suite reports itself skipped rather than passing vacuously. The
 * tenant-level SQL probes (purge path, refund cap, org-B inserts) live in
 * `scripts/verify-tenant-isolation.ts`.
 */
import { randomBytes } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PrismaClient, Prisma } from '@/generated/prisma/client';

vi.mock('server-only', () => ({}));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

// See jobs.purge.db.test.ts: a connection string avoids the cross-realm pg.Pool
// instanceof failure the shared client hits under Vitest.
vi.mock('@/lib/db', () => ({
  db: new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL, max: 10 }),
    log: ['error'],
  }),
}));

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');

type Scope = { organizationId: string; branchId: string; userId: string };
const scope: Scope = { organizationId: `hotel_mvp_a_${suffix}`, branchId: '', userId: '' };
const other: Scope = { organizationId: `hotel_mvp_b_${suffix}`, branchId: '', userId: '' };

const TABLES = [
  'hotel_guests',
  'hotel_confirmation_sequences',
  'hotel_rate_plans',
  'hotel_rate_plan_prices',
  'hotel_reservations',
  'hotel_reservation_stay_units',
  'hotel_folios',
  'hotel_folio_entries',
  'hotel_folio_payments',
  'hotel_operation_idempotency_keys',
  'hotel_housekeeping_tasks',
];

type Db = PrismaClient;
let db: PrismaClient;
let withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
let service: typeof import('@/server/hotel-reservation-service');
let store: typeof import('@/server/hotel-reservation-store');
let ledger: typeof import('@/lib/hotel/folio-ledger');
let ledgerStore: typeof import('@/lib/hotel/folio-ledger-store');
let reservations: typeof import('@/lib/hotel/reservations');

const fixture = { roomTypeId: '', ratePlanId: '', priceId: '', extraId: '' };

function within<T>(s: Scope, run: (tx: Db) => Promise<T>) {
  return withTenantDb(s.organizationId, run, { userId: s.userId });
}

/** One sellable ROOM type with `rooms` rooms, a plan in PKR and a published price. */
async function seedInventory(s: Scope, rooms: number) {
  const { createInventoryRoom, hotelRoomCreateInput, hotelRoomTypeCreateInput, withHotelInventory } =
    await import('@/lib/hotel/inventory');
  const inventoryScope = { organizationId: s.organizationId, branchId: s.branchId, actorId: s.userId };
  const type = await within(s, (tx) =>
    withHotelInventory(tx, inventoryScope, 'Hotel MVP fixture', (inner) =>
      inner.hotelRoomType.create({
        data: {
          ...hotelRoomTypeCreateInput.parse({
            code: `T${randomBytes(4).toString('hex')}`.toUpperCase(),
            name: 'Fixture',
            inventoryKind: 'ROOM',
            baseAdults: 1,
            maxAdults: 2,
            maxChildren: 0,
          }),
          organizationId: s.organizationId,
          branchId: s.branchId,
        },
      })
    )
  );
  for (let index = 0; index < rooms; index += 1) {
    await within(s, (tx) =>
      withHotelInventory(tx, inventoryScope, 'Hotel MVP fixture', (inner) =>
        createInventoryRoom(
          inner,
          inventoryScope,
          hotelRoomCreateInput.parse({
            roomTypeId: type.id,
            number: randomBytes(4).toString('hex'),
            reason: 'Commissioned',
          })
        )
      )
    );
  }
  const ratePlanId = `plan_${randomBytes(6).toString('hex')}`;
  const priceId = `price_${randomBytes(6).toString('hex')}`;
  await within(s, async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO hotel_rate_plans
        (id, "organizationId", "branchId", "roomTypeId", code, name, currency, "taxBasisPoints", "createdById")
      VALUES (${ratePlanId}, ${s.organizationId}, ${s.branchId}, ${type.id},
        ${`P${randomBytes(4).toString('hex')}`.toUpperCase()}, 'Best available', 'PKR', 1600, ${s.userId})`);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO hotel_rate_plan_prices
        (id, "organizationId", "branchId", "roomTypeId", "ratePlanId", "validFrom", "validTo", "netMinor", published, "createdById")
      VALUES (${priceId}, ${s.organizationId}, ${s.branchId}, ${type.id}, ${ratePlanId},
        DATE '2031-01-01', DATE '2031-12-31', 10000, true, ${s.userId})`);
  });
  return { roomTypeId: type.id, ratePlanId, priceId };
}

function bookingInput(key: string, roomTypeId: string, ratePlanId: string, lastName = 'Guest') {
  return reservations.reservationCreateInput.parse({
    branchId: scope.branchId,
    idempotencyKey: key,
    source: 'DIRECT',
    arrivalDate: '2031-03-02',
    departureDate: '2031-03-04',
    roomTypeId,
    ratePlanId,
    adults: 1,
    guest: { firstName: 'Isolation', lastName },
  });
}

/** The router's shape: property row locked first, then the whole command in one transaction. */
function book(s: Scope, input: ReturnType<typeof bookingInput>) {
  return within(s, async (tx) => {
    await tx.$queryRaw`SELECT "branchId" FROM "hotel_properties"
      WHERE "organizationId" = ${s.organizationId} AND "branchId" = ${s.branchId} FOR UPDATE`;
    return service.createReservation(
      store.createPrismaReservationStore(tx),
      { organizationId: s.organizationId, branchId: s.branchId },
      s.userId,
      input
    );
  });
}

function folioLedger(tx: Db, s: Scope) {
  return ledger.createFolioLedgerService(
    ledgerStore.createPrismaFolioLedgerStore(tx, s.userId),
    async () => undefined
  );
}

describeIfDatabase('hotel MVP with restricted runtime and forced RLS', () => {
  beforeAll(async () => {
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      if (
        !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(TEST_DATABASE_URL!).hostname)
      ) {
        throw new Error('Hotel MVP tests require a local disposable database');
      }
      const posture = await client.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      expect(posture.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    } finally {
      await client.end();
    }
    ({ withTenantDb } = await import('@/lib/tenancy/scoped-db'));
    const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
    ({ db } = await import('@/lib/db'));
    service = await import('@/server/hotel-reservation-service');
    store = await import('@/server/hotel-reservation-store');
    ledger = await import('@/lib/hotel/folio-ledger');
    ledgerStore = await import('@/lib/hotel/folio-ledger-store');
    reservations = await import('@/lib/hotel/reservations');
    const { seedHotelTenant } = await import('@/lib/testing/hotel-tenant-fixture');

    const tenantA = await seedHotelTenant(withPlatformDb, {
      organizationId: scope.organizationId,
      properties: [{ name: 'Main property' }],
    });
    const tenantB = await seedHotelTenant(withPlatformDb, {
      organizationId: other.organizationId,
      properties: [{ name: 'Other property' }],
    });
    Object.assign(scope, { branchId: tenantA.branchIds[0], userId: tenantA.userId });
    Object.assign(other, { branchId: tenantB.branchIds[0], userId: tenantB.userId });

    Object.assign(fixture, await seedInventory(scope, 3));
    fixture.extraId = `extra_${randomBytes(6).toString('hex')}`;
    await within(scope, (tx) =>
      tx.$executeRaw(Prisma.sql`
        INSERT INTO hotel_extras
          (id, "organizationId", "branchId", code, name, "priceMinor", "taxClass", department, "postingRule", "updatedAt")
        VALUES (${fixture.extraId}, ${scope.organizationId}, ${scope.branchId}, 'LAUNDRY', 'Laundry', 500,
          'SERVICES', 'LAUNDRY', '{"taxBasisPoints": 1600}'::jsonb, CURRENT_TIMESTAMP)`)
    );
    // Tenant B holds a reservation of its own, so isolation is not vacuous.
    const otherInventory = await seedInventory(other, 1);
    await book(other, {
      ...bookingInput(`other-${suffix}`, otherInventory.roomTypeId, otherInventory.ratePlanId),
      branchId: other.branchId,
    });
  }, 120_000);

  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  it('enables and forces RLS on every new table, and no housekeeping status table remains', async () => {
    const rows = await within(scope, (tx) =>
      tx.$queryRaw<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = ANY(${TABLES}) AND relkind = 'r' ORDER BY relname`
    );
    expect(rows).toEqual(
      TABLES.toSorted().map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true }))
    );
    const parallel = await within(scope, (tx) =>
      tx.$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM pg_class WHERE relname = 'hotel_room_housekeeping'`
    );
    expect(parallel).toEqual([{ count: 0 }]);
  });

  it('replays an exact retry, refuses a reused key, and marks the snapshotted price used', async () => {
    const input = bookingInput(`replay-${suffix}`, fixture.roomTypeId, fixture.ratePlanId);
    const first = await book(scope, input);
    const again = await book(scope, input);
    expect(again).toEqual(first);
    await expect(
      book(scope, { ...input, guest: { ...input.guest, lastName: 'Someone else' } })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const counted = await within(scope, (tx) =>
      tx.$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM hotel_reservations
        WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId} AND id = ${first.id}`
    );
    expect(counted).toEqual([{ count: 1 }]);
    const used = await within(scope, (tx) =>
      tx.$queryRaw<{ used: boolean }[]>`
        SELECT "usedAt" IS NOT NULL AS used FROM hotel_rate_plan_prices WHERE id = ${fixture.priceId}`
    );
    expect(used).toEqual([{ used: true }]);
  });

  it('hides every new row of another tenant without a query filter', async () => {
    for (const table of TABLES) {
      const rows = await within(scope, (tx) =>
        tx.$queryRawUnsafe<{ organizationId: string }[]>(`SELECT "organizationId" FROM "${table}"`)
      );
      expect(rows.every((row) => row.organizationId === scope.organizationId)).toBe(true);
    }
    const foreign = await within(other, (tx) =>
      tx.$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM hotel_reservations WHERE "organizationId" = ${scope.organizationId}`
    );
    expect(foreign).toEqual([{ count: 0 }]);
  });

  it('sells the last room exactly once under two concurrent bookings', async () => {
    const lastRoom = await seedInventory(scope, 1);
    const results = await Promise.allSettled([
      book(scope, bookingInput(`race-a-${suffix}`, lastRoom.roomTypeId, lastRoom.ratePlanId, 'Racer A')),
      book(scope, bookingInput(`race-b-${suffix}`, lastRoom.roomTypeId, lastRoom.ratePlanId, 'Racer B')),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.filter((result) => result.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'CONFLICT' });
    const sold = await within(scope, (tx) =>
      tx.$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM hotel_reservation_stay_units
        WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
          AND "roomTypeId" = ${lastRoom.roomTypeId}`
    );
    expect(sold).toEqual([{ count: 1 }]);
  });

  it('keeps the folio ledger append-only, reversed once, open-only and single-currency', async () => {
    const created = await book(
      scope,
      bookingInput(`folio-${suffix}`, fixture.roomTypeId, fixture.ratePlanId, 'Folio')
    );
    const keys = { organizationId: scope.organizationId, branchId: scope.branchId };
    const entry = await within(scope, (tx) =>
      folioLedger(tx, scope).post(keys, {
        folioId: created.folioId,
        catalogItemId: fixture.extraId,
        quantity: 2,
      })
    );
    // 2 × 500 net, 16% tax, priced by the server from the catalog.
    expect(entry).toMatchObject({ netMinor: BigInt(1_000), taxMinor: BigInt(160), grossMinor: BigInt(1_160) });
    const entryId = String(entry.id);

    await expect(
      within(scope, (tx) =>
        tx.$executeRaw`UPDATE hotel_folio_entries SET description = 'rewritten' WHERE id = ${entryId}`
      )
    ).rejects.toThrow();
    await expect(
      within(scope, (tx) => tx.$executeRaw`DELETE FROM hotel_folio_entries WHERE id = ${entryId}`)
    ).rejects.toThrow();

    await within(scope, (tx) => folioLedger(tx, scope).reverse(keys, entryId, 'Posted twice'));
    await expect(
      within(scope, (tx) => folioLedger(tx, scope).reverse(keys, entryId, 'Again'))
    ).rejects.toThrow();

    // A foreign-currency entry is refused by the folio guard.
    await expect(
      within(scope, (tx) =>
        tx.$executeRaw(Prisma.sql`
          INSERT INTO hotel_folio_entries
            (id, "organizationId", "branchId", "folioId", kind, "catalogItemId", description, quantity,
             "unitMinor", "netMinor", "taxMinor", "grossMinor", currency, "createdById")
          VALUES (${`usd_${suffix}`}, ${scope.organizationId}, ${scope.branchId}, ${created.folioId}, 'EXTRA',
            ${fixture.extraId}, 'Laundry', 1, 500, 500, 0, 500, 'USD', ${scope.userId})`)
      )
    ).rejects.toThrow();

    // Once the folio is closed, neither a posting nor a correction moves it.
    await within(scope, (tx) =>
      tx.$executeRaw`UPDATE hotel_folios SET status = 'CLOSED' WHERE id = ${created.folioId}`
    );
    await expect(
      within(scope, (tx) =>
        folioLedger(tx, scope).post(keys, {
          folioId: created.folioId,
          catalogItemId: fixture.extraId,
          quantity: 1,
        })
      )
    ).rejects.toThrow(/unavailable/);
    const second = await within(scope, (tx) =>
      tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM hotel_folio_entries WHERE "folioId" = ${created.folioId} AND "reversesEntryId" IS NULL`
    );
    expect(second).toHaveLength(1);

    const balance = await within(scope, (tx) => store.readFolioEvidence(tx, keys, created.id));
    expect(balance?.balanceMinor).toBe(BigInt(0));
  });

  it('refuses a rate plan in a currency other than the property’s', async () => {
    await expect(
      within(scope, (tx) =>
        tx.$executeRaw(Prisma.sql`
          INSERT INTO hotel_rate_plans
            (id, "organizationId", "branchId", "roomTypeId", code, name, currency, "taxBasisPoints", "createdById")
          VALUES (${`usd_plan_${suffix}`}, ${scope.organizationId}, ${scope.branchId}, ${fixture.roomTypeId},
            'USDPLAN', 'Dollar plan', 'USD', 0, ${scope.userId})`)
      )
    ).rejects.toThrow();
  });
});
