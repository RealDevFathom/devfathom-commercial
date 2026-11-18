// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '@/generated/prisma/client';

const mocks = vi.hoisted(() => ({ runtimeDb: null as PrismaClient | null }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: async <T>(organizationId: string, run: (db: PrismaClient) => Promise<T>) =>
    mocks.runtimeDb!.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT set_config('app.current_organization_id', $1, true),
                  set_config('app.is_platform_admin', 'false', true)`,
          organizationId
        );
        return run(tx as unknown as PrismaClient);
      },
      { maxWait: 20_000, timeout: 20_000 }
    ),
}));

import { withTenantDb } from '@/lib/tenancy/scoped-db';

import { claimMessageLogWithAliasesInTransaction } from './message-log';

/**
 * DEV-899: during a deploy an older worker (pre-DEV-316 UTC epoch-week key) and a
 * newer one (workspace ISO-week key) can process the same weekly khata reminder.
 * When the payer changed between their scans, each holds a different patient's
 * consent lock, so only the claimed keys can keep the reminder to one send.
 */
const databaseUrl = process.env.DATABASE_URL;
const describeIfDatabase = databaseUrl ? describe : describe.skip;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const role = `khata_rollout_${suffix}`;
const password = randomUUID();
const org = `khata_rollout_org_${suffix}`;
const oldPayer = {
  patient: `khata_rollout_patient_old_${suffix}`,
  customer: `khata_rollout_customer_old_${suffix}`,
};
const newPayer = {
  patient: `khata_rollout_patient_new_${suffix}`,
  customer: `khata_rollout_customer_new_${suffix}`,
};
const WEEK_MS = 7 * 86_400_000;
const DAY = new Date().toISOString().slice(0, 10);
const admin = databaseUrl ? new pg.Client({ connectionString: databaseUrl }) : null;
let oldWorker: pg.Client | null = null;
let runtimeUrl = '';

let accountSeq = 0;
function reminder() {
  accountSeq += 1;
  const account = `family_${accountSeq}_${suffix}`;
  return {
    account,
    oldKey: `khata:${account}:w${Math.floor(Date.now() / WEEK_MS)}`,
    newKey: `khata:${account}:w2026-47`,
  };
}

/** This local week started an hour ago: anything claimed since then is this week's claim. */
const weekStart = () => new Date(Date.now() - 3_600_000);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The pre-DEV-316 worker's claim: one row under the old key, as its createMany issued it. */
async function oldClaim(client: pg.Client, oldKey: string, customerId: string) {
  const inserted = await client.query(
    `INSERT INTO pharmacy_message_logs
       (id, "organizationId", "customerId", direction, kind, status, "dedupeKey",
        "customerDayKey", "updatedAt")
     VALUES ($1, $2, $3, 'OUTBOUND', 'KHATA_REMINDER', 'PENDING', $4, $5, now())
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [randomUUID(), org, customerId, oldKey, `khata:${customerId}:${DAY}:${oldKey}`]
  );
  return inserted.rowCount === 1;
}

async function beginTenant(client: pg.Client) {
  await client.query('BEGIN');
  await client.query(
    `SELECT set_config('app.current_organization_id', $1, true),
            set_config('app.is_platform_admin', 'false', true)`,
    [org]
  );
}

/** The older worker's whole claim transaction. */
async function oldClaimCommitted(client: pg.Client, oldKey: string, customerId: string) {
  await beginTenant(client);
  try {
    return await oldClaim(client, oldKey, customerId);
  } finally {
    await client.query('COMMIT');
  }
}

/** The current worker's claim; `hold` keeps its transaction open after the claim. */
function newClaim(
  keys: { oldKey: string; newKey: string },
  customerId: string,
  hold?: { claimed: () => void; release: Promise<void> }
) {
  return withTenantDb(org, async (db) => {
    const logId = await claimMessageLogWithAliasesInTransaction(
      db as never,
      {
        organizationId: org,
        direction: 'OUTBOUND',
        status: 'PENDING',
        kind: 'KHATA_REMINDER',
        dedupeKey: keys.newKey,
        customerDayKey: `khata:${customerId}:${DAY}:${keys.newKey}`,
        customerId,
      },
      { dedupeKeys: [keys.oldKey], since: weekStart() }
    );
    hold?.claimed();
    await hold?.release;
    return logId;
  });
}

async function waitForLockWait() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await admin!.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE usename = $1 AND wait_event_type = 'Lock'`,
      [role]
    );
    if (waiting.rows[0].n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the second worker never waited on the first claim');
}

async function rowsFor(account: string) {
  const rows = await admin!.query(
    `SELECT "dedupeKey", status, error, "customerId" FROM pharmacy_message_logs
     WHERE "organizationId" = $1 AND "dedupeKey" LIKE $2 ORDER BY "dedupeKey" COLLATE "C"`,
    [org, `khata:${account}:%`]
  );
  return rows.rows;
}

describeIfDatabase('DEV-899 weekly khata claim across a mixed-version rollout (PostgreSQL)', () => {
  beforeAll(async () => {
    await admin!.connect();
    await admin!.query(
      `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`
    );
    await admin!.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await admin!.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON pharmacy_message_logs TO "${role}"`
    );
    await admin!.query(`GRANT SELECT ON pharmacy_customers, pharmacy_patients TO "${role}"`);

    await admin!.query('BEGIN');
    await admin!.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await admin!.query(
      `INSERT INTO organizations
         (id, slug, "legalName", "displayName", status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, $1, $1, 'ACTIVE', 'SHARED', now(), now())`,
      [org]
    );
    for (const payer of [oldPayer, newPayer]) {
      await admin!.query(
        `INSERT INTO pharmacy_patients (id, "organizationId", "displayName", "updatedAt")
         VALUES ($1, $2, 'Payer', now())`,
        [payer.patient, org]
      );
      await admin!.query(
        `INSERT INTO pharmacy_customers
           (id, "organizationId", "patientId", "displayName", "whatsappOptIn", "updatedAt")
         VALUES ($1, $2, $3, 'Payer', true, now())`,
        [payer.customer, org, payer.patient]
      );
    }
    await admin!.query('COMMIT');

    const url = new URL(databaseUrl!);
    url.username = role;
    url.password = password;
    runtimeUrl = url.toString();
    mocks.runtimeDb = new PrismaClient({
      adapter: new PrismaPg({ connectionString: runtimeUrl, max: 8 }),
    });
    oldWorker = new pg.Client({ connectionString: runtimeUrl });
    await oldWorker.connect();
    const posture = await oldWorker.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
    expect(posture.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  }, 60_000);

  afterAll(async () => {
    await oldWorker?.query('ROLLBACK').catch(() => undefined);
    await oldWorker?.end().catch(() => undefined);
    await mocks.runtimeDb?.$disconnect();
    if (admin) {
      await admin.query('BEGIN');
      await admin.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      await admin.query(`DELETE FROM pharmacy_message_logs WHERE "organizationId" = $1`, [org]);
      await admin.query(`DELETE FROM pharmacy_customers WHERE "organizationId" = $1`, [org]);
      await admin.query(`DELETE FROM pharmacy_patients WHERE "organizationId" = $1`, [org]);
      await admin.query(`DELETE FROM organizations WHERE id = $1`, [org]);
      await admin.query('COMMIT');
      await admin.query(`DROP OWNED BY "${role}"`);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    }
    await admin?.end();
  });

  it('sends once when the older worker claims first and the newer one waits on it', async () => {
    const keys = reminder();
    await beginTenant(oldWorker!);
    const oldSends = await oldClaim(oldWorker!, keys.oldKey, oldPayer.customer);

    const newer = newClaim(keys, newPayer.customer);
    await waitForLockWait();
    await oldWorker!.query('COMMIT');

    const newSends = (await newer) !== null;
    expect([oldSends, newSends]).toEqual([true, false]);
    // All or none: the newer worker's new-format claim did not survive either.
    expect(await rowsFor(keys.account)).toEqual([
      expect.objectContaining({ dedupeKey: keys.oldKey, customerId: oldPayer.customer }),
    ]);
  });

  it('sends once when the newer worker claims first and the older one waits on it', async () => {
    const keys = reminder();
    const claimed = deferred();
    const release = deferred();
    const newer = newClaim(keys, newPayer.customer, {
      claimed: claimed.resolve,
      release: release.promise,
    });
    await claimed.promise;

    await beginTenant(oldWorker!);
    const older = oldClaim(oldWorker!, keys.oldKey, oldPayer.customer);
    await waitForLockWait();
    release.resolve();
    const newSends = (await newer) !== null;
    const oldSends = await older;
    await oldWorker!.query('COMMIT');

    expect([oldSends, newSends]).toEqual([false, true]);
    expect(await rowsFor(keys.account)).toEqual([
      expect.objectContaining({ dedupeKey: keys.newKey, customerId: newPayer.customer }),
      expect.objectContaining({
        dedupeKey: keys.oldKey,
        status: 'IGNORED',
        error: 'DEDUPE_ALIAS',
        customerId: null,
      }),
    ]);
  });

  it('sends exactly once per reminder when the two versions race freely', async () => {
    for (let round = 0; round < 15; round += 1) {
      const keys = reminder();
      const client = new pg.Client({ connectionString: runtimeUrl });
      await client.connect();
      try {
        const [oldSends, newSends] = await Promise.all([
          oldClaimCommitted(client, keys.oldKey, oldPayer.customer),
          newClaim(keys, newPayer.customer).then((id) => id !== null),
        ]);
        expect(Number(oldSends) + Number(newSends)).toBe(1);
      } finally {
        await client.end();
      }
    }
  }, 60_000);

  it('sends once when two newer workers race for different payers', async () => {
    const keys = reminder();
    const results = await Promise.all([
      newClaim(keys, oldPayer.customer),
      newClaim(keys, newPayer.customer),
    ]);
    expect(results.filter((id) => id !== null)).toHaveLength(1);
    expect(await oldClaimCommitted(oldWorker!, keys.oldKey, oldPayer.customer)).toBe(false);
  });

  it('is not blocked by an old-format key an earlier week already holds', async () => {
    const keys = reminder();
    await admin!.query(
      `INSERT INTO pharmacy_message_logs
         (id, "organizationId", "customerId", direction, kind, status, "dedupeKey",
          "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'OUTBOUND', 'KHATA_REMINDER', 'SENT', $4,
               now() - interval '2 days', now())`,
      [randomUUID(), org, oldPayer.customer, keys.oldKey]
    );

    expect(await newClaim(keys, newPayer.customer)).not.toBeNull();
    // The older format stays blocked by its own earlier row.
    expect(await oldClaimCommitted(oldWorker!, keys.oldKey, oldPayer.customer)).toBe(false);
  });
});
