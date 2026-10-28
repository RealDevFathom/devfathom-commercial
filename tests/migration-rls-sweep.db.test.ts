// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

const url = process.env.MIGSWEEP_DATABASE_URL;
const repairs = [
  '20261021180800_repair_package_module_cleanup',
  '20261021180100_repair_pharmacy_reference_permissions',
  '20261021180200_repair_pharmacy_branch_assignments',
  '20261021180300_repair_outbound_effect_cleanup',
  '20261021180400_repair_platform_mfa_initialization',
  '20261021180500_repair_department_defaults',
  '20261021180600_repair_invitation_email_lowercase',
  '20261021180700_repair_delivery_payment_mode',
];
const sql = (name: string) => readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8');

describe('migration #218 repair contracts', () => {
  it('uses unique timestamps and transaction-local platform scope', () => {
    const migrationNames = readdirSync('prisma/migrations');

    for (const name of repairs) {
      const timestamp = name.split('_', 1)[0];
      expect(migrationNames.filter((candidate) => candidate.startsWith(`${timestamp}_`))).toEqual([name]);
      expect(sql(name)).toMatch(
        /^--[^\n]*\n(?:--[^\n]*\n)*BEGIN;\nSELECT set_config\('app\.is_platform_admin', 'true', true\);[\s\S]*\nCOMMIT;\s*$/,
      );
    }
  });

  it('does not rewrite exact pharmacy grants or restore a removed narrow grant', () => {
    const referenceRepair = sql('20261021180100_repair_pharmacy_reference_permissions');

    expect(referenceRepair).not.toContain('INSERT INTO "organization_role_permissions"');
    expect(readdirSync('prisma/migrations')).not.toContain(
      '20261021180900_repair_canonical_pharmacy_capabilities',
    );
  });
});

describe.skipIf(!url)('migration #218 with a non-bypass database owner', () => {
  it('reproduces lost scope, repairs safe data changes without restoring revoked access, and permits replay', async () => {
    const db = new pg.Client({ connectionString: url });
    await db.connect();
    try {
      const attributes = await db.query(`SELECT rolsuper, rolbypassrls,
        current_user = pg_get_userbyid(datdba) AS owns_database
        FROM pg_roles, pg_database WHERE rolname = current_user AND datname = current_database()`);
      expect(attributes.rows).toEqual([{ rolsuper: false, rolbypassrls: false, owns_database: true }]);
      const tables = ['organization_modules', 'organization_roles', 'organization_role_permissions',
        'users', 'pharmacy_branches', 'pharmacy_branch_assignments', 'outbound_effects',
        'invitations', 'restaurant_delivery_fulfillments', 'organization_departments', 'platform_users'];
      const policies = await db.query(`SELECT relname FROM pg_class
        WHERE relname = ANY($1) AND relrowsecurity AND relforcerowsecurity
        AND relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)`, [tables]);
      expect(policies.rowCount).toBe(tables.length);

      await db.query(`BEGIN;
        SELECT set_config('app.is_platform_admin', 'true', true);
        INSERT INTO platform_users (id,name,email,"passwordHash","mfaRequired","mfaEnabledAt","updatedAt") VALUES
          ('sweep218_unenrolled','Legacy','sweep218-legacy@example.invalid','unused',true,NULL,now()),
          ('sweep218_enrolled','Enrolled','sweep218-enrolled@example.invalid','unused',true,now(),now());
        INSERT INTO platform_packages (id,key,name,"updatedAt") VALUES ('sweep218_pkg','sweep218_pkg','Sweep 218',now());
        INSERT INTO organizations (id,slug,"legalName","displayName",vertical,status,"packageId","updatedAt") VALUES
          ('sweep218_a','sweep218-a','Sweep A','Sweep A','PHARMACY','ACTIVE','sweep218_pkg',now()),
          ('sweep218_b','sweep218-b','Sweep B','Sweep B','RESTAURANT','ACTIVE',NULL,now());
        INSERT INTO platform_modules (id,key,name,category,band,"updatedAt")
          VALUES ('sweep218_mod','sweep218_mod','Sweep','test','BASELINE',now());
        INSERT INTO platform_package_modules (id,"packageId","moduleId")
          VALUES ('sweep218_pm','sweep218_pkg','sweep218_mod');
        INSERT INTO organization_modules (id,"organizationId","moduleId",reason,"updatedAt") VALUES
          ('sweep218_copy','sweep218_a','sweep218_mod','Included with Sweep 218',now()),
          ('sweep218_override','sweep218_b','sweep218_mod',NULL,now());
        INSERT INTO organization_roles (id,"organizationId",key,name,"updatedAt") VALUES
          ('sweep218_role_a','sweep218_a','pharmacist','Pharmacist',now()),
          ('sweep218_role_b','sweep218_b','pharmacist','Other tenant',now());
        INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES
          ('sweep218_dept_a','sweep218_a','test','Test',now()),
          ('sweep218_dept_b','sweep218_b','test','Test',now());
        INSERT INTO users (id,"organizationId","organizationRoleId",name,email,department,title,status,"updatedAt") VALUES
          ('sweep218_active','sweep218_a','sweep218_role_a','Active','sweep218-active@example.invalid','test','test','ACTIVE',now()),
          ('sweep218_leave','sweep218_a','sweep218_role_a','Leave','sweep218-leave@example.invalid','test','test','ON_LEAVE',now()),
          ('sweep218_inactive','sweep218_a','sweep218_role_a','Inactive','sweep218-inactive@example.invalid','test','test','INACTIVE',now()),
          ('sweep218_other','sweep218_b','sweep218_role_b','Other','sweep218-other@example.invalid','test','test','ACTIVE',now());
        INSERT INTO organization_role_permissions
          (id,"organizationId","organizationRoleId",capability,effect) VALUES
          ('sweep218_rp_counter','sweep218_a','sweep218_role_a','pharmacy.counter','ALLOW'),
          ('sweep218_rp_dispense_old','sweep218_a','sweep218_role_a','pharmacy.dispense','DENY'),
          ('sweep218_rp_dispense_new','sweep218_a','sweep218_role_a','pharmacy:dispense','ALLOW'),
          ('sweep218_rp_inventory_old','sweep218_a','sweep218_role_a','pharmacy.inventory','ALLOW'),
          ('sweep218_rp_inventory_new','sweep218_a','sweep218_role_a','pharmacy:inventory','DENY');
        INSERT INTO user_permission_overrides
          (id,"organizationId","userId",capability,effect,reason,"updatedAt") VALUES
          ('sweep218_up_manage','sweep218_a','sweep218_active','pharmacy.manage','DENY','legacy deny',now()),
          ('sweep218_up_audit_old','sweep218_a','sweep218_active','pharmacy.audit','ALLOW','legacy allow',now()),
          ('sweep218_up_audit_new','sweep218_a','sweep218_active','pharmacy:audit','DENY','canonical deny',now()),
          ('sweep218_up_finance_old','sweep218_a','sweep218_active','pharmacy.finance','DENY','legacy deny',now()),
          ('sweep218_up_finance_new','sweep218_a','sweep218_active','pharmacy:finance','ALLOW','canonical allow',now());
        INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode",active,"updatedAt") VALUES
          ('sweep218_branch','sweep218_a','SWEEP218','Sweep','Test','Karachi','SD',true,now()),
          ('sweep218_closed','sweep218_a','SWEEP218C','Closed','Test','Karachi','SD',false,now());
        INSERT INTO outbound_effects (id,"organizationId",kind,payload,status,"updatedAt") VALUES
          ('sweep218_webhook','sweep218_a','webhook','{"secret":"old","url":"old","meta":{"secret":"nested","keep":2},"keep":1}','PENDING',now()),
          ('sweep218_failed','sweep218_a','email','{"personal":"old"}','FAILED',now());

        INSERT INTO invitations (id,"organizationId","userId",email,"tokenHash","expiresAt","updatedAt")
          VALUES ('sweep218_invite','sweep218_a','sweep218_active',' Invite@Example.invalid ','sweep218_token',now()+interval '1 day',now());
        INSERT INTO restaurant_branches (id,"organizationId",name,"updatedAt")
          VALUES ('sweep218_restbranch','sweep218_b','Test',now());
        INSERT INTO restaurant_customers (id,"organizationId","displayName","updatedAt")
          VALUES ('sweep218_customer','sweep218_b','Test',now());
        INSERT INTO restaurant_staff_profiles (id,"organizationId","displayName","updatedAt")
          VALUES ('sweep218_staff','sweep218_b','Test',now());
        INSERT INTO restaurant_registered_devices (id,"organizationId","branchId",name,"deviceSecretHash","updatedAt")
          VALUES ('sweep218_device','sweep218_b','sweep218_restbranch','Test','unused',now());
        INSERT INTO restaurant_orders (id,"organizationId","branchId","orderNumber","businessDate",channel,"customerId","staffProfileId","deviceId","updatedAt")
          VALUES ('sweep218_order','sweep218_b','sweep218_restbranch',1,current_date,'DELIVERY','sweep218_customer','sweep218_staff','sweep218_device',now());
        SELECT set_config('app.current_organization_id', 'sweep218_b', true);
        INSERT INTO restaurant_delivery_fulfillments (id,"organizationId","branchId","customerId","orderId","paymentMode",
          "recipientNameSnapshot","normalizedPhoneSnapshot","addressLine1Snapshot","localitySnapshot","countryCodeSnapshot",
          "deliveryFeeSnapshot","promisedMinutesSnapshot","promisedAt","updatedAt")
          VALUES ('sweep218_delivery','sweep218_b','sweep218_restbranch','sweep218_customer','sweep218_order','COD',
            'Test','+12025550123','Test','Test','US',12.34,30,now(),now());
        COMMIT;`);

      // Separate queries model the autocommit execution path that loses LOCAL scope.
      await db.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      expect((await db.query(`SELECT count(*)::int n FROM users WHERE id LIKE 'sweep218_%'`)).rows[0].n).toBe(0);
      for (const name of repairs) {
        const body = sql(name).split("SELECT set_config('app.is_platform_admin', 'true', true);")[1]
          .replace(/COMMIT;\s*$/, '');
        await db.query(body);
      }

      async function counts() {
        await db.query(`BEGIN; SELECT set_config('app.is_platform_admin', 'true', true); SELECT set_config('app.current_organization_id', 'sweep218_b', true)`);
        try {
          const result = await db.query(`SELECT
            (SELECT count(*)::int FROM invitations WHERE id='sweep218_invite' AND email='invite@example.invalid') AS invitations,
            (SELECT count(*)::int FROM restaurant_delivery_fulfillments WHERE id='sweep218_delivery' AND "paymentMode" IS NOT NULL) AS pending_modes,
            (SELECT count(*)::int FROM restaurant_delivery_fulfillments WHERE id='sweep218_delivery' AND "deliveryFeeSnapshot"=12.34) AS money_snapshots,
            (SELECT count(*)::int FROM organization_modules WHERE id='sweep218_override') AS pins,
            (SELECT count(*)::int FROM platform_users WHERE id='sweep218_unenrolled' AND "mfaRequired") AS unenrolled_required,
            (SELECT count(*)::int FROM platform_users WHERE id='sweep218_enrolled' AND "mfaRequired") AS enrolled_required,
            (SELECT count(*)::int FROM organization_departments WHERE "organizationId"='sweep218_b' AND key IN ('KITCHEN','FRONT_OF_HOUSE')) AS defaults,
            (SELECT count(*)::int FROM organization_modules WHERE id='sweep218_copy') AS copies,
            (SELECT count(*)::int FROM organization_modules WHERE id='sweep218_override') AS overrides,
            (SELECT count(*)::int FROM organization_role_permissions WHERE "organizationRoleId"='sweep218_role_a' AND capability='pharmacy:catalogue-review') AS permissions,
            (SELECT count(*)::int FROM organization_role_permissions WHERE id LIKE 'sweep218_rp_%' AND capability LIKE 'pharmacy.%') AS exact_role_grants,
            (SELECT count(*)::int FROM organization_role_permissions WHERE id LIKE 'sweep218_rp_%' AND capability LIKE 'pharmacy:%' AND effect='ALLOW') AS colon_role_allows,
            (SELECT count(*)::int FROM organization_role_permissions WHERE id LIKE 'sweep218_rp_%' AND capability LIKE 'pharmacy:%' AND effect='DENY') AS colon_role_denies,
            (SELECT count(*)::int FROM user_permission_overrides WHERE id LIKE 'sweep218_up_%' AND capability LIKE 'pharmacy.%') AS exact_user_overrides,
            (SELECT count(*)::int FROM user_permission_overrides WHERE id LIKE 'sweep218_up_%' AND capability LIKE 'pharmacy:%' AND effect='ALLOW') AS colon_user_allows,
            (SELECT count(*)::int FROM user_permission_overrides WHERE id LIKE 'sweep218_up_%' AND capability LIKE 'pharmacy:%' AND effect='DENY') AS colon_user_denies,
            (SELECT count(*)::int FROM organization_role_permissions WHERE "organizationRoleId"='sweep218_role_b') AS other_permissions,
            (SELECT count(*)::int FROM pharmacy_branch_assignments WHERE "organizationId"='sweep218_a') AS assignments,
            (SELECT count(*)::int FROM outbound_effects WHERE id='sweep218_failed') AS failed,
            (SELECT count(*)::int FROM outbound_effects WHERE id='sweep218_webhook' AND payload='{"meta":{"keep":2},"keep":1}'::jsonb) AS sanitized`);
          return result.rows[0];
        } finally { await db.query('COMMIT'); }
      }
      expect(await counts()).toEqual({ unenrolled_required: 1, enrolled_required: 1, defaults: 0, copies: 1, overrides: 1, invitations: 0, pending_modes: 1, money_snapshots: 1, pins: 1, permissions: 0, exact_role_grants: 3, colon_role_allows: 1, colon_role_denies: 1, exact_user_overrides: 3, colon_user_allows: 1, colon_user_denies: 1, other_permissions: 0, assignments: 0, failed: 1, sanitized: 0 });
      for (let pass = 0; pass < 2; pass++) {
        for (const name of repairs) await db.query(sql(name));
        expect(await counts()).toEqual({ unenrolled_required: 1, enrolled_required: 1, defaults: 2, copies: 0, overrides: 1, invitations: 1, pending_modes: 0, money_snapshots: 1, pins: 1, permissions: 0, exact_role_grants: 3, colon_role_allows: 1, colon_role_denies: 1, exact_user_overrides: 3, colon_user_allows: 1, colon_user_denies: 1, other_permissions: 0, assignments: 2, failed: 0, sanitized: 1 });
        if (pass === 0) await db.query(`BEGIN;
          SELECT set_config('app.is_platform_admin', 'true', true);
          INSERT INTO users (id,"organizationId","organizationRoleId",name,email,department,title,status,"updatedAt")
          VALUES ('sweep218_new','sweep218_a','sweep218_role_a','New','sweep218-new@example.invalid','test','test','ACTIVE',now());
          COMMIT;`);
        expect((await db.query(`SELECT count(*)::int n FROM pharmacy_branch_assignments`)).rows[0].n).toBe(0);
      }
      console.info('#245 row counts: MFA requirements 2→2; removed grants 0→0; invitations normalized 0→1; pending payment modes 1→0; null-reason pins 1→1; copies 1→0; overrides 1→1; permissions 0→0; assignments 0→2; failed 1→0; sanitized 0→1; replay unchanged; unscoped assignments 0');
    } finally {
      await db.query('ROLLBACK').catch(() => undefined);
      await db.end();
    }
  });
});
