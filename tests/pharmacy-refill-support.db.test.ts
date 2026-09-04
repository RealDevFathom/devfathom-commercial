import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runtimeUrl = process.env.WHA1325_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const describeIfDatabase = runtimeUrl ? describe : describe.skip;
let runtime: Client;

describeIfDatabase('RX-07 PostgreSQL patient-context boundary', () => {
  beforeAll(async () => {
    const parsed = new URL(runtimeUrl!);
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname))
      throw new Error('Refusing to run RX-07 probes against a non-local database.');
    runtime = new Client({ connectionString: runtimeUrl });
    await runtime.connect();
  });

  afterAll(async () => runtime?.end());

  it('runs as a restricted LOGIN role without SUPERUSER or BYPASSRLS', async () => {
    const result = await runtime.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>('SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user');
    expect(result.rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });
  });

  it('forces a policy containing both tenant and branch scope', async () => {
    const relation = await runtime.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='pharmacy_refill_reminder_captures'`
    );
    expect(relation.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const policy = await runtime.query<{ qual: string; with_check: string }>(
      `SELECT qual,with_check FROM pg_policies WHERE tablename='pharmacy_refill_reminder_captures'`
    );
    expect(policy.rows).toHaveLength(1);
    expect(policy.rows[0]?.qual).toContain('app.current_organization_id');
    expect(policy.rows[0]?.qual).toContain('app.current_branch_id');
    expect(policy.rows[0]?.with_check).toContain('app.current_branch_id');
  });

  it.each([
    ['cross-tenant', 'tenant_other', 'branch_main'],
    ['cross-branch', 'tenant_main', 'branch_other'],
  ])(
    'NEGATIVE: RLS rejects an explicit %s capture before parent lookup',
    async (_label, organizationId, branchId) => {
      await runtime.query('BEGIN');
      try {
        await runtime.query(`SET LOCAL app.is_platform_admin='false'`);
        await runtime.query(`SET LOCAL app.current_organization_id='tenant_main'`);
        await runtime.query(`SET LOCAL app.current_branch_id='branch_main'`);
        await expect(
          runtime.query(
            `INSERT INTO pharmacy_refill_reminder_captures
            (id,"organizationId","branchId","prescriptionFillId","patientId",channel,
             "consentEventId","medicineName",strength,"dosageForm","directionsEnglish",
             "directionsUrdu","quantityDispensed","dosesPerDay","expectedExhaustionAt",
             "reminderAt","capturedByUserId","idempotencyKey")
           VALUES ('probe',$1,$2,'fill','patient','SMS','consent','Medicine','1 mg','Tablet',
                   'Once daily','روزانہ',1,1,now() + interval '1 day',now(),'actor','probe')`,
            [organizationId, branchId]
          )
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await runtime.query('ROLLBACK');
      }
    }
  );

  it('keeps marketing identifiers out of the clinical capture table', async () => {
    const columns = await runtime.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='pharmacy_refill_reminder_captures'`
    );
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining(['marketingCampaignId', 'marketingContactId'])
    );
  });
});
