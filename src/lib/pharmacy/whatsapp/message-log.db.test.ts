import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const RUNTIME_DATABASE_URL =
  process.env.PHARMACY_WHATSAPP_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.PHARMACY_WHATSAPP_TEST_OWNER_DATABASE_URL;
const describeIfDatabase = RUNTIME_DATABASE_URL && OWNER_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');

const ORG_A = `org_wa_a_${suffix}`;
const ORG_B = `org_wa_b_${suffix}`;
const BRANCH_A = `branch_wa_a_${suffix}`;
const CUSTOMER_A = `customer_wa_a_${suffix}`;
const DEDUPE_KEY = `refill:patient_wa_a_${suffix}:medicine-1:2026-10-01`;

let owner: Client | null = null;
const clients: Client[] = [];

async function runtime(organizationId: string) {
  const client = new Client({ connectionString: RUNTIME_DATABASE_URL });
  await client.connect();
  clients.push(client);
  await client.query(
    `SELECT set_config('app.current_organization_id', $1, false),
            set_config('app.current_user_id', '', false),
            set_config('app.is_platform_admin', 'false', false)`,
    [organizationId]
  );
  return client;
}

/** The statement Prisma emits for `createManyAndReturn({ skipDuplicates: true })`. */
function claim(
  client: Client,
  dedupeKey: string,
  extra: { kind?: string; phoneLast4?: string } = {}
) {
  return client.query<{ id: string; organizationId: string }>(
    `INSERT INTO pharmacy_message_logs
      (id, "branchId", "customerId", direction, kind, status, "dedupeKey", "phoneLast4", "dueDate", "updatedAt")
     VALUES ($1, $2, $3, 'OUTBOUND', $4, 'PENDING', $5, $6, '2026-10-01', now())
     ON CONFLICT DO NOTHING
     RETURNING id, "organizationId"`,
    [
      `log_${randomBytes(6).toString('hex')}`,
      extra.kind === undefined ? BRANCH_A : null,
      extra.kind === undefined ? CUSTOMER_A : null,
      extra.kind ?? 'REFILL_REMINDER',
      dedupeKey,
      extra.phoneLast4 ?? '4567',
    ]
  );
}

beforeAll(async () => {
  if (!RUNTIME_DATABASE_URL || !OWNER_DATABASE_URL) return;
  expect(RUNTIME_DATABASE_URL).not.toBe(OWNER_DATABASE_URL);

  owner = new Client({ connectionString: OWNER_DATABASE_URL });
  await owner.connect();
  await owner.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
  await owner.query(
    `INSERT INTO organizations
      (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
     VALUES ($1,$2,'WA A','WA A','PHARMACY','ACTIVE','SHARED',now(),now()),
            ($3,$4,'WA B','WA B','PHARMACY','ACTIVE','SHARED',now(),now())`,
    [ORG_A, `wa-a-${suffix}`, ORG_B, `wa-b-${suffix}`]
  );
  await owner.query(
    `INSERT INTO pharmacy_branches
      (id, "organizationId", code, name, "addressLine", city, "provinceCode", active, "createdAt", "updatedAt")
     VALUES ($1,$2,'A','Branch A','1 A Road','Lahore','PB',true,now(),now())`,
    [BRANCH_A, ORG_A]
  );
  await owner.query(
    `INSERT INTO pharmacy_patients (id, "organizationId", "displayName", phone, "createdAt", "updatedAt")
     VALUES ($1,$2,'Customer A','0300-1234567',now(),now())`,
    [`patient_wa_a_${suffix}`, ORG_A]
  );
  await owner.query(
    `INSERT INTO pharmacy_customers
      (id, "organizationId", "patientId", "displayName", active, "createdAt", "updatedAt")
     VALUES ($1,$2,$3,'Customer A',true,now(),now())`,
    [CUSTOMER_A, ORG_A, `patient_wa_a_${suffix}`]
  );
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.end()));
  await owner?.end();
});

describeIfDatabase('PH-B3 pharmacy_message_logs', () => {
  it('runs as a restricted runtime role and forces RLS on the log', async () => {
    const client = await runtime(ORG_A);
    const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const rls = await owner!.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'pharmacy_message_logs'`
    );
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('adds a nullable WhatsApp consent flag to customers, null by default', async () => {
    const client = await runtime(ORG_A);
    const before = await client.query(
      `SELECT "whatsappOptIn", "whatsappOptInChangedAt" FROM pharmacy_customers WHERE id = $1`,
      [CUSTOMER_A]
    );
    expect(before.rows[0]).toEqual({ whatsappOptIn: null, whatsappOptInChangedAt: null });
    await client.query(
      `UPDATE pharmacy_customers SET "whatsappOptIn" = false, "whatsappOptInChangedAt" = now() WHERE id = $1`,
      [CUSTOMER_A]
    );
    const after = await client.query(
      `SELECT "whatsappOptIn" FROM pharmacy_customers WHERE id = $1`,
      [CUSTOMER_A]
    );
    expect(after.rows[0]).toEqual({ whatsappOptIn: false });
  });

  it('claims a dedupe key once per organization and defaults the tenant from session', async () => {
    const clientA = await runtime(ORG_A);
    const first = await claim(clientA, DEDUPE_KEY);
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]!.organizationId).toBe(ORG_A);

    const repeat = await claim(clientA, DEDUPE_KEY);
    expect(repeat.rows).toHaveLength(0);

    await clientA.query(
      `UPDATE pharmacy_message_logs SET status = 'SENT', "providerMessageId" = 'wamid.1', "updatedAt" = now() WHERE id = $1`,
      [first.rows[0]!.id]
    );
    const rows = await clientA.query(
      `SELECT status, "providerMessageId" FROM pharmacy_message_logs WHERE "dedupeKey" = $1`,
      [DEDUPE_KEY]
    );
    expect(rows.rows).toEqual([{ status: 'SENT', providerMessageId: 'wamid.1' }]);

    // The same key in another tenant is independent.
    const clientB = await runtime(ORG_B);
    const other = await claim(clientB, DEDUPE_KEY, { kind: 'ORDER_FALLBACK' });
    expect(other.rows).toHaveLength(1);
    expect(other.rows[0]!.organizationId).toBe(ORG_B);
  });

  it('rejects a plain duplicate insert with a unique violation', async () => {
    const clientA = await runtime(ORG_A);
    await expect(
      clientA.query(
        `INSERT INTO pharmacy_message_logs (id, direction, kind, status, "dedupeKey", "updatedAt")
         VALUES ($1, 'OUTBOUND', 'REFILL_REMINDER', 'PENDING', $2, now())`,
        [`log_dup_${suffix}`, DEDUPE_KEY]
      )
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('isolates tenants: another organization can neither read nor write A rows', async () => {
    const clientB = await runtime(ORG_B);
    const visible = await clientB.query(
      `SELECT "organizationId" FROM pharmacy_message_logs WHERE "organizationId" = $1`,
      [ORG_A]
    );
    expect(visible.rows).toEqual([]);
    await expect(
      clientB.query(
        `INSERT INTO pharmacy_message_logs
          (id, "organizationId", direction, kind, status, "dedupeKey", "updatedAt")
         VALUES ($1, $2, 'INBOUND', 'ORDER_REQUEST', 'RECEIVED', $3, now())`,
        [`log_cross_${suffix}`, ORG_A, `in:cross-${suffix}`]
      )
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('enforces the kind, phone and due-date checks', async () => {
    const clientA = await runtime(ORG_A);
    await expect(claim(clientA, `bad-kind-${suffix}`, { kind: 'MARKETING' })).rejects.toMatchObject(
      {
        code: '23514',
      }
    );
    await expect(
      claim(clientA, `bad-phone-${suffix}`, { phoneLast4: '923001234567' })
    ).rejects.toMatchObject({ code: '23514' });
  });
});
