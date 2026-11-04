// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '@/generated/prisma/client';

const mocks = vi.hoisted(() => ({ runtimeDb: null as PrismaClient | null }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: async <T>(organizationId: string, run: (db: PrismaClient) => Promise<T>) =>
    mocks.runtimeDb!.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT set_config('app.current_organization_id', $1, true),
                set_config('app.is_platform_admin', 'false', true)`,
        organizationId
      );
      return run(tx as unknown as PrismaClient);
    }),
}));

import { sendClaimedMessage } from './message-log';

// Setup creates a restricted login role, grants it table access and seeds both
// tenants, which needs the schema owner with CREATEROLE. In the QA gate
// DATABASE_URL is the NOCREATEROLE runtime role, so prefer OWNER_DATABASE_URL
// (the gate's owner on the same database) and fall back to DATABASE_URL for a
// local superuser setup. The assertions run as the created role either way.
const databaseUrl = process.env.OWNER_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDatabase = databaseUrl ? describe : describe.skip;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const role = `whatsapp_consent_${suffix}`;
const password = randomUUID();
const orgA = `whatsapp_consent_org_a_${suffix}`;
const orgB = `whatsapp_consent_org_b_${suffix}`;
const patientA = `whatsapp_consent_patient_a_${suffix}`;
const patientB = `whatsapp_consent_patient_b_${suffix}`;
const customerA = `whatsapp_consent_customer_a_${suffix}`;
const customerB = `whatsapp_consent_customer_b_${suffix}`;
const admin = databaseUrl ? new pg.Client({ connectionString: databaseUrl }) : null;
let stop: pg.Client | null = null;
let sender: pg.Client | null = null;

async function beginTenant(client: pg.Client, organizationId: string) {
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [
    organizationId,
  ]);
  await client.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
}

async function claim(client: pg.Client, id: string, customerId: string) {
  await beginTenant(client, orgA);
  await client.query(
    `INSERT INTO pharmacy_message_logs
       (id, "organizationId", "customerId", direction, kind, status, "dedupeKey", "updatedAt")
     VALUES ($1, $2, $3, 'OUTBOUND', 'REFILL_REMINDER', 'PENDING', $1, now())`,
    [id, orgA, customerId]
  );
  await client.query('COMMIT');
}

async function drain(logId: string, customerId: string, send: () => Promise<never>) {
  return sendClaimedMessage(
    {
      organizationId: orgA,
      customerId,
      kind: 'REFILL_REMINDER',
      dedupeKey: logId,
    },
    logId,
    send
  );
}

describeIfDatabase('WhatsApp consent send race (restricted PostgreSQL)', () => {
  beforeAll(async () => {
    await admin!.connect();
    await admin!.query(
      `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`
    );
    // PostgreSQL 16+: a NOSUPERUSER CREATEROLE owner holds only ADMIN OPTION on a
    // role it creates; INHERIT lets teardown DROP OWNED BY it. The created role
    // gains nothing from this grant.
    await admin!.query(`GRANT "${role}" TO CURRENT_USER WITH INHERIT TRUE, SET FALSE`);
    // A disposable database may revoke CONNECT from PUBLIC (the QA gate does).
    const [{ database }] = (
      await admin!.query<{ database: string }>('SELECT current_database() AS database')
    ).rows;
    await admin!.query(`GRANT CONNECT ON DATABASE "${database}" TO "${role}"`);
    await admin!.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await admin!.query(
      `GRANT SELECT, INSERT, UPDATE ON pharmacy_customers, pharmacy_message_logs TO "${role}"`
    );

    await admin!.query('BEGIN');
    await admin!.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await admin!.query(
      `INSERT INTO organizations
         (id, slug, "legalName", "displayName", status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, $1, $1, 'ACTIVE', 'SHARED', now(), now()),
              ($2, $2, $2, $2, 'ACTIVE', 'SHARED', now(), now())`,
      [orgA, orgB]
    );
    await admin!.query(
      `INSERT INTO pharmacy_patients (id, "organizationId", "displayName", "updatedAt")
       VALUES ($1, $2, 'Tenant A', now()), ($3, $4, 'Tenant B', now())`,
      [patientA, orgA, patientB, orgB]
    );
    await admin!.query(
      `INSERT INTO pharmacy_customers
         (id, "organizationId", "patientId", "displayName", "whatsappOptIn", "updatedAt")
       VALUES ($1, $2, $3, 'Tenant A', true, now()),
              ($4, $5, $6, 'Tenant B', true, now())`,
      [customerA, orgA, patientA, customerB, orgB, patientB]
    );
    await admin!.query('COMMIT');

    const runtimeUrl = new URL(databaseUrl!);
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    mocks.runtimeDb = new PrismaClient({
      adapter: new PrismaPg({ connectionString: runtimeUrl.toString(), max: 4 }),
    });
    stop = new pg.Client({ connectionString: runtimeUrl.toString() });
    sender = new pg.Client({ connectionString: runtimeUrl.toString() });
    await Promise.all([stop.connect(), sender.connect()]);
    for (const client of [stop!, sender!]) {
      const posture = await client.query(
        `SELECT rolcanlogin, rolsuper, rolbypassrls
         FROM pg_roles WHERE rolname = current_user`
      );
      expect(posture.rows).toEqual([{ rolcanlogin: true, rolsuper: false, rolbypassrls: false }]);
    }
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([stop?.query('ROLLBACK'), sender?.query('ROLLBACK')]);
    await Promise.allSettled([stop?.end(), sender?.end()]);
    await mocks.runtimeDb?.$disconnect();
    if (admin) {
      await admin.query('BEGIN');
      await admin.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      await admin.query(`DELETE FROM organizations WHERE id IN ($1, $2)`, [orgA, orgB]);
      await admin.query('COMMIT');
      await admin.query(`DROP OWNED BY "${role}"`);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    }
    await admin?.end();
  });

  it('suppresses a claimed reminder after a committed opt-out and isolates tenants', async () => {
    const logId = `claimed_then_stopped_${suffix}`;
    await claim(sender!, logId, customerA);

    await beginTenant(stop!, orgA);
    await stop!.query(
      `UPDATE pharmacy_customers SET "whatsappOptIn" = false, "updatedAt" = now()
       WHERE id = $1`,
      [customerA]
    );
    await stop!.query('COMMIT');

    const send = vi.fn<() => Promise<never>>();
    expect(await drain(logId, customerA, send)).toBe('PREPARED');
    expect(send).not.toHaveBeenCalled();
    await beginTenant(sender!, orgA);
    expect(
      (
        await sender!.query(`SELECT status, error FROM pharmacy_message_logs WHERE id = $1`, [
          logId,
        ])
      ).rows
    ).toEqual([{ status: 'IGNORED', error: 'OPTED_OUT_BEFORE_SEND' }]);
    expect(
      (await sender!.query(`SELECT id FROM pharmacy_customers WHERE id = $1`, [customerB])).rows
    ).toEqual([]);
    await sender!.query('COMMIT');
  });

  it('rechecks consent after waiting behind a STOP row lock', async () => {
    const logId = `overlapping_stop_${suffix}`;
    await beginTenant(stop!, orgA);
    await stop!.query(
      `UPDATE pharmacy_customers SET "whatsappOptIn" = true, "updatedAt" = now() WHERE id = $1`,
      [customerA]
    );
    await stop!.query('COMMIT');
    await claim(sender!, logId, customerA);

    await beginTenant(stop!, orgA);
    await stop!.query(
      `UPDATE pharmacy_customers SET "whatsappOptIn" = false, "updatedAt" = now() WHERE id = $1`,
      [customerA]
    );
    const send = vi.fn<() => Promise<never>>();
    const draining = drain(logId, customerA, send);
    const stateBeforeCommit = await Promise.race([
      draining.then(() => 'completed'),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ]);
    expect(stateBeforeCommit).toBe('blocked');

    await stop!.query('COMMIT');
    expect(await draining).toBe('PREPARED');
    expect(send).not.toHaveBeenCalled();
    await beginTenant(sender!, orgA);
    expect(
      (
        await sender!.query(`SELECT status, error FROM pharmacy_message_logs WHERE id = $1`, [
          logId,
        ])
      ).rows
    ).toEqual([{ status: 'IGNORED', error: 'OPTED_OUT_BEFORE_SEND' }]);
    await sender!.query('COMMIT');
  });
});
