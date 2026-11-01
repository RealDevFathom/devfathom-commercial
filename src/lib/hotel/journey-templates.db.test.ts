/**
 * @vitest-environment node
 *
 * UPS-04 — `hotel_journey_templates` against a REAL migrated PostgreSQL: forced
 * row-level security, the property-pinned foreign key, the one-version-number
 * rule, the partial unique index that allows at most one APPROVED version per
 * message (SQL-only, because Prisma's schema language has no partial-unique
 * syntax — so this suite is what pins it), and the CHECKs that keep a row's
 * approval facts, subject and body honest whatever surface wrote it.
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
 * user. The constraint probes run on a raw pg client as the tenant, each inside
 * a transaction that is rolled back, because the SQLSTATE and the constraint
 * name are what they pin; the client probes go through the scoped Prisma
 * client, the way the router does.
 *
 * The stale-write cases go further and commit: a conditional write scoped to
 * a version read before a colleague's save, through the scoped client, and
 * then the journey router itself, each call in its own tenant transaction the
 * way each HTTP request runs. Only the organization-level ABAC decision and
 * the audit row write are stubbed there; the property scope (assignment, role
 * grant), the lock, Prisma's `@updatedAt` and the conditional writes are real.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '@/generated/prisma/client';
import {
  defaultJourneyTemplateSeeds,
  journeyTemplateExpectedState,
} from '@/lib/hotel/journey-templates';

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
// The router cases build their context by hand (no request, no auth() call),
// grant the organization-level capability, and leave the audit row unwritten.
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/lib/abac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/abac')>()),
  can: vi.fn(async () => true),
}));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
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
    throw new Error('Journey-template DB tests require a local disposable database.');
  }
}

type Tenant = { organizationId: string; userId: string; branchId: string; secondBranchId: string };
const tenantA: Tenant = {
  organizationId: `hotel_journey_a_${suffix}`,
  userId: '',
  branchId: '',
  secondBranchId: '',
};
const tenantB: Tenant = {
  organizationId: `hotel_journey_b_${suffix}`,
  userId: '',
  branchId: '',
  secondBranchId: '',
};
const TABLE = 'hotel_journey_templates';

let db: PrismaClient;
let withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
let withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;

/** One tenant transaction as the tenant's user — one request's worth of work. */
function asTenant<T>(tenant: Tenant, run: (db: ScopedDb) => Promise<T>): Promise<T> {
  return withTenantDb(tenant.organizationId, run, { userId: tenant.userId });
}

/** The journey procedures as `tenant`'s user calls them, on one request's transaction. */
async function journeys(tenant: Tenant, db: ScopedDb) {
  const { hotelJourneyTemplatesRouter } = await import('@/server/routers/hotel-journey-templates');
  return hotelJourneyTemplatesRouter.createCaller({
    db,
    entitlements: {
      organizationId: tenant.organizationId,
      enabledModules: ['hotel-core', 'hotel-upsell'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: {
        id: tenant.userId,
        role: 'ADMIN',
        department: 'FRONT_OFFICE',
        status: 'ACTIVE',
        organizationId: tenant.organizationId,
      },
    },
    organization: { id: tenant.organizationId },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

async function seedTenants() {
  const scoped = await import('@/lib/tenancy/scoped-db');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  ({ db } = await import('@/lib/db'));
  const { seedHotelTenant } = await import('@/lib/testing/hotel-tenant-fixture');
  for (const tenant of [tenantA, tenantB]) {
    const seeded = await seedHotelTenant(scoped.withPlatformDb, {
      organizationId: tenant.organizationId,
      properties: [{ name: 'Main property' }, { name: 'Second property' }],
    });
    tenant.userId = seeded.userId;
    tenant.branchId = seeded.branchIds[0]!;
    tenant.secondBranchId = seeded.branchIds[1]!;
  }
  // The committed draft each tenant opens with, the way provisioning writes it
  // (version 1, DRAFT, no approval facts). The raw probes below use other
  // moments, so they never collide with these rows.
  for (const tenant of [tenantA, tenantB]) {
    await withPlatformDb((db) =>
      db.hotelJourneyTemplate.create({
        data: {
          organizationId: tenant.organizationId,
          branchId: tenant.branchId,
          moment: 'BOOKING_CONFIRMED',
          channel: 'WHATSAPP',
          language: 'EN',
          body: 'Dear {{guest_name}}, your booking at {{property_name}} is confirmed.',
          createdByUserId: tenant.userId,
        },
      })
    );
  }
}

/** Act as the tenant on a raw connection: the same GUCs the scoped client sets. */
async function actAs(client: pg.Client, tenant: Tenant) {
  await client.query(
    `SELECT set_config('app.current_organization_id', $1, true),
            set_config('app.current_user_id', $2, true),
            set_config('app.is_platform_admin', 'false', true)`,
    [tenant.organizationId, tenant.userId]
  );
}

type Row = {
  id?: string;
  organizationId?: string;
  branchId?: string;
  moment?: string;
  channel?: string;
  language?: string;
  subject?: string | null;
  body?: string;
  version?: number;
  status?: string;
  approvedByUserId?: string | null;
  approvedAt?: string | null;
  createdByUserId?: string;
};

/** One row in SQL, with every column the CHECKs read spelled out. */
async function insertTemplate(client: pg.Client, tenant: Tenant, row: Row) {
  const id = row.id ?? randomUUID();
  await client.query(
    `INSERT INTO hotel_journey_templates
      (id, "organizationId", "branchId", moment, channel, language, subject, body, version,
       status, "approvedByUserId", "approvedAt", "createdByUserId", "updatedAt")
     VALUES ($1, $2, $3, $4::"HotelJourneyMoment", $5::"HotelJourneyChannel", $6::"HotelJourneyLanguage",
             $7, $8, $9, $10::"HotelJourneyTemplateStatus", $11, $12::timestamp, $13, now())`,
    [
      id,
      row.organizationId ?? tenant.organizationId,
      row.branchId ?? tenant.branchId,
      row.moment ?? 'WELCOME',
      row.channel ?? 'WHATSAPP',
      row.language ?? 'EN',
      row.subject ?? null,
      row.body ?? 'Dear {{guest_name}}, welcome to {{property_name}}.',
      row.version ?? 1,
      row.status ?? 'DRAFT',
      row.approvedByUserId ?? null,
      row.approvedAt ?? null,
      row.createdByUserId ?? tenant.userId,
    ]
  );
  return id;
}

/** The approval facts an APPROVED row must carry, as the router records them. */
function approvedBy(tenant: Tenant): Row {
  return {
    status: 'APPROVED',
    approvedByUserId: tenant.userId,
    approvedAt: '2026-10-20T10:00:00Z',
  };
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

describeIfDatabase('journey templates: database rules and tenant boundaries', () => {
  let client: pg.Client;
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
    await actAs(client, tenantA);
  });
  afterEach(async () => {
    if (client) await client.query('ROLLBACK');
  });
  afterAll(async () => {
    if (client) await client.end();
    if (db) await db.$disconnect();
  });

  it('pins the table to ENABLE and FORCE RLS', async () => {
    const flags = await client.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE oid = $1::regclass`,
      [TABLE]
    );
    expect(flags.rows).toEqual([
      { relname: TABLE, relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it('keeps one version number per message and admits the next number', async () => {
    await insertTemplate(client, tenantA, { moment: 'WELCOME', version: 1 });
    await rejectedWrite(
      client,
      () => insertTemplate(client, tenantA, { moment: 'WELCOME', version: 1 }),
      '23505',
      'hotel_journey_templates_version_key'
    );
    // Another language is another message; the next number of the same one is admitted.
    await insertTemplate(client, tenantA, { moment: 'WELCOME', language: 'UR', version: 1 });
    await insertTemplate(client, tenantA, { moment: 'WELCOME', version: 2 });
    const versions = await client.query<{ language: string; version: number }>(
      `SELECT language, version FROM hotel_journey_templates
        WHERE moment = 'WELCOME' ORDER BY language, version`
    );
    expect(versions.rows).toEqual([
      { language: 'EN', version: 1 },
      { language: 'EN', version: 2 },
      { language: 'UR', version: 1 },
    ]);
  });

  it('allows at most one approved version per message, and the next once the first is retired', async () => {
    const first = await insertTemplate(client, tenantA, {
      moment: 'WELCOME',
      version: 1,
      ...approvedBy(tenantA),
    });
    await rejectedWrite(
      client,
      () =>
        insertTemplate(client, tenantA, { moment: 'WELCOME', version: 2, ...approvedBy(tenantA) }),
      '23505',
      'hotel_journey_templates_approved_key'
    );
    // A draft of the next version sits beside the approved one — that is how a
    // replacement is written — and another language's approval is unaffected.
    const draft = await insertTemplate(client, tenantA, { moment: 'WELCOME', version: 2 });
    await insertTemplate(client, tenantA, {
      moment: 'WELCOME',
      language: 'UR',
      version: 1,
      ...approvedBy(tenantA),
    });
    // Approving the draft while version 1 stands is refused on UPDATE too; the
    // index judges rows, not statements.
    await rejectedWrite(
      client,
      () =>
        client.query(
          `UPDATE hotel_journey_templates
              SET status = 'APPROVED', "approvedByUserId" = $2, "approvedAt" = now()
            WHERE id = $1`,
          [draft, tenantA.userId]
        ),
      '23505',
      'hotel_journey_templates_approved_key'
    );
    // Retire the first (its approval facts stay), then the draft may be approved.
    await client.query(`UPDATE hotel_journey_templates SET status = 'RETIRED' WHERE id = $1`, [
      first,
    ]);
    await client.query(
      `UPDATE hotel_journey_templates
          SET status = 'APPROVED', "approvedByUserId" = $2, "approvedAt" = now()
        WHERE id = $1`,
      [draft, tenantA.userId]
    );
    const approved = await client.query<{ id: string; version: number; status: string }>(
      `SELECT id, version, status FROM hotel_journey_templates
        WHERE moment = 'WELCOME' AND language = 'EN' ORDER BY version`
    );
    expect(approved.rows).toEqual([
      { id: first, version: 1, status: 'RETIRED' },
      { id: draft, version: 2, status: 'APPROVED' },
    ]);
    const retired = await client.query<{ approvedByUserId: string | null }>(
      `SELECT "approvedByUserId" FROM hotel_journey_templates WHERE id = $1`,
      [first]
    );
    expect(retired.rows).toEqual([{ approvedByUserId: tenantA.userId }]);
  });

  it('refuses a version below one and a blank body', async () => {
    await rejectedWrite(
      client,
      () => insertTemplate(client, tenantA, { version: 0 }),
      '23514',
      'hotel_journey_templates_version_ck'
    );
    await rejectedWrite(
      client,
      () => insertTemplate(client, tenantA, { body: '   ' }),
      '23514',
      'hotel_journey_templates_body_ck'
    );
  });

  it('allows a subject only on e-mail, and never a blank one', async () => {
    await rejectedWrite(
      client,
      () => insertTemplate(client, tenantA, { channel: 'WHATSAPP', subject: 'Welcome' }),
      '23514',
      'hotel_journey_templates_subject_ck'
    );
    await rejectedWrite(
      client,
      () => insertTemplate(client, tenantA, { channel: 'SMS', subject: 'Welcome' }),
      '23514',
      'hotel_journey_templates_subject_ck'
    );
    await rejectedWrite(
      client,
      () => insertTemplate(client, tenantA, { channel: 'EMAIL', subject: '  ' }),
      '23514',
      'hotel_journey_templates_subject_ck'
    );
    await insertTemplate(client, tenantA, {
      moment: 'INVOICE',
      channel: 'EMAIL',
      subject: 'Invoice {{invoice_number}} from {{property_name}}',
    });
    // An e-mail without a subject is admitted by the database; the lib's
    // SUBJECT_REQUIRED rule is the surface's, not the table's.
    await insertTemplate(client, tenantA, { moment: 'INVOICE', channel: 'EMAIL', version: 2 });
  });

  it('keeps the approval facts and the status in agreement', async () => {
    // APPROVED must name its approver and the moment of approval.
    await rejectedWrite(
      client,
      () => insertTemplate(client, tenantA, { status: 'APPROVED' }),
      '23514',
      'hotel_journey_templates_approval_ck'
    );
    // One approval fact without the other, in either direction.
    await rejectedWrite(
      client,
      () =>
        insertTemplate(client, tenantA, {
          status: 'APPROVED',
          approvedByUserId: tenantA.userId,
          approvedAt: null,
        }),
      '23514',
      'hotel_journey_templates_approval_ck'
    );
    await rejectedWrite(
      client,
      () =>
        insertTemplate(client, tenantA, {
          status: 'RETIRED',
          approvedByUserId: null,
          approvedAt: '2026-10-20T10:00:00Z',
        }),
      '23514',
      'hotel_journey_templates_approval_ck'
    );
    // A DRAFT names no approver.
    await rejectedWrite(
      client,
      () => insertTemplate(client, tenantA, { ...approvedBy(tenantA), status: 'DRAFT' }),
      '23514',
      'hotel_journey_templates_approval_ck'
    );
    // A retired draft keeps no facts; a retired approval keeps both.
    await insertTemplate(client, tenantA, { moment: 'REVIEW_REQUEST', status: 'RETIRED' });
    await insertTemplate(client, tenantA, {
      moment: 'REVIEW_REQUEST',
      version: 2,
      ...approvedBy(tenantA),
      status: 'RETIRED',
    });
  });

  it('filters the other tenant’s templates even without application predicates', async () => {
    const mine = await client.query<{ organizationId: string }>(
      `SELECT "organizationId" FROM hotel_journey_templates`
    );
    expect(mine.rows.length).toBeGreaterThanOrEqual(1);
    expect(new Set(mine.rows.map((row) => row.organizationId))).toEqual(
      new Set([tenantA.organizationId])
    );
    const theirs = await withTenantDb(
      tenantB.organizationId,
      (db) => db.hotelJourneyTemplate.findFirstOrThrow({ select: { id: true } }),
      { userId: tenantB.userId }
    );
    const stolen = await client.query(`SELECT id FROM hotel_journey_templates WHERE id = $1`, [
      theirs.id,
    ]);
    expect(stolen.rowCount).toBe(0);
    const updated = await client.query(
      `UPDATE hotel_journey_templates SET body = 'Rewritten by the wrong tenant' WHERE id = $1`,
      [theirs.id]
    );
    expect(updated.rowCount).toBe(0);
    const deleted = await client.query(`DELETE FROM hotel_journey_templates WHERE id = $1`, [
      theirs.id,
    ]);
    expect(deleted.rowCount).toBe(0);
  });

  it('refuses a row written under the other tenant and one hung off the other tenant’s property', async () => {
    await rejectedWrite(
      client,
      () =>
        insertTemplate(client, tenantA, {
          organizationId: tenantB.organizationId,
          branchId: tenantB.branchId,
        }),
      '42501'
    );
    // The tenant is its own, so the policy is satisfied; the composite foreign
    // key is what refuses, because (tenant A, property B) is not a property.
    await rejectedWrite(
      client,
      () => insertTemplate(client, tenantA, { branchId: tenantB.branchId }),
      '23503',
      'hotel_journey_templates_property_fkey'
    );
    // Its own second property is a property: the same message may be drafted there.
    await insertTemplate(client, tenantA, { branchId: tenantA.secondBranchId });
  });

  it('stores the twenty drafts a property opens with, written the way provisioning does', async () => {
    // Seeded onto tenant B's second property, which holds nothing else, so the
    // count is exact. Every seed clears the CHECKs: WhatsApp without a subject,
    // e-mail with one, version 1, DRAFT without approval facts.
    await withPlatformDb((db) =>
      db.hotelJourneyTemplate.createMany({
        data: defaultJourneyTemplateSeeds().map((seed) => ({
          ...seed,
          organizationId: tenantB.organizationId,
          branchId: tenantB.secondBranchId,
          createdByUserId: tenantB.userId,
        })),
      })
    );
    const seeded = await withTenantDb(
      tenantB.organizationId,
      (db) =>
        db.hotelJourneyTemplate.findMany({
          where: { branchId: tenantB.secondBranchId },
          orderBy: [{ moment: 'asc' }, { channel: 'asc' }, { language: 'asc' }],
        }),
      { userId: tenantB.userId }
    );
    expect(seeded).toHaveLength(20);
    expect(new Set(seeded.map((row) => row.status))).toEqual(new Set(['DRAFT']));
    expect(new Set(seeded.map((row) => row.version))).toEqual(new Set([1]));
    expect(seeded.filter((row) => row.channel === 'WHATSAPP')).toHaveLength(16);
    expect(seeded.filter((row) => row.channel === 'EMAIL').every((row) => row.subject)).toBe(true);
    expect(seeded.every((row) => row.approvedByUserId === null && row.approvedAt === null)).toBe(
      true
    );
  });

  it('reads its own templates through the scoped client and never the other tenant’s, even by primary key', async () => {
    const mine = await withTenantDb(
      tenantA.organizationId,
      (db) => db.hotelJourneyTemplate.findMany({ orderBy: { createdAt: 'asc' } }),
      { userId: tenantA.userId }
    );
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(new Set(mine.map((row) => row.organizationId))).toEqual(
      new Set([tenantA.organizationId])
    );
    expect(mine[0]).toMatchObject({ status: 'DRAFT', version: 1, approvedByUserId: null });
    const theirs = await withTenantDb(
      tenantB.organizationId,
      (db) => db.hotelJourneyTemplate.findFirstOrThrow(),
      { userId: tenantB.userId }
    );
    const stolen = await withTenantDb(
      tenantA.organizationId,
      (db) => db.hotelJourneyTemplate.findUnique({ where: { id: theirs.id } }),
      { userId: tenantA.userId }
    );
    expect(stolen).toBeNull();
    const result = await withTenantDb(
      tenantA.organizationId,
      (db) =>
        db.hotelJourneyTemplate.updateMany({
          where: { id: theirs.id },
          data: { body: 'Rewritten by the wrong tenant' },
        }),
      { userId: tenantA.userId }
    );
    expect(result.count).toBe(0);
  });

  it('matches no row for an approval scoped to a version read before a colleague’s save, whether or not the timestamp moved', async () => {
    // Committed on tenant A's second property, under a moment no probe uses.
    const scope = { organizationId: tenantA.organizationId, branchId: tenantA.secondBranchId };
    const read = await asTenant(tenantA, (db) =>
      db.hotelJourneyTemplate.create({
        data: {
          ...scope,
          moment: 'IN_STAY',
          channel: 'WHATSAPP',
          language: 'EN',
          body: 'Read {{guest_name}}, room {{room_number}}.',
          createdByUserId: tenantA.userId,
        },
      })
    );
    const readingOf = (row: typeof read) => ({
      updatedAt: row.updatedAt,
      subject: row.subject,
      body: row.body,
    });
    const approval = {
      status: 'APPROVED' as const,
      approvedByUserId: tenantA.userId,
      approvedAt: new Date(),
    };
    const approveAsRead = (current: typeof read, seen: typeof read) =>
      asTenant(tenantA, (db) =>
        db.hotelJourneyTemplate.updateMany({
          where: { ...scope, ...journeyTemplateExpectedState(current, readingOf(seen)) },
          data: approval,
        })
      );
    const stored = () =>
      asTenant(tenantA, (db) =>
        db.hotelJourneyTemplate.findUniqueOrThrow({ where: { id: read.id } })
      );

    // A colleague saves new words after the approver read the draft; Prisma's
    // `@updatedAt` stamps the row.
    const resaved = await asTenant(tenantA, (db) =>
      db.hotelJourneyTemplate.updateMany({
        where: { ...scope, ...journeyTemplateExpectedState(read, readingOf(read)) },
        data: { body: 'Saved since {{guest_name}}, room {{room_number}}.' },
      })
    );
    expect(resaved.count).toBe(1);
    const current = await stored();
    expect(current.updatedAt.getTime()).toBeGreaterThan(read.updatedAt.getTime());
    expect(await approveAsRead(current, read)).toEqual({ count: 0 });

    // Two writes sharing one timestamp: only the wording tells them apart.
    const sameStamp = await asTenant(tenantA, (db) =>
      db.hotelJourneyTemplate.updateMany({
        where: { id: read.id, updatedAt: current.updatedAt },
        data: {
          body: 'Same stamp {{guest_name}}, room {{room_number}}.',
          updatedAt: current.updatedAt,
        },
      })
    );
    expect(sameStamp.count).toBe(1);
    const latest = await stored();
    expect(latest.updatedAt).toEqual(current.updatedAt);
    expect(await approveAsRead(latest, current)).toEqual({ count: 0 });
    expect(latest).toMatchObject({
      status: 'DRAFT',
      body: 'Same stamp {{guest_name}}, room {{room_number}}.',
      approvedByUserId: null,
      approvedAt: null,
    });

    // The version as it stands, once read, is what an approval may stand behind.
    expect(await approveAsRead(latest, latest)).toEqual({ count: 1 });
    expect(await stored()).toMatchObject({
      status: 'APPROVED',
      body: 'Same stamp {{guest_name}}, room {{room_number}}.',
      approvedByUserId: tenantA.userId,
    });
  });

  it('refuses a stale approval and a stale save through the router, writing nothing, and approves the stored words once read', async () => {
    const message = {
      branchId: tenantA.branchId,
      moment: 'EXPRESS_CHECKOUT',
      channel: 'WHATSAPP',
      language: 'EN',
      subject: null,
    } as const;
    const reading = (seen: { updatedAt: Date; subject: string | null; body: string }) => ({
      expectedUpdatedAt: seen.updatedAt,
      expectedSubject: seen.subject,
      expectedBody: seen.body,
    });
    const created = await asTenant(tenantA, async (db) =>
      (await journeys(tenantA, db)).save({
        ...message,
        body: 'Departure from room {{room_number}} by {{check_out_time}}.',
      })
    );
    // The administrator opens the board in one request…
    const seen = await asTenant(tenantA, async (db) => {
      const board = await (await journeys(tenantA, db)).list({ branchId: tenantA.branchId });
      return board.templates.find((template) => template.id === created.id)!;
    });
    // …a colleague saves new words into the same draft in another…
    const resaved = await asTenant(tenantA, async (db) =>
      (await journeys(tenantA, db)).save({
        ...message,
        body: 'Please leave room {{room_number}} by {{check_out_time}}.',
        ...reading(seen),
      })
    );
    expect(resaved).toMatchObject({ id: seen.id, version: seen.version, status: 'DRAFT' });
    expect(resaved.updatedAt.getTime()).toBeGreaterThan(seen.updatedAt.getTime());
    // …and the administrator's approval of the words on screen is refused.
    await expect(
      asTenant(tenantA, async (db) =>
        (await journeys(tenantA, db)).approve({
          branchId: tenantA.branchId,
          id: seen.id,
          ...reading(seen),
          expectedApprovedId: null,
        })
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // So is a second editor's save over the version it read before the colleague's.
    await expect(
      asTenant(tenantA, async (db) =>
        (await journeys(tenantA, db)).save({ ...message, body: 'Stale words.', ...reading(seen) })
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const stored = () =>
      asTenant(tenantA, (db) =>
        db.hotelJourneyTemplate.findUniqueOrThrow({ where: { id: seen.id } })
      );
    expect(await stored()).toMatchObject({
      status: 'DRAFT',
      body: resaved.body,
      updatedAt: resaved.updatedAt,
      approvedByUserId: null,
      approvedAt: null,
    });
    // Read again, the stored words are what the approval stands behind.
    const approved = await asTenant(tenantA, async (db) =>
      (await journeys(tenantA, db)).approve({
        branchId: tenantA.branchId,
        id: seen.id,
        ...reading(resaved),
        expectedApprovedId: null,
      })
    );
    expect(approved).toMatchObject({
      status: 'APPROVED',
      body: resaved.body,
      approvedByUserId: tenantA.userId,
    });
    expect(await stored()).toMatchObject({ status: 'APPROVED', body: resaved.body });
  });

  it('refuses a stale retirement of a draft resaved within the same millisecond, through the router, writing nothing', async () => {
    const message = {
      branchId: tenantA.branchId,
      moment: 'PRE_ARRIVAL_UPSELL',
      channel: 'SMS',
      language: 'EN',
      subject: null,
    } as const;
    const reading = (seen: { updatedAt: Date; subject: string | null; body: string }) => ({
      expectedUpdatedAt: seen.updatedAt,
      expectedSubject: seen.subject,
      expectedBody: seen.body,
    });
    const created = await asTenant(tenantA, async (db) =>
      (await journeys(tenantA, db)).save({
        ...message,
        body: 'Dear {{guest_name}}, {{offer_name}} is on offer.',
      })
    );
    // The administrator opens the board in one request…
    const seen = await asTenant(tenantA, async (db) => {
      const board = await (await journeys(tenantA, db)).list({ branchId: tenantA.branchId });
      return board.templates.find((template) => template.id === created.id)!;
    });
    // …a colleague's save lands in the same millisecond: new words, the same stamp…
    const sameStamp = await asTenant(tenantA, (db) =>
      db.hotelJourneyTemplate.updateMany({
        where: { id: seen.id, updatedAt: seen.updatedAt, body: seen.body },
        data: { body: 'Dear {{guest_name}}, {{offer_name}} ends soon.', updatedAt: seen.updatedAt },
      })
    );
    expect(sameStamp.count).toBe(1);
    // …and retiring the draft as read names words that are no longer the stored ones.
    await expect(
      asTenant(tenantA, async (db) =>
        (await journeys(tenantA, db)).retire({
          branchId: tenantA.branchId,
          id: seen.id,
          ...reading(seen),
        })
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const stored = () =>
      asTenant(tenantA, (db) =>
        db.hotelJourneyTemplate.findUniqueOrThrow({ where: { id: seen.id } })
      );
    const current = await stored();
    expect(current).toMatchObject({
      status: 'DRAFT',
      body: 'Dear {{guest_name}}, {{offer_name}} ends soon.',
      updatedAt: seen.updatedAt,
    });
    // Read again, the draft is retired at the words that stand.
    await expect(
      asTenant(tenantA, async (db) =>
        (await journeys(tenantA, db)).retire({
          branchId: tenantA.branchId,
          id: seen.id,
          ...reading(current),
        })
      )
    ).resolves.toMatchObject({ status: 'RETIRED', body: current.body });
  });
});

describeIfOwner('hotel_journey_templates forced row-level security', () => {
  const owner = new pg.Client({ connectionString: OWNER_DATABASE_URL });

  beforeAll(async () => {
    assertLocal(OWNER_DATABASE_URL!);
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
        WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname = $1`,
      [TABLE]
    );
    expect(result.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true, owned: true }]);
  });

  it('filters the owning role too, which is what FORCE means', async () => {
    await owner.query('BEGIN');
    try {
      const unscoped = await owner.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "hotel_journey_templates"`
      );
      expect(unscoped.rows[0]!.count).toBe('0');
      await owner.query(`SELECT set_config('app.current_organization_id', $1, true)`, [
        tenantA.organizationId,
      ]);
      const scoped = await owner.query<{ organizationId: string }>(
        `SELECT "organizationId" FROM "hotel_journey_templates"`
      );
      expect(scoped.rows.length).toBeGreaterThanOrEqual(1);
      expect(new Set(scoped.rows.map((row) => row.organizationId))).toEqual(
        new Set([tenantA.organizationId])
      );
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
