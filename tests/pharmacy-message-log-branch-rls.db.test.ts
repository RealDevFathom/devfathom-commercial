// @vitest-environment node
import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Loyalty 5 hold fix: `pharmacy_message_logs` holds branch-tagged refill
 * reminder outbox rows (patient and capture links, due date, template
 * payload), so it carries the standard pharmacy tenant + branch policy.
 * Proved against the real FORCE RLS policy, as the restricted runtime role,
 * with two tenants and two branches.
 */
const runtimeUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL;
const describeIfDatabase = runtimeUrl && ownerUrl ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const id = (label: string) => `mlrls_${label}_${suffix}`;

const ORG_A = id('org_a');
const ORG_B = id('org_b');
const A1 = id('branch_a1');
const A2 = id('branch_a2');
const B1 = id('branch_b1');
const LOG = {
  a1Reminder: id('log_a1'),
  a2Reminder: id('log_a2'),
  aIntake: id('log_a_intake'),
  b1Reminder: id('log_b1'),
};
const ALL_LOGS = Object.values(LOG);

const owner = ownerUrl ? new pg.Client({ connectionString: ownerUrl }) : null;

async function session(organizationId: string, branchId: string | null) {
  const client = new pg.Client({ connectionString: runtimeUrl });
  await client.connect();
  await client.query(
    `SELECT set_config('app.is_platform_admin', 'false', false),
            set_config('app.current_organization_id', $1, false),
            set_config('app.current_branch_id', $2, false)`,
    [organizationId, branchId ?? '']
  );
  return client;
}

async function asSession<T>(
  organizationId: string,
  branchId: string | null,
  work: (client: pg.Client) => Promise<T>
) {
  const client = await session(organizationId, branchId);
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

function visibleLogs(organizationId: string, branchId: string | null) {
  return asSession(organizationId, branchId, async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM pharmacy_message_logs WHERE id = ANY($1) ORDER BY id`,
      [ALL_LOGS]
    );
    return result.rows.map((row) => row.id).sort();
  });
}

async function expectPgCode(code: string, operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected PostgreSQL error ${code}`);
}

function reminder(logId: string, organizationId: string, branchId: string, label: string) {
  return owner!.query(
    `INSERT INTO pharmacy_message_logs
      (id, "organizationId", "branchId", "patientId", direction, kind, status, "dedupeKey",
       "templateName", "refillCaptureId", "dueDate", "templateLocale", "templatePayload",
       "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, 'OUTBOUND', 'REFILL_REMINDER', 'PENDING', $5,
       'refill_reminder_bilingual_v1', $6, '2026-11-01', 'en-ur', '{"template":"x"}'::jsonb,
       now(), now())`,
    [
      logId,
      organizationId,
      branchId,
      id(`patient_${label}`),
      `refill-capture:${id(`capture_${label}`)}`,
      id(`capture_${label}`),
    ]
  );
}

describeIfDatabase('pharmacy_message_logs tenant + branch row-level security', () => {
  beforeAll(async () => {
    for (const url of [runtimeUrl!, ownerUrl!]) {
      if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname))
        throw new Error('Refusing to run message-log RLS probes against a non-local database.');
    }
    await owner!.connect();
    await owner!.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await owner!.query(
      `INSERT INTO organizations
        (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $2, 'Logs A', 'Logs A', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now()),
              ($3, $4, 'Logs B', 'Logs B', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      [ORG_A, `${ORG_A}-slug`, ORG_B, `${ORG_B}-slug`]
    );
    await owner!.query(
      `INSERT INTO pharmacy_branches
        (id, "organizationId", code, name, "addressLine", city, "provinceCode", active, "createdAt", "updatedAt")
       VALUES ($1, $2, 'A1', 'Branch A1', '1 A Road', 'Lahore', 'PB', true, now(), now()),
              ($3, $2, 'A2', 'Branch A2', '2 A Road', 'Lahore', 'PB', true, now(), now()),
              ($4, $5, 'B1', 'Branch B1', '1 B Road', 'Karachi', 'SD', true, now(), now())`,
      [A1, ORG_A, A2, B1, ORG_B]
    );
    await reminder(LOG.a1Reminder, ORG_A, A1, 'a1');
    await reminder(LOG.a2Reminder, ORG_A, A2, 'a2');
    await reminder(LOG.b1Reminder, ORG_B, B1, 'b1');
    // Inbound intake arrives before any branch is known: organization level.
    await owner!.query(
      `INSERT INTO pharmacy_message_logs
        (id, "organizationId", "branchId", direction, kind, status, "dedupeKey", "createdAt", "updatedAt")
       VALUES ($1, $2, NULL, 'INBOUND', 'OPT_OUT', 'RECEIVED', $3, now(), now())`,
      [LOG.aIntake, ORG_A, `in:${id('intake')}`]
    );
  });

  afterAll(async () => {
    await owner?.end();
  });

  it('runs as a restricted role against a forced tenant + branch policy', async () => {
    await asSession(ORG_A, null, async (client) => {
      const role = await client.query(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      );
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      const table = await client.query(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'pharmacy_message_logs'`
      );
      expect(table.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const policies = await client.query<{ policyname: string; qual: string; with_check: string }>(
        `SELECT policyname, qual, with_check FROM pg_policies WHERE tablename = 'pharmacy_message_logs'`
      );
      expect(policies.rows.map((row) => row.policyname)).toEqual(['tenant_branch_isolation']);
      expect(policies.rows[0]!.qual).toContain('app.current_branch_id');
      expect(policies.rows[0]!.with_check).toContain('app.current_branch_id');
    });
  });

  it("hides another branch's reminder rows from a branch-bound session", async () => {
    await expect(visibleLogs(ORG_A, A1)).resolves.toEqual([LOG.a1Reminder, LOG.aIntake].sort());
    await expect(visibleLogs(ORG_A, A2)).resolves.toEqual([LOG.a2Reminder, LOG.aIntake].sort());
  });

  it('gives the organization-wide service session its own tenant only', async () => {
    await expect(visibleLogs(ORG_A, null)).resolves.toEqual(
      [LOG.a1Reminder, LOG.a2Reminder, LOG.aIntake].sort()
    );
    await expect(visibleLogs(ORG_B, null)).resolves.toEqual([LOG.b1Reminder]);
    await expect(visibleLogs(ORG_B, B1)).resolves.toEqual([LOG.b1Reminder]);
    // Naming the other tenant's branch does not open it.
    await expect(visibleLogs(ORG_B, A1)).resolves.toEqual([]);
  });

  it('refuses a branch-bound write into, or a move to, another branch', async () => {
    await asSession(ORG_A, A1, async (client) => {
      await expectPgCode('42501', () =>
        client.query(
          `INSERT INTO pharmacy_message_logs
            (id, "organizationId", "branchId", direction, kind, status, "dedupeKey", "updatedAt")
           VALUES ($1, $2, $3, 'OUTBOUND', 'REFILL_REMINDER', 'PENDING', $4, now())`,
          [id('forged'), ORG_A, A2, `refill-capture:${id('forged')}`]
        )
      );
      await expectPgCode('42501', () =>
        client.query(`UPDATE pharmacy_message_logs SET "branchId" = $1 WHERE id = $2`, [
          A2,
          LOG.a1Reminder,
        ])
      );
      const acknowledged = await client.query(
        `UPDATE pharmacy_message_logs SET status = 'DELIVERED' WHERE id = $1`,
        [LOG.a2Reminder]
      );
      expect(acknowledged.rowCount).toBe(0);
    });
    const untouched = await owner!.query(
      `SELECT "branchId", status FROM pharmacy_message_logs WHERE id = ANY($1) ORDER BY id`,
      [[LOG.a1Reminder, LOG.a2Reminder]]
    );
    expect(untouched.rows).toEqual([
      { branchId: A1, status: 'PENDING' },
      { branchId: A2, status: 'PENDING' },
    ]);
  });
});
