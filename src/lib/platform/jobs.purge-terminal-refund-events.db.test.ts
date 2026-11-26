/**
 * @vitest-environment node
 *
 * DEV-1056: card-terminal refund events and the purge of a closed business, against a REAL
 * PostgreSQL as the restricted runtime role (NOSUPERUSER, NOBYPASSRLS) with row level
 * security on.
 *
 * `pharmacy_terminal_refund_events` is append-only, and its policy had no platform-admin
 * exception. The retention worker deletes a tenant table by table inside the platform control
 * plane's transaction, so it could neither see nor delete these rows.
 *
 *   - inside the purge of a business (the worker's own context and statement), that
 *     business's refund events are deleted, and another business's are untouched;
 *   - a tenant can neither delete nor update a row, not even by naming its own purge;
 *   - a tenant cannot reach another business's rows at all;
 *   - the control plane deletes nothing outside the purge of the row's own tenant, and never
 *     updates;
 *   - the control plane cannot INSERT a refund event (the platform-admin exception is in the
 *     policy's USING clause only), while the tenant's own INSERT still works.
 *
 * The events are written by the real review service as the tenant, so each one carries its
 * balanced journal posting. The suite stops at this table: the whole purge job of such a
 * business is still refused further on by the card-terminal attempt and finance journal
 * guards, which are not this ticket's.
 *
 * Skipped unless TEST_DATABASE_URL names the runtime role on a migrated disposable database.
 */
import { randomBytes } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '@/generated/prisma/client';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// `@/lib/db` reads DATABASE_URL when its module is evaluated, so this must happen before the
// dynamic imports in `beforeAll`.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

vi.mock('server-only', () => ({}));
// As jobs.purge.db.test.ts: hand the adapter a connection string, so the client does not
// depend on which copy of `pg` the test runner resolved.
vi.mock('@/lib/db', () => ({
  db: new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL, max: 10 }),
    log: ['error'],
  }),
}));
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const suffix = randomBytes(6).toString('hex');
const PURGED_ORG = `dev1056_purge_${suffix}`;
const LIVE_ORG = `dev1056_live_${suffix}`;
const APPEND_ONLY = /card terminal refund events are append-only/;

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;

let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;

const ids = (organizationId: string) => ({
  branch: `branch_${organizationId}`,
  manager: `manager_${organizationId}`,
  key: `review_${organizationId}`,
});

/** A pharmacy with one card payment in manual review, resolved as charged: one OWED event. */
async function seedTenantWithRefundEvent(organizationId: string) {
  const { branch, manager, key } = ids(organizationId);
  await withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, $1, $1, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      organizationId
    )
  );
  const run = <T>(fn: (db: ScopedDb) => Promise<T>) =>
    withTenantDb(organizationId, fn, { userId: manager });
  await run(async (db) => {
    await db.$executeRawUnsafe(
      `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
       VALUES ($1, $2, 'Pharmacy', 'Pharmacy', now())`,
      key,
      organizationId
    );
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, "organizationId", name, email, department, title, "updatedAt")
       VALUES ($1, $2, 'Manager', $1, 'Pharmacy', 'Manager', now())`,
      manager,
      organizationId
    );
    await db.$executeRawUnsafe(
      `INSERT INTO pharmacy_branches (id, "organizationId", code, name, "addressLine", city, "provinceCode", "updatedAt")
       VALUES ($1, $2, 'MAIN', 'Main', 'Test', 'Lahore', 'PB', now())`,
      branch,
      organizationId
    );
    await db.$executeRawUnsafe(
      `INSERT INTO pharmacy_sales (id, "organizationId", "branchId", "createdByUserId", "updatedAt")
       VALUES ($1, $2, $3, 'cashier', now())`,
      key,
      organizationId,
      branch
    );
    await db.$executeRawUnsafe(
      `INSERT INTO pharmacy_card_terminal_attempts (id, "organizationId", "branchId", "saleId", "deviceId", "terminalId", provider, "attemptKey", "amountMinor", currency, "businessDate", "actorId", "updatedAt")
       VALUES ($1, $2, $3, $1, 'device', 'terminal', 'FAKE_TERMINAL', $1, 1601, 'PKR', current_date, 'cashier', now())`,
      key,
      organizationId,
      branch
    );
    await db.$executeRawUnsafe(
      `UPDATE pharmacy_card_terminal_attempts SET status = 'SENT', "sentAt" = now() WHERE id = $1`,
      key
    );
    await db.$executeRawUnsafe(
      `UPDATE pharmacy_card_terminal_attempts SET status = 'MANUAL_REVIEW', "reviewReason" = 'Unknown' WHERE id = $1`,
      key
    );
  });
  const [{ prismaCardTerminalAttemptStore }, { resolveCardTerminalReview }] = await Promise.all([
    import('@/lib/pharmacy/card-terminal/store'),
    import('@/lib/pharmacy/card-terminal/service'),
  ]);
  await resolveCardTerminalReview(
    { store: prismaCardTerminalAttemptStore(run) },
    { organizationId, branchId: branch, actorId: manager },
    {
      attemptKey: key,
      outcome: 'REVERSED',
      reason: 'Slip shows charged',
      slipRef: `SLIP-${suffix}`,
    },
    { pinVerified: true }
  );
}

/** A tenant's own refund events, read as that tenant. */
const eventsOf = (organizationId: string) =>
  withTenantDb(organizationId, (db) =>
    db.$queryRawUnsafe<Array<{ id: string; kind: string; reason: string }>>(
      `SELECT id, kind, reason FROM pharmacy_terminal_refund_events WHERE "organizationId" = $1 ORDER BY id`,
      organizationId
    )
  );

/** The database's refusal, or `null` when the statement ran. */
const refusal = (run: Promise<unknown>) =>
  run.then(
    () => null,
    (error: unknown) => String(error instanceof Error ? error.message : error)
  );

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('DEV-1056 card-terminal refund events in the purge of a business', () => {
  beforeAll(async () => {
    ({ withPlatformDb, withTenantDb } = await import('@/lib/tenancy/scoped-db'));
    // Every assertion below is decided by row level security or by the append-only trigger.
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    await assertRlsEnforcingRole(withPlatformDb);
    await seedTenantWithRefundEvent(PURGED_ORG);
    await seedTenantWithRefundEvent(LIVE_ORG);
  }, 120_000);

  it('seeds one refund event with its journal posting in each business', async () => {
    for (const organizationId of [PURGED_ORG, LIVE_ORG]) {
      expect(await eventsOf(organizationId)).toEqual([
        { id: expect.any(String), kind: 'OWED', reason: 'Slip shows charged' },
      ]);
    }
  });

  it('keeps a row append-only for its own tenant, even when the tenant names its own purge', async () => {
    const [event] = await eventsOf(LIVE_ORG);
    for (const statement of [
      `DELETE FROM pharmacy_terminal_refund_events WHERE id = $1`,
      `UPDATE pharmacy_terminal_refund_events SET reason = 'Rewritten by the tenant' WHERE id = $1`,
    ]) {
      // An ordinary tenant transaction.
      expect(
        await refusal(withTenantDb(LIVE_ORG, (db) => db.$executeRawUnsafe(statement, event!.id)))
      ).toMatch(APPEND_ONLY);
      // The purge name alone is not the control plane (`withTenantDb` is not a platform admin).
      expect(
        await refusal(
          withTenantDb(LIVE_ORG, async (db) => {
            await db.$queryRawUnsafe(
              `SELECT set_config('app.purging_organization_id', $1, true)`,
              LIVE_ORG
            );
            return db.$executeRawUnsafe(statement, event!.id);
          })
        )
      ).toMatch(APPEND_ONLY);
    }
    expect(await eventsOf(LIVE_ORG)).toEqual([event]);
  });

  it('hides another business’s events from a tenant: its delete and update match no row', async () => {
    const [event] = await eventsOf(LIVE_ORG);
    for (const statement of [
      `DELETE FROM pharmacy_terminal_refund_events WHERE id = $1`,
      `UPDATE pharmacy_terminal_refund_events SET reason = 'Rewritten by another tenant' WHERE id = $1`,
    ]) {
      await expect(
        withTenantDb(PURGED_ORG, (db) => db.$executeRawUnsafe(statement, event!.id))
      ).resolves.toBe(0);
    }
    expect(await eventsOf(LIVE_ORG)).toEqual([event]);
  });

  it('refuses the control plane outside the purge of the row’s own tenant, and every update', async () => {
    const [event] = await eventsOf(LIVE_ORG);
    const asPlatform = (statement: string, purging?: string) =>
      refusal(
        withPlatformDb(async (db) => {
          if (purging !== undefined)
            await db.$queryRawUnsafe(
              `SELECT set_config('app.purging_organization_id', $1, true)`,
              purging
            );
          return db.$executeRawUnsafe(statement, event!.id);
        })
      );
    const remove = `DELETE FROM pharmacy_terminal_refund_events WHERE id = $1`;
    const rewrite = `UPDATE pharmacy_terminal_refund_events SET reason = 'Rewritten by the platform' WHERE id = $1`;
    // No purge named, and the purge of a different tenant.
    expect(await asPlatform(remove)).toMatch(APPEND_ONLY);
    expect(await asPlatform(remove, PURGED_ORG)).toMatch(APPEND_ONLY);
    // An update is refused even inside the purge of the row's own tenant.
    expect(await asPlatform(rewrite)).toMatch(APPEND_ONLY);
    expect(await asPlatform(rewrite, LIVE_ORG)).toMatch(APPEND_ONLY);
    expect(await eventsOf(LIVE_ORG)).toEqual([event]);
  });

  it('lets the purge of a business delete its refund events, and only its own', async () => {
    const live = await eventsOf(LIVE_ORG);
    // The retention worker's own context and statement for one tenant table
    // (src/lib/platform/jobs.ts purgeData): the control plane's transaction, the purged
    // organization named for that transaction, then a DELETE by organization.
    const deleted = await withPlatformDb(async (db) => {
      await db.$queryRaw`SELECT set_config('app.purging_organization_id', ${PURGED_ORG}, true)`;
      return db.$executeRawUnsafe(
        `DELETE FROM "pharmacy_terminal_refund_events" WHERE "organizationId" = $1`,
        PURGED_ORG
      );
    });
    expect(deleted).toBe(1);

    // Read both ways: as the control plane, and as each tenant.
    const remaining = await withPlatformDb((db) =>
      db.$queryRawUnsafe<Array<{ organizationId: string; events: bigint }>>(
        `SELECT "organizationId", count(*) AS events FROM pharmacy_terminal_refund_events
          WHERE "organizationId" = ANY($1::text[]) GROUP BY "organizationId"`,
        [PURGED_ORG, LIVE_ORG]
      )
    );
    expect(remaining.map((row) => [row.organizationId, Number(row.events)])).toEqual([
      [LIVE_ORG, 1],
    ]);
    expect(await eventsOf(PURGED_ORG)).toEqual([]);
    expect(await eventsOf(LIVE_ORG)).toEqual(live);
  });

  it('refuses a refund event INSERT from the control plane, and still takes the tenant’s own', async () => {
    const { branch, manager } = ids(LIVE_ORG);
    // A second card payment of the live business, with no refund event yet.
    const attempt = `second_${LIVE_ORG}`;
    await withTenantDb(
      LIVE_ORG,
      async (db) => {
        await db.$executeRawUnsafe(
          `INSERT INTO pharmacy_sales (id, "organizationId", "branchId", "createdByUserId", "updatedAt")
           VALUES ($1, $2, $3, 'cashier', now())`,
          attempt,
          LIVE_ORG,
          branch
        );
        await db.$executeRawUnsafe(
          `INSERT INTO pharmacy_card_terminal_attempts (id, "organizationId", "branchId", "saleId", "deviceId", "terminalId", provider, "attemptKey", "amountMinor", currency, "businessDate", "actorId", "updatedAt")
           VALUES ($1, $2, $3, $1, 'device', 'terminal', 'FAKE_TERMINAL', $1, 1601, 'PKR', current_date, 'cashier', now())`,
          attempt,
          LIVE_ORG,
          branch
        );
      },
      { userId: manager }
    );
    // One statement for both callers: a review closed as declined, which needs no journal
    // posting, so nothing but the row level security policy decides who may write it.
    const insert = (db: ScopedDb, id: string) =>
      db.$executeRawUnsafe(
        `INSERT INTO pharmacy_terminal_refund_events
           (id, "organizationId", "branchId", "attemptId", kind, "amountMinor", "remainingMinor",
            "actorId", reason, "slipRef", "roleRules", "ownerAuthority", "terminalConfirmed", "commandKey")
         VALUES ($1, $2, $3, $4, 'DECLINED', 1601, 0, $5, 'Slip shows declined', 'SLIP-2', '{}', false, true, $1)`,
        id,
        LIVE_ORG,
        branch,
        attempt,
        manager
      );
    const before = await eventsOf(LIVE_ORG);

    // The control plane, with and without the purge of that business named.
    for (const purging of [undefined, LIVE_ORG]) {
      expect(
        await refusal(
          withPlatformDb(async (db) => {
            if (purging !== undefined)
              await db.$queryRawUnsafe(
                `SELECT set_config('app.purging_organization_id', $1, true)`,
                purging
              );
            return insert(db, `platform_event_${suffix}`);
          })
        )
      ).toMatch(/row-level security policy/);
    }
    expect(await eventsOf(LIVE_ORG)).toEqual(before);

    // Another tenant cannot write into this business either.
    expect(
      await refusal(withTenantDb(PURGED_ORG, (db) => insert(db, `foreign_event_${suffix}`)))
    ).toMatch(/row-level security policy/);
    expect(await eventsOf(LIVE_ORG)).toEqual(before);

    // The business itself still can.
    const own = `tenant_event_${suffix}`;
    await expect(
      withTenantDb(LIVE_ORG, (db) => insert(db, own), { userId: manager })
    ).resolves.toBe(1);
    expect((await eventsOf(LIVE_ORG)).map((event) => event.id).sort()).toEqual(
      [...before.map((event) => event.id), own].sort()
    );
  });
});
