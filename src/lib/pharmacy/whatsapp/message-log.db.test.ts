// @vitest-environment node
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
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

async function drain(client: pg.Client, logId: string, customerId: string) {
  await beginTenant(client, orgA);
  const eligible = await client.query<{ id: string }>(
    `SELECT id FROM pharmacy_customers
     WHERE "organizationId" = $1 AND id = $2 AND active = true AND "whatsappOptIn" = true
     FOR UPDATE`,
    [orgA, customerId]
  );
  if (eligible.rowCount === 0) {
    await client.query(
      `UPDATE pharmacy_message_logs
       SET status = 'IGNORED', error = 'OPTED_OUT_BEFORE_SEND', "updatedAt" = now()
       WHERE id = $1`,
      [logId]
    );
  }
  await client.query('COMMIT');
  return eligible.rows;
}

describeIfDatabase('WhatsApp consent send race (restricted PostgreSQL)', () => {
  beforeAll(async () => {
    await admin!.connect();
    await admin!.query(
      `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`
    );
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
    stop = new pg.Client({ connectionString: runtimeUrl.toString() });
    sender = new pg.Client({ connectionString: runtimeUrl.toString() });
    await Promise.all([stop.connect(), sender.connect()]);
    for (const client of [stop!, sender!]) {
      const posture = await client.query(
        `SELECT rolcanlogin, rolsuper, rolbypassrls
         FROM pg_roles WHERE rolname = current_user`
      );
      expect(posture.rows).toEqual([
        { rolcanlogin: true, rolsuper: false, rolbypassrls: false },
      ]);
    }
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([stop?.query('ROLLBACK'), sender?.query('ROLLBACK')]);
    await Promise.allSettled([stop?.end(), sender?.end()]);
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

    expect(await drain(sender!, logId, customerA)).toEqual([]);
    await beginTenant(sender!, orgA);
    expect(
      (await sender!.query(`SELECT status, error FROM pharmacy_message_logs WHERE id = $1`, [logId]))
        .rows
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
    const draining = drain(sender!, logId, customerA);
    const stateBeforeCommit = await Promise.race([
      draining.then(() => 'completed'),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ]);
    expect(stateBeforeCommit).toBe('blocked');

    await stop!.query('COMMIT');
    expect(await draining).toEqual([]);
    await beginTenant(sender!, orgA);
    expect(
      (await sender!.query(`SELECT status, error FROM pharmacy_message_logs WHERE id = $1`, [logId]))
        .rows
    ).toEqual([{ status: 'IGNORED', error: 'OPTED_OUT_BEFORE_SEND' }]);
    await sender!.query('COMMIT');
  });
});
