/**
 * PROP-07 / invariant 25. Source-only addition during the recovery continuation.
 * Run only after separate admission of a migrated disposable database. No global
 * DATABASE_URL fallback, role grants, migrations, seed, or committed fixtures.
 * Each test rolls back its own transaction. Missing URLs mean skipped coverage.
 *
 * Still requires separately admitted reproduction of bufferedRange-only updates
 * and concurrent buffer edits/booking writes; this suite does not settle those.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const runtimeUrl = process.env.HOTEL_FUNCTION_SPACES_TEST_RUNTIME_DATABASE_URL;
const ownerUrl = process.env.HOTEL_FUNCTION_SPACES_TEST_OWNER_DATABASE_URL;
const tables = ['hotel_function_spaces', 'hotel_space_bookings'];

function localDisposable(url: string) {
  const parsed = new URL(url);
  const port = Number(parsed.port);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    !(
      (port >= 55600 && port <= 55699) ||
      (port === 55432 && parsed.pathname === '/devfathom_gate_test')
    )
  ) {
    throw new Error('Function-space DB tests require the admitted local disposable database.');
  }
}

async function tenant(client: pg.Client, organizationId: string) {
  await client.query(
    "SELECT set_config('app.current_organization_id', $1, true), set_config('app.is_platform_admin', 'false', true)",
    [organizationId]
  );
}

async function fixture(client: pg.Client, organizationId: string) {
  await tenant(client, organizationId);
  const branchId = randomUUID();
  const spaceId = randomUUID();
  await client.query(
    `INSERT INTO hotel_properties
    ("branchId", "organizationId", name, "addressLine", city, timezone, "bookingEngineSlug", "updatedAt")
    VALUES ($1, $2, 'Test property', '1 Test Road', 'Lahore', 'Asia/Karachi', $3, now())`,
    [branchId, organizationId, `spaces-${branchId}`]
  );
  await client.query(
    `INSERT INTO hotel_function_spaces
    (id, "organizationId", "branchId", name, layouts, "setupMinutes", "teardownMinutes", "updatedAt")
    VALUES ($1, $2, $3, 'Test hall', '[{"layout":"Theatre","capacity":100}]', 30, 15, now())`,
    [spaceId, organizationId, branchId]
  );
  return { branchId, spaceId, organizationId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function book(
  client: pg.Client,
  space: Fixture,
  startsAt: string,
  endsAt: string,
  kind = 'FUNCTION'
) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO hotel_space_bookings
    (id, "organizationId", "branchId", "spaceId", "startsAt", "endsAt", kind, "updatedAt")
    VALUES ($1, $2, $3, $4, $5, $6, $7::"HotelSpaceBookingKind", now())`,
    [id, space.organizationId, space.branchId, space.spaceId, startsAt, endsAt, kind]
  );
  return id;
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

describe.skipIf(!runtimeUrl)('function spaces: database overlap and tenant boundaries', () => {
  let client: pg.Client;
  let one: Fixture;
  let other: Fixture;
  beforeAll(async () => {
    localDisposable(runtimeUrl!);
    client = new pg.Client({
      connectionString: runtimeUrl,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    await client.connect();
    const role = await client.query(
      'SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user'
    );
    expect(role.rows).toEqual([
      { rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false },
    ]);
  });
  beforeEach(async () => {
    await client.query('BEGIN');
    one = await fixture(client, `spaces-a-${randomUUID()}`);
    other = await fixture(client, `spaces-b-${randomUUID()}`);
    await book(client, other, '2030-01-01T10:00:00Z', '2030-01-01T11:00:00Z');
    await tenant(client, one.organizationId);
  });
  afterEach(async () => {
    if (client) await client.query('ROLLBACK');
  });
  afterAll(async () => {
    if (client) await client.end();
  });

  it('derives the half-open range from setup and teardown buffers', async () => {
    const id = await book(client, one, '2030-01-01T10:00:00Z', '2030-01-01T11:00:00Z');
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
    const result = await client.query('SELECT id FROM hotel_space_bookings');
    expect(result.rowCount).toBe(2);
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
    // The BEFORE trigger cannot see the foreign parent under RLS and refuses
    // this booking before the row reaches the policy's WITH CHECK expression.
    await rejectedWrite(
      client,
      () => book(client, other, '2030-01-01T12:00:00Z', '2030-01-01T13:00:00Z'),
      'P0001'
    );
  });
});

describe.skipIf(!runtimeUrl || !ownerUrl)('function spaces: forced owner RLS', () => {
  it('forces tenant filtering for the owner of both new tables', async () => {
    localDisposable(ownerUrl!);
    const runtime = new URL(runtimeUrl!);
    const owner = new URL(ownerUrl!);
    expect([owner.hostname, owner.port, owner.pathname]).toEqual([
      runtime.hostname,
      runtime.port,
      runtime.pathname,
    ]);
    expect(owner.username).not.toBe(runtime.username);
    const client = new pg.Client({
      connectionString: ownerUrl,
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
      const own = await fixture(client, `spaces-owner-${randomUUID()}`);
      await book(client, own, '2030-01-01T10:00:00Z', '2030-01-01T11:00:00Z');
      expect((await client.query('SELECT id FROM hotel_function_spaces')).rows).toEqual([
        { id: own.spaceId },
      ]);
      expect((await client.query('SELECT id FROM hotel_space_bookings')).rowCount).toBe(1);
      await tenant(client, `unrelated-${randomUUID()}`);
      expect((await client.query('SELECT id FROM hotel_function_spaces')).rows).toEqual([]);
      expect((await client.query('SELECT id FROM hotel_space_bookings')).rows).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
});
