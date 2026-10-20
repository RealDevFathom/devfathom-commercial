/**
 * @vitest-environment node
 *
 * PROP-07 / invariant 25 against a REAL migrated PostgreSQL: forced RLS on
 * `hotel_function_spaces` and `hotel_space_bookings`, the property-pinned
 * foreign keys, the trigger-maintained buffered range, the gist exclusion that
 * holds "one function per slot, buffers included", the rebuffer trigger, and
 * the lib's SQL booking write agreeing with the database's arithmetic.
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the
 * restricted runtime role (neither SUPERUSER nor BYPASSRLS — asserted first,
 * because everything below is decided by row-level security and a bypassing
 * role would make it vacuous). The owner probes need OWNER_DATABASE_URL too.
 * Without the URLs the suite reports itself skipped rather than passing
 * vacuously.
 *
 * The tenants are seeded from the control plane (`seedHotelTenant`), the way
 * provisioning creates them: the RESTRICTIVE property policy makes a property
 * unreachable from inside the tenant until an assignment names the acting
 * user, so a property cannot be created from inside a tenant transaction. The
 * constraint probes then run on a raw pg client as the tenant, each inside a
 * transaction that is rolled back, because the SQLSTATE and the constraint
 * name are what they pin.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '@/generated/prisma/client';
import {
  createFunctionSpace,
  hotelFunctionSpaceCreateInput,
  hotelSpaceBookingInput,
  insertSpaceBooking,
  listSpaceBookings,
  releaseSpaceHold,
  spaceAvailability,
} from '@/lib/hotel/function-spaces';
import { evaluateHotelReadiness } from '@/lib/hotel/onboarding-checklist';

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
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];
function assertLocal(url: string) {
  if (
    !LOCAL_HOSTS.includes(new URL(url).hostname) &&
    process.env.ALLOW_REMOTE_RLS_TEST !== 'true'
  ) {
    throw new Error('Function-space DB tests require a local disposable database.');
  }
}

type Tenant = { organizationId: string; userId: string; branchId: string; secondBranchId: string };
const tenantA: Tenant = {
  organizationId: `hotel_spaces_a_${suffix}`,
  userId: '',
  branchId: '',
  secondBranchId: '',
};
const tenantB: Tenant = {
  organizationId: `hotel_spaces_b_${suffix}`,
  userId: '',
  branchId: '',
  secondBranchId: '',
};
const tables = ['hotel_function_spaces', 'hotel_space_bookings'];

let db: PrismaClient;
let withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];

async function seedTenants() {
  const scoped = await import('@/lib/tenancy/scoped-db');
  withTenantDb = scoped.withTenantDb;
  ({ db } = await import('@/lib/db'));
  const { seedHotelTenant } = await import('@/lib/testing/hotel-tenant-fixture');
  for (const tenant of [tenantA, tenantB]) {
    const seeded = await seedHotelTenant(scoped.withPlatformDb, {
      organizationId: tenant.organizationId,
      properties: [{ name: 'Main venue' }, { name: 'Second venue' }],
    });
    tenant.userId = seeded.userId;
    tenant.branchId = seeded.branchIds[0]!;
    tenant.secondBranchId = seeded.branchIds[1]!;
  }
}

/** Act as the tenant on a raw connection: the same two GUCs the scoped client sets. */
async function actAs(client: pg.Client, tenant: Tenant) {
  await client.query(
    `SELECT set_config('app.current_organization_id', $1, true),
            set_config('app.current_user_id', $2, true),
            set_config('app.is_platform_admin', 'false', true)`,
    [tenant.organizationId, tenant.userId]
  );
}

async function spaceFixture(client: pg.Client, tenant: Tenant, branchId = tenant.branchId) {
  await actAs(client, tenant);
  const spaceId = randomUUID();
  await client.query(
    `INSERT INTO hotel_function_spaces
      (id, "organizationId", "branchId", name, layouts, "setupMinutes", "teardownMinutes", "updatedAt")
     VALUES ($1, $2, $3, $4, '[{"layout":"Theatre","capacity":100}]', 30, 15, now())`,
    [spaceId, tenant.organizationId, branchId, `Hall ${spaceId.slice(0, 8)}`]
  );
  return { spaceId, branchId, organizationId: tenant.organizationId, userId: tenant.userId };
}
type Space = Awaited<ReturnType<typeof spaceFixture>>;

async function book(
  client: pg.Client,
  space: Space,
  startsAt: string,
  endsAt: string,
  kind = 'FUNCTION'
) {
  const result = await client.query<{ id: string }>(
    `INSERT INTO hotel_space_bookings
      ("organizationId", "branchId", "spaceId", "startsAt", "endsAt", kind, "createdBy", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6::"HotelSpaceBookingKind", $7, now())
     RETURNING id`,
    [space.organizationId, space.branchId, space.spaceId, startsAt, endsAt, kind, space.userId]
  );
  return result.rows[0]!.id;
}

async function rejectedWrite(
  client: pg.Client,
  write: () => Promise<unknown>,
  code: string,
  constraint?: string
) {
  await client.query('SAVEPOINT rejected_write');
  try {
    await expect(write()).rejects.toMatchObject({ code, ...(constraint ? { constraint } : {}) });
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT rejected_write');
    await client.query('RELEASE SAVEPOINT rejected_write');
  }
}

describeIfDatabase('function spaces: database overlap and tenant boundaries', () => {
  let client: pg.Client;
  let one: Space;
  let other: Space;
  beforeAll(async () => {
    assertLocal(TEST_DATABASE_URL!);
    client = new pg.Client({
      connectionString: TEST_DATABASE_URL,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    await client.connect();
    const role = await client.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await seedTenants();
  }, 60_000);
  beforeEach(async () => {
    await client.query('BEGIN');
    one = await spaceFixture(client, tenantA);
    other = await spaceFixture(client, tenantB);
    await book(client, other, '2030-01-01T10:00:00Z', '2030-01-01T11:00:00Z');
    await actAs(client, tenantA);
  });
  afterEach(async () => {
    if (client) await client.query('ROLLBACK');
  });
  afterAll(async () => {
    if (client) await client.end();
    if (db) await db.$disconnect();
  });

  it('pins both tables to ENABLE and FORCE RLS', async () => {
    const flags = await client.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE oid = ANY($1::regclass[]) ORDER BY relname`,
      [tables]
    );
    expect(flags.rows).toEqual(
      tables.map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true }))
    );
  });

  it('derives the half-open range from setup and teardown buffers, with a database-generated id', async () => {
    const id = await book(client, one, '2030-01-01T10:00:00Z', '2030-01-01T11:00:00Z');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const result = await client.query(
      `SELECT lower("bufferedRange") AS start, upper("bufferedRange") AS finish,
              lower_inc("bufferedRange") AS "lowerIncluded", upper_inc("bufferedRange") AS "upperIncluded"
         FROM hotel_space_bookings WHERE id = $1`,
      [id]
    );
    expect(result.rows).toEqual([
      {
        start: new Date('2030-01-01T09:30:00Z'),
        finish: new Date('2030-01-01T11:15:00Z'),
        lowerIncluded: true,
        upperIncluded: false,
      },
    ]);
  });

  it('rejects overlapping bookings through the exclusion constraint', async () => {
    await book(client, one, '2030-01-01T10:00:00Z', '2030-01-01T11:00:00Z');
    await rejectedWrite(
      client,
      () => book(client, one, '2030-01-01T10:30:00Z', '2030-01-01T11:30:00Z'),
      '23P01',
      'hotel_space_bookings_space_no_overlap'
    );
  });

  it('makes adjacent bookings collide when buffers need turnaround time', async () => {
    await book(client, one, '2030-01-01T10:00:00Z', '2030-01-01T11:00:00Z', 'HOLD');
    await rejectedWrite(
      client,
      () => book(client, one, '2030-01-01T11:00:00Z', '2030-01-01T12:00:00Z'),
      '23P01',
      'hotel_space_bookings_space_no_overlap'
    );
  });

  it('allows a gap covering teardown plus setup exactly', async () => {
    await book(client, one, '2030-01-01T10:00:00Z', '2030-01-01T11:00:00Z');
    await book(client, one, '2030-01-01T11:45:00Z', '2030-01-01T12:45:00Z');
    expect((await client.query('SELECT id FROM hotel_space_bookings')).rowCount).toBe(2);
  });

  it('allows direct adjacency with zero buffers', async () => {
    await client.query(
      'UPDATE hotel_function_spaces SET "setupMinutes" = 0, "teardownMinutes" = 0 WHERE id = $1',
      [one.spaceId]
    );
    await book(client, one, '2030-01-01T10:00:00Z', '2030-01-01T11:00:00Z');
    await book(client, one, '2030-01-01T11:00:00Z', '2030-01-01T12:00:00Z');
    expect((await client.query('SELECT id FROM hotel_space_bookings')).rowCount).toBe(2);
  });

  it('rejects a buffer edit that would collide existing bookings and rolls it back', async () => {
    await book(client, one, '2030-01-01T10:00:00Z', '2030-01-01T11:00:00Z');
    await book(client, one, '2030-01-01T11:45:00Z', '2030-01-01T12:45:00Z');
    await rejectedWrite(
      client,
      () =>
        client.query('UPDATE hotel_function_spaces SET "setupMinutes" = 31 WHERE id = $1', [
          one.spaceId,
        ]),
      '23P01',
      'hotel_space_bookings_space_no_overlap'
    );
    expect(
      (
        await client.query('SELECT "setupMinutes" FROM hotel_function_spaces WHERE id = $1', [
          one.spaceId,
        ])
      ).rows
    ).toEqual([{ setupMinutes: 30 }]);
    // Narrowing re-ranges the bookings and is admitted.
    await client.query('UPDATE hotel_function_spaces SET "setupMinutes" = 10 WHERE id = $1', [
      one.spaceId,
    ]);
    const ranges = await client.query<{ start: Date }>(
      `SELECT lower("bufferedRange") AS start FROM hotel_space_bookings WHERE "spaceId" = $1 ORDER BY "startsAt"`,
      [one.spaceId]
    );
    expect(ranges.rows.map((row) => row.start)).toEqual([
      new Date('2030-01-01T09:50:00Z'),
      new Date('2030-01-01T11:35:00Z'),
    ]);
  });

  it('recomputes a range written around the trigger, so the collision it hid is still refused', async () => {
    // 20261021104000 (a). The trigger fires on every update, so a direct write
    // to the column is overwritten from the booking's bounds and the buffers.
    const id = await book(client, one, '2030-01-01T10:00:00Z', '2030-01-01T11:00:00Z');
    const overwritten = await client.query(
      `UPDATE hotel_space_bookings SET "bufferedRange" = 'empty' WHERE id = $1`,
      [id]
    );
    expect(overwritten.rowCount).toBe(1);
    const range = await client.query(
      `SELECT lower("bufferedRange") AS start, upper("bufferedRange") AS finish
         FROM hotel_space_bookings WHERE id = $1`,
      [id]
    );
    expect(range.rows).toEqual([
      { start: new Date('2030-01-01T09:30:00Z'), finish: new Date('2030-01-01T11:15:00Z') },
    ]);
    await rejectedWrite(
      client,
      () => book(client, one, '2030-01-01T10:30:00Z', '2030-01-01T11:30:00Z'),
      '23P01',
      'hotel_space_bookings_space_no_overlap'
    );
  });

  it('refuses a document the layouts validator cannot read, including an entry with a member missing', async () => {
    for (const layouts of [
      '[]',
      '{"layout":"Theatre","capacity":10}',
      '[{"layout":"Theatre"}]',
      '[{"capacity":100}]',
      '[{"layout":"","capacity":100}]',
      '[{"layout":"Theatre","capacity":0}]',
      '[{"layout":"Theatre","capacity":12.5}]',
    ]) {
      await rejectedWrite(
        client,
        () =>
          client.query(
            `INSERT INTO hotel_function_spaces
              (id, "organizationId", "branchId", name, layouts, "updatedAt")
             VALUES ($1, $2, $3, $4, $5::jsonb, now())`,
            [randomUUID(), one.organizationId, one.branchId, `Invalid ${randomUUID()}`, layouts]
          ),
        '23514',
        'hotel_function_spaces_layouts_ck'
      );
    }
    await rejectedWrite(
      client,
      () =>
        client.query(
          `INSERT INTO hotel_function_spaces
            (id, "organizationId", "branchId", name, layouts, pricing, "updatedAt")
           VALUES ($1, $2, $3, $4, '[{"layout":"Theatre","capacity":10}]', '{"hourlyMinor": 4500.5}', now())`,
          [randomUUID(), one.organizationId, one.branchId, `Invalid ${randomUUID()}`]
        ),
      '23514',
      'hotel_function_spaces_pricing_ck'
    );
  });

  it('filters foreign spaces and bookings even without application tenant predicates', async () => {
    expect((await client.query('SELECT id FROM hotel_function_spaces')).rows).toEqual([
      { id: one.spaceId },
    ]);
    expect((await client.query('SELECT id FROM hotel_space_bookings')).rows).toEqual([]);
    expect(
      (
        await client.query('UPDATE hotel_function_spaces SET name = $1 WHERE id = $2', [
          'Stolen',
          other.spaceId,
        ])
      ).rowCount
    ).toBe(0);
    expect(
      (
        await client.query('UPDATE hotel_space_bookings SET ref = $1 WHERE "spaceId" = $2', [
          '{}',
          other.spaceId,
        ])
      ).rowCount
    ).toBe(0);
  });

  it('refuses foreign-tenant space and booking writes', async () => {
    await rejectedWrite(
      client,
      () =>
        client.query(
          `INSERT INTO hotel_function_spaces
            (id, "organizationId", "branchId", name, layouts, "updatedAt")
           VALUES ($1, $2, $3, 'Planted', '[{"layout":"Theatre","capacity":1}]', now())`,
          [randomUUID(), other.organizationId, other.branchId]
        ),
      '42501'
    );
    // The BEFORE trigger cannot see the foreign space under RLS and refuses
    // this booking before the row reaches the policy's WITH CHECK expression.
    await rejectedWrite(
      client,
      () => book(client, other, '2030-01-01T12:00:00Z', '2030-01-01T13:00:00Z'),
      'P0001'
    );
  });

  it('pins a space to a property of its own tenant and a booking to its space’s property', async () => {
    // Same tenant, the other tenant's property: the composite key refuses.
    await rejectedWrite(
      client,
      () =>
        client.query(
          `INSERT INTO hotel_function_spaces
            (id, "organizationId", "branchId", name, layouts, "updatedAt")
           VALUES ($1, $2, $3, 'Borrowed', '[{"layout":"Theatre","capacity":1}]', now())`,
          [randomUUID(), one.organizationId, other.branchId]
        ),
      '23503',
      'hotel_function_spaces_org_branch_fkey'
    );
    // Own space, but filed under the tenant's second property.
    await rejectedWrite(
      client,
      () =>
        book(
          client,
          { ...one, branchId: tenantA.secondBranchId },
          '2030-01-01T12:00:00Z',
          '2030-01-01T13:00:00Z'
        ),
      '23503',
      'hotel_space_bookings_space_fkey'
    );
  });

  it('keeps a space’s name unique per property and refuses deleting a space with bookings', async () => {
    await rejectedWrite(
      client,
      () =>
        client.query(
          `INSERT INTO hotel_function_spaces
            (id, "organizationId", "branchId", name, layouts, "updatedAt")
           SELECT $1, "organizationId", "branchId", name, layouts, now() FROM hotel_function_spaces WHERE id = $2`,
          [randomUUID(), one.spaceId]
        ),
      '23505',
      'hotel_function_spaces_org_branch_name_key'
    );
    await book(client, one, '2030-01-01T10:00:00Z', '2030-01-01T11:00:00Z');
    await rejectedWrite(
      client,
      () => client.query('DELETE FROM hotel_function_spaces WHERE id = $1', [one.spaceId]),
      '23503',
      'hotel_space_bookings_space_fkey'
    );
  });
});

describeIfDatabase('function spaces: the lib against the database', () => {
  beforeAll(async () => {
    assertLocal(TEST_DATABASE_URL!);
    if (!db) await seedTenants();
  }, 60_000);
  afterAll(async () => {
    if (db) await db.$disconnect();
  });
  const inA = <T>(work: (tx: Parameters<typeof createFunctionSpace>[0]) => Promise<T>) =>
    withTenantDb(tenantA.organizationId, (tx) => work(tx), { userId: tenantA.userId });

  it('creates a space, claims its time in SQL, and agrees with the database about what is free', async () => {
    const space = await inA((tx) =>
      createFunctionSpace(
        tx,
        tenantA.organizationId,
        tenantA.branchId,
        hotelFunctionSpaceCreateInput.parse({
          name: `Lawn ${suffix}`,
          layouts: [{ layout: 'Banquet', capacity: 400 }],
          setupMinutes: 60,
          teardownMinutes: 30,
        })
      )
    );
    const claim = hotelSpaceBookingInput.parse({
      spaceId: space.id,
      startsAt: '2031-03-01T13:00:00.000Z',
      endsAt: '2031-03-01T17:00:00.000Z',
      label: 'Nikkah — tentative',
    });
    const booking = await inA((tx) =>
      insertSpaceBooking(tx, tenantA.organizationId, tenantA.branchId, tenantA.userId, claim)
    );
    expect(booking).toMatchObject({
      spaceId: space.id,
      kind: 'HOLD',
      label: 'Nikkah — tentative',
      createdBy: tenantA.userId,
      startsAt: new Date('2031-03-01T13:00:00.000Z'),
    });
    // The library's arithmetic and the trigger's range say the same thing: a
    // start at 17:30 (30 teardown) is still inside the next booking's 60 setup.
    const tooEarly = await inA((tx) =>
      spaceAvailability(tx, tenantA.organizationId, tenantA.branchId, space, {
        startsAt: new Date('2031-03-01T18:29:00.000Z'),
        endsAt: new Date('2031-03-01T20:00:00.000Z'),
      })
    );
    expect(tooEarly.available).toBe(false);
    expect(tooEarly.conflicts.map((conflict) => conflict.id)).toEqual([booking.id]);
    await expect(
      inA((tx) =>
        insertSpaceBooking(tx, tenantA.organizationId, tenantA.branchId, tenantA.userId, {
          ...claim,
          startsAt: new Date('2031-03-01T18:29:00.000Z'),
          endsAt: new Date('2031-03-01T20:00:00.000Z'),
        })
      )
    ).rejects.toMatchObject({
      meta: expect.objectContaining({
        driverAdapterError: expect.objectContaining({
          cause: expect.objectContaining({ originalCode: '23P01' }),
        }),
      }),
    });
    const exactly = await inA((tx) =>
      spaceAvailability(tx, tenantA.organizationId, tenantA.branchId, space, {
        startsAt: new Date('2031-03-01T18:30:00.000Z'),
        endsAt: new Date('2031-03-01T20:00:00.000Z'),
      })
    );
    expect(exactly.available).toBe(true);
    const second = await inA((tx) =>
      insertSpaceBooking(tx, tenantA.organizationId, tenantA.branchId, tenantA.userId, {
        ...claim,
        kind: 'FUNCTION',
        startsAt: new Date('2031-03-01T18:30:00.000Z'),
        endsAt: new Date('2031-03-01T20:00:00.000Z'),
        label: 'Confirmed dinner',
      })
    );
    const diary = await inA((tx) =>
      listSpaceBookings(tx, tenantA.organizationId, tenantA.branchId, {
        spaceId: space.id,
        from: new Date('2031-01-01T00:00:00.000Z'),
      })
    );
    expect(diary.map((entry) => [entry.id, entry.kind, entry.label])).toEqual([
      [booking.id, 'HOLD', 'Nikkah — tentative'],
      [second.id, 'FUNCTION', 'Confirmed dinner'],
    ]);
    // Only the hold is releasable from this surface; the function stays.
    expect(
      await inA((tx) => releaseSpaceHold(tx, tenantA.organizationId, tenantA.branchId, second.id))
    ).toBe(0);
    expect(
      await inA((tx) => releaseSpaceHold(tx, tenantA.organizationId, tenantA.branchId, booking.id))
    ).toBe(1);
    expect(
      (
        await inA((tx) =>
          listSpaceBookings(tx, tenantA.organizationId, tenantA.branchId, {
            spaceId: space.id,
            from: new Date('2031-01-01T00:00:00.000Z'),
          })
        )
      ).map((entry) => entry.id)
    ).toEqual([second.id]);
  });

  it('never reads or releases another tenant’s claims', async () => {
    const theirs = await withTenantDb(
      tenantB.organizationId,
      async (tx) => {
        const space = await createFunctionSpace(
          tx,
          tenantB.organizationId,
          tenantB.branchId,
          hotelFunctionSpaceCreateInput.parse({
            name: `Boardroom ${suffix}`,
            layouts: [{ layout: 'Boardroom', capacity: 20 }],
          })
        );
        return insertSpaceBooking(
          tx,
          tenantB.organizationId,
          tenantB.branchId,
          tenantB.userId,
          hotelSpaceBookingInput.parse({
            spaceId: space.id,
            startsAt: '2031-04-01T09:00:00.000Z',
            endsAt: '2031-04-01T10:00:00.000Z',
            label: 'Board meeting',
          })
        );
      },
      { userId: tenantB.userId }
    );
    expect(
      await inA((tx) =>
        listSpaceBookings(tx, tenantA.organizationId, tenantA.branchId, {
          from: new Date('2031-01-01T00:00:00.000Z'),
        })
      )
    ).not.toContainEqual(expect.objectContaining({ id: theirs.id }));
    expect(
      await inA((tx) => releaseSpaceHold(tx, tenantA.organizationId, tenantA.branchId, theirs.id))
    ).toBe(0);
    expect(
      await inA((tx) => releaseSpaceHold(tx, tenantB.organizationId, tenantB.branchId, theirs.id))
    ).toBe(0);
  });
});

/**
 * 20261021104000 (b). The booking trigger reads the space's buffers FOR SHARE,
 * which conflicts with the FOR NO KEY UPDATE a buffer change takes, so a hold
 * and a widening of the same space on two connections commit in one order or
 * the other — never on different views of the buffers. Each case starts one
 * side, shows the other waiting, releases the first and reads the range the
 * database settled on: always the widened one.
 */
describeIfDatabase('function spaces: a booking and a buffer change on two connections', () => {
  let first: pg.Client;
  let second: pg.Client;
  let space: Space;
  const connect = async () => {
    const client = new pg.Client({
      connectionString: TEST_DATABASE_URL,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    await client.connect();
    return client;
  };
  /** Whether a statement has returned within `ms`, without giving up on it. */
  const settles = (statement: Promise<unknown>, ms: number) =>
    Promise.race([
      statement.then(
        () => 'settled' as const,
        () => 'settled' as const
      ),
      new Promise<'waiting'>((resolve) => {
        setTimeout(() => resolve('waiting'), ms);
      }),
    ]);
  /** The lower bound of a booking's range, read as the tenant in its own transaction. */
  const rangeStart = async (id: string) => {
    await first.query('BEGIN');
    try {
      await actAs(first, tenantA);
      const range = await first.query<{ start: Date }>(
        `SELECT lower("bufferedRange") AS start FROM hotel_space_bookings WHERE id = $1`,
        [id]
      );
      return range.rows[0]?.start;
    } finally {
      await first.query('COMMIT');
    }
  };

  beforeAll(async () => {
    assertLocal(TEST_DATABASE_URL!);
    if (!db) await seedTenants();
    first = await connect();
    second = await connect();
  }, 60_000);
  beforeEach(async () => {
    // Committed, so both connections see the space: 30 minutes of setup.
    await first.query('BEGIN');
    space = await spaceFixture(first, tenantA);
    await first.query('COMMIT');
  });
  afterEach(async () => {
    for (const client of [first, second]) await client.query('ROLLBACK').catch(() => undefined);
    await first.query('BEGIN');
    await actAs(first, tenantA);
    await first.query('DELETE FROM hotel_space_bookings WHERE "spaceId" = $1', [space.spaceId]);
    await first.query('DELETE FROM hotel_function_spaces WHERE id = $1', [space.spaceId]);
    await first.query('COMMIT');
  });
  afterAll(async () => {
    if (first) await first.end();
    if (second) await second.end();
    if (db) await db.$disconnect();
  });

  it('makes a buffer change wait for an uncommitted booking, then re-ranges that booking', async () => {
    await first.query('BEGIN');
    await actAs(first, tenantA);
    const id = await book(first, space, '2030-02-01T10:00:00Z', '2030-02-01T11:00:00Z');
    await second.query('BEGIN');
    await actAs(second, tenantA);
    const widening = second.query(
      'UPDATE hotel_function_spaces SET "setupMinutes" = 60 WHERE id = $1',
      [space.spaceId]
    );
    expect(await settles(widening, 400)).toBe('waiting');
    await first.query('COMMIT');
    expect((await widening).rowCount).toBe(1);
    await second.query('COMMIT');
    // The re-range ran after the booking was committed and visible to it.
    expect(await rangeStart(id)).toEqual(new Date('2030-02-01T09:00:00Z'));
  });

  it('makes a booking wait for an uncommitted buffer change, then ranges it with the new buffers', async () => {
    await second.query('BEGIN');
    await actAs(second, tenantA);
    await second.query('UPDATE hotel_function_spaces SET "setupMinutes" = 60 WHERE id = $1', [
      space.spaceId,
    ]);
    await first.query('BEGIN');
    await actAs(first, tenantA);
    const booking = book(first, space, '2030-02-01T10:00:00Z', '2030-02-01T11:00:00Z');
    expect(await settles(booking, 400)).toBe('waiting');
    await second.query('COMMIT');
    const id = await booking;
    await first.query('COMMIT');
    expect(await rangeStart(id)).toEqual(new Date('2030-02-01T09:00:00Z'));
  });

  it('lets two bookings of one space proceed together and leaves the collision to the constraint', async () => {
    await first.query('BEGIN');
    await actAs(first, tenantA);
    await book(first, space, '2030-02-01T10:00:00Z', '2030-02-01T11:00:00Z');
    await second.query('BEGIN');
    await actAs(second, tenantA);
    // A non-colliding booking is not held up by the first connection's FOR SHARE.
    const beside = book(second, space, '2030-02-01T14:00:00Z', '2030-02-01T15:00:00Z');
    expect(await settles(beside, 400)).toBe('settled');
    await beside;
    // A colliding one waits for the first to decide, then the exclusion
    // constraint refuses it once the first commits.
    const colliding = book(second, space, '2030-02-01T10:30:00Z', '2030-02-01T11:30:00Z');
    expect(await settles(colliding, 400)).toBe('waiting');
    await first.query('COMMIT');
    await expect(colliding).rejects.toMatchObject({
      code: '23P01',
      constraint: 'hotel_space_bookings_space_no_overlap',
    });
    await second.query('ROLLBACK');
  });
});

/**
 * Step 6 of the onboarding walk at a venue — a property whose configuration
 * sells no room inventory, so it could never add the room type the walk asks a
 * hotel for. The step is answered by the property's own active function
 * spaces, counted as the tenant under forced RLS: a space at the venue's other
 * property, or one taken off sale, answers nothing.
 */
describeIfDatabase('function spaces: the onboarding walk at a venue', () => {
  const venue: Tenant = {
    organizationId: `hotel_spaces_v_${suffix}`,
    userId: '',
    branchId: '',
    secondBranchId: '',
  };
  const layouts = [{ layout: 'Banquet', capacity: 300 }];

  beforeAll(async () => {
    assertLocal(TEST_DATABASE_URL!);
    if (!db) await seedTenants();
    const scoped = await import('@/lib/tenancy/scoped-db');
    const { seedHotelTenant } = await import('@/lib/testing/hotel-tenant-fixture');
    const seeded = await seedHotelTenant(scoped.withPlatformDb, {
      organizationId: venue.organizationId,
      properties: [{ name: 'Main lawns' }, { name: 'Second lawns' }],
    });
    venue.userId = seeded.userId;
    venue.branchId = seeded.branchIds[0]!;
    venue.secondBranchId = seeded.branchIds[1]!;
    await scoped.withPlatformDb(async (tx) => {
      await tx.hotelProperty.updateMany({
        where: { organizationId: venue.organizationId },
        data: { mode: 'VENUE' },
      });
      // The walk reads the organization's first active property; both were
      // created in one transaction, so make that order explicit.
      await tx.hotelProperty.update({
        where: { branchId: venue.secondBranchId },
        data: { createdAt: new Date(Date.now() + 60_000) },
      });
    });
  }, 60_000);
  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  const asVenue = <T>(work: (tx: PrismaClient) => Promise<T>) =>
    withTenantDb(venue.organizationId, (tx) => work(tx), { userId: venue.userId });
  const stepSix = () =>
    asVenue(async (tx) => {
      const checklist = await evaluateHotelReadiness(tx, venue.organizationId);
      const step = checklist.items.find((item) => item.step === 6)!;
      return {
        keys: checklist.items.map((item) => item.key),
        key: step.key,
        state: step.state,
      };
    });

  it('counts only the venue’s own active function spaces, read as the tenant', async () => {
    const walk = [
      'MODE_CHOSEN',
      'PROPERTY_FACTS',
      'TAX_PROFILE',
      'BUSINESS_DATE_AND_AUDIT',
      'ROLES_ASSIGNED',
      'FUNCTION_SPACES',
    ];
    expect(await stepSix()).toEqual({ keys: walk, key: 'FUNCTION_SPACES', state: 'NEEDS_YOU' });

    await asVenue(async (tx) => {
      await tx.hotelFunctionSpace.create({
        data: {
          organizationId: venue.organizationId,
          branchId: venue.secondBranchId,
          name: `Other property hall ${suffix}`,
          layouts,
        },
      });
      await tx.hotelFunctionSpace.create({
        data: {
          organizationId: venue.organizationId,
          branchId: venue.branchId,
          name: `Retired hall ${suffix}`,
          layouts,
          active: false,
        },
      });
    });
    expect(await stepSix()).toEqual({ keys: walk, key: 'FUNCTION_SPACES', state: 'NEEDS_YOU' });

    await asVenue((tx) =>
      tx.hotelFunctionSpace.create({
        data: {
          organizationId: venue.organizationId,
          branchId: venue.branchId,
          name: `Main lawn ${suffix}`,
          layouts,
        },
      })
    );
    expect(await stepSix()).toEqual({ keys: walk, key: 'FUNCTION_SPACES', state: 'DONE' });

    // Configured to sell rooms after all, the same property is asked for a room type again.
    await asVenue((tx) =>
      tx.hotelProperty.updateMany({
        where: { organizationId: venue.organizationId, branchId: venue.branchId },
        data: { modeOverrides: { inventoryKinds: ['ROOM'] } },
      })
    );
    expect(await stepSix()).toMatchObject({ key: 'ROOM_TYPES', state: 'NEEDS_YOU' });
  });
});

describeIfOwner('function spaces: forced owner RLS', () => {
  it('forces tenant filtering for the owner of both new tables', async () => {
    assertLocal(OWNER_DATABASE_URL!);
    const runtime = new URL(TEST_DATABASE_URL!);
    const owner = new URL(OWNER_DATABASE_URL!);
    expect([owner.hostname, owner.port, owner.pathname]).toEqual([
      runtime.hostname,
      runtime.port,
      runtime.pathname,
    ]);
    expect(owner.username).not.toBe(runtime.username);
    if (!db) await seedTenants();
    const client = new pg.Client({
      connectionString: OWNER_DATABASE_URL,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    await client.connect();
    try {
      await client.query('BEGIN');
      const role = await client.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const flags = await client.query(
        `SELECT relname, relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) = current_user AS owned
           FROM pg_class WHERE oid = ANY($1::regclass[]) ORDER BY relname`,
        [tables]
      );
      expect(flags.rows).toEqual(
        tables.map((relname) => ({
          relname,
          relrowsecurity: true,
          relforcerowsecurity: true,
          owned: true,
        }))
      );
      const own = await spaceFixture(client, tenantA);
      await book(client, own, '2030-06-01T10:00:00Z', '2030-06-01T11:00:00Z');
      expect((await client.query('SELECT id FROM hotel_function_spaces')).rows).toEqual(
        expect.arrayContaining([{ id: own.spaceId }])
      );
      expect((await client.query('SELECT id FROM hotel_space_bookings')).rowCount).toBeGreaterThan(
        0
      );
      await client.query(
        `SELECT set_config('app.current_organization_id', $1, true), set_config('app.current_user_id', '', true)`,
        [`unrelated-${randomUUID()}`]
      );
      expect((await client.query('SELECT id FROM hotel_function_spaces')).rows).toEqual([]);
      expect((await client.query('SELECT id FROM hotel_space_bookings')).rows).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
      if (db) await db.$disconnect();
    }
  });
});
