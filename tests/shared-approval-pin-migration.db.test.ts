// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { expect, it, vi } from 'vitest';
import { verifyApprovalSecret } from '@/lib/approval-authenticator';
import { hashOperatorCredential } from '@/lib/restaurant/operator-credentials';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('server-only', () => ({}));

const url = process.env.PHARMACY_DB_TEST_OWNER_URL;
const migration = readFileSync(
  'prisma/migrations/20261126020000_shared_approval_pin_provenance/migration.sql',
  'utf8'
);

async function createHistoricalSchema(db: Client) {
  await db.query(`
      CREATE TEMP TABLE organizations(id text primary key, "packageId" text, "isDemo" boolean default false);
      CREATE TEMP TABLE platform_modules(id text, key text, active boolean, band text);
      CREATE TEMP TABLE organization_modules(id text, "organizationId" text, "moduleId" text, status text, "startsAt" timestamp default '2025-01-01', "expiresAt" timestamp);
      CREATE TEMP TABLE platform_package_modules("packageId" text, "moduleId" text, enabled boolean);
      CREATE TEMP TABLE platform_contracts(id text, "organizationId" text, status text, "startDate" timestamp, "endDate" timestamp, "graceUntil" timestamp);
      CREATE TEMP TABLE platform_contract_modules("contractId" text, "moduleId" text);
      INSERT INTO platform_modules VALUES ('restaurant','restaurant-core',true,'VERTICAL_CORE');
      INSERT INTO platform_package_modules VALUES ('food','restaurant',true);
      CREATE TEMP TABLE restaurant_staff_profiles(id text, "organizationId" text, "userId" text);
      CREATE TEMP TABLE restaurant_operator_credentials(id text, "organizationId" text, "staffProfileId" text, type text,
        "deviceId" text, "revokedAt" timestamp, "createdAt" timestamp default '2026-01-01', "updatedAt" timestamp default '2026-01-02', "credentialHash" text default 'unchanged');
      CREATE TEMP TABLE audit_logs("organizationId" text, source text default 'TRPC', outcome text default 'SUCCESS', "actorType" text default 'USER',
        action text, "actorId" text, "targetType" text, "targetId" text, metadata jsonb, "createdAt" timestamp default '2026-01-03');
      CREATE TEMP TABLE notifications(id text, "organizationId" text, "userId" text, type text, title text, message text);
  `);
}

it.runIf(url)('flags unknown or third-party setters and tells each member once', async () => {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    expect(
      (await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'))
        .rows
    ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await createHistoricalSchema(db);
    await db.query(`
      INSERT INTO organizations (id,"packageId") VALUES ('a','food'),('b','food');
      INSERT INTO restaurant_staff_profiles VALUES ('p','a','member'),('q','b','other'),('n','a',NULL),('s','a','self');
      INSERT INTO restaurant_operator_credentials (id,"organizationId","staffProfileId",type,"deviceId","revokedAt") VALUES
        ('delegated','a','p','PIN',NULL,NULL),('unknown','a','p','PIN',NULL,NULL),
        ('other-tenant','b','q','PIN',NULL,NULL),('mine','a','s','PIN',NULL,NULL),
        ('terminal','a','n','PIN',NULL,NULL),('device','a','p','PIN','register',NULL),('revoked','a','p','PIN',NULL,now());
      INSERT INTO audit_logs ("organizationId",action,"actorId","targetType","targetId") VALUES
        ('a','restaurantStaff.rotateCredential','manager','RestaurantOperatorCredential','delegated'),
        ('a','restaurantStaff.issueCredential','self','RestaurantOperatorCredential','mine'),
        ('a','restaurantStaff.rotateCredential','other','RestaurantOperatorCredential','other-tenant');
    `);
    await db.query(migration);
    const rows = (
      await db.query(
        'SELECT id,"approvalPinMustChange","credentialHash" FROM restaurant_operator_credentials ORDER BY id'
      )
    ).rows;
    expect(rows.map((row) => [row.id, row.approvalPinMustChange])).toEqual([
      ['delegated', true],
      ['device', false],
      ['mine', false],
      ['other-tenant', true],
      ['revoked', false],
      ['terminal', false],
      ['unknown', true],
    ]);
    expect(rows.every((row) => row.credentialHash === 'unchanged')).toBe(true);
    expect(
      (
        await db.query(
          'SELECT "organizationId","userId",type,message FROM notifications ORDER BY "organizationId"'
        )
      ).rows
    ).toEqual(
      [
        ['a', 'member'],
        ['b', 'other'],
      ].map(([organizationId, userId]) => ({
        organizationId,
        userId,
        type: 'approval_pin_must_change',
        message: expect.stringContaining('Settings, Your PIN'),
      }))
    );
    // A member has since set a new PIN. Replaying the migration cannot reflag it.
    await db.query(
      `UPDATE restaurant_operator_credentials SET "approvalPinMustChange" = false WHERE id = 'delegated'`
    );
    await db.query(migration);
    expect(
      (
        await db.query(
          `SELECT "approvalPinMustChange" FROM restaurant_operator_credentials WHERE id = 'delegated'`
        )
      ).rows
    ).toEqual([{ approvalPinMustChange: false }]);
    expect((await db.query('SELECT count(*)::int AS count FROM notifications')).rows).toEqual([
      { count: 2 },
    ]);
  } finally {
    await db.end();
  }
});

it.runIf(url)(
  'uses the latest set event for the exact PIN and falls back to effective restaurant modules only for missing history',
  async () => {
    const db = new Client({ connectionString: url });
    await db.connect();
    try {
      await createHistoricalSchema(db);
      await db.query(`
      INSERT INTO organizations VALUES
        ('mixed','food',false), ('pharmacy',NULL,false), ('demo','food',true),
        ('contract',NULL,false), ('disabled','food',false), ('trial',NULL,false);
      INSERT INTO platform_contracts VALUES ('live','contract','ACTIVE',now()-interval '1 year',now()+interval '1 year',NULL);
      INSERT INTO platform_contract_modules VALUES ('live','restaurant');
      INSERT INTO organization_modules (id,"organizationId","moduleId",status) VALUES
        ('disabled-link','disabled','restaurant','DISABLED'),('trial-link','trial','restaurant','TRIAL');

      CREATE TEMP TABLE expected(id text, tenant text, marked boolean);
      INSERT INTO expected VALUES
        ('self-last','mixed',false), ('manager-last','mixed',true), ('support-last','pharmacy',true),
        ('no-restaurant','pharmacy',false), ('restaurant-unknown','mixed',true), ('demo-skip','demo',false),
        ('purchase-first','mixed',false), ('replacement','mixed',true), ('alias','mixed',false),
        ('late-provision','mixed',true), ('prior-issue','mixed',true),
        ('contract-unknown','contract',true), ('disabled-unknown','disabled',false), ('trial-unknown','trial',true);
      INSERT INTO restaurant_staff_profiles SELECT id,tenant,'member-'||id FROM expected;
      INSERT INTO restaurant_operator_credentials (id,"organizationId","staffProfileId",type)
        SELECT id,tenant,id,'PIN' FROM expected;
      UPDATE restaurant_operator_credentials SET "createdAt"='2026-01-02 23:59:59' WHERE id='purchase-first';
      -- Two active profiles now link to the same person. The older PIN was manager-issued.
      INSERT INTO restaurant_staff_profiles VALUES
        ('relinked','mixed','member-relinked'), ('own-profile','mixed','member-relinked');
      INSERT INTO restaurant_operator_credentials (id,"organizationId","staffProfileId",type,"createdAt") VALUES
        ('relinked-old','mixed','relinked','PIN','2025-09-01'),
        ('relinked-own','mixed','own-profile','PIN','2025-10-02');
      INSERT INTO expected VALUES ('relinked-old','mixed',true), ('relinked-own','mixed',true);
      INSERT INTO restaurant_operator_credentials (id,"organizationId","staffProfileId",type,"createdAt","revokedAt")
        VALUES ('old-purchase','mixed','replacement','PIN','2025-10-01','2025-12-01');

      INSERT INTO audit_logs ("organizationId",action,"actorId","targetType","targetId",metadata,"createdAt") VALUES
        ('mixed','restaurantStaff.issueCredential','manager','RestaurantOperatorCredential','self-last',NULL,'2026-01-02'),
        ('mixed','pharmacyPin.setMine','member-self-last','User','member-self-last','{"credentialId":"self-last","staffProfileId":"self-last"}','2026-01-03'),
        ('mixed','pharmacyPin.setMine','member-manager-last','User','member-manager-last','{"credentialId":"manager-last","staffProfileId":"manager-last"}','2026-01-02'),
        ('mixed','restaurantStaff.rotateCredential','manager','RestaurantOperatorCredential','manager-last',NULL,'2026-01-03'),
        ('pharmacy','restaurantStaff.rotateCredential','member-support-last','RestaurantOperatorCredential','support-last','{"supportSessionId":"fixture"}','2026-01-03'),
        ('demo','restaurantStaff.rotateCredential','manager','RestaurantOperatorCredential','demo-skip',NULL,'2026-01-03'),
        ('mixed','pharmacyPurchasing.provisionMyPurchasePin','member-purchase-first',NULL,NULL,NULL,'2026-01-03'),
        ('mixed','pharmacyPurchasing.provisionMyPurchasePin','member-replacement',NULL,NULL,NULL,'2025-10-02'),
        ('mixed','restaurantStaff.issueCredential','manager','RestaurantOperatorCredential','relinked-old',NULL,'2025-09-01'),
        ('mixed','pharmacyPurchasing.provisionMyPurchasePin','member-relinked',NULL,NULL,NULL,'2025-10-02 00:00:01'),
        ('mixed','pharmacyPurchasing.provisionMyPurchasePin','member-late-provision',NULL,NULL,NULL,'2026-01-01 00:05:01'),
        ('mixed','restaurantStaff.issueCredential','manager','RestaurantOperatorCredential','prior-issue',NULL,'2026-01-01'),
        ('mixed','pharmacyPurchasing.provisionMyPurchasePin','member-prior-issue',NULL,NULL,NULL,'2026-01-01 00:00:01'),
        ('mixed','accountPin.setMine','member-alias','User','member-alias','{"credentialId":"alias","staffProfileId":"alias"}','2026-01-03');

    `);
      const pin = '586291';
      const credentialHash = await hashOperatorCredential('PIN', pin);
      await db.query(
        `UPDATE restaurant_operator_credentials SET "credentialHash"=$1 WHERE id='self-last'`,
        [credentialHash]
      );

      // The historical fixture uses the tenant's PIN approval mode. Capture the real
      // verifier's audit payload, then persist it alongside its successful-use bookkeeping.
      const createAudit = vi.fn();
      const approvalDb = {
        organization: { findFirst: async () => ({ requireApprovalAuthenticator: false }) },
        auditLog: { create: createAudit },
      } as unknown as ScopedDb;
      for (const now of [new Date('2026-02-01'), new Date('2026-03-01')]) {
        const method = await verifyApprovalSecret(approvalDb, {
          organizationId: 'mixed',
          approverUserId: 'member-self-last',
          approverRight: 'OWNER',
          secret: pin,
          credentialHash,
          action: 'pharmacy.ownerDataExport',
          approvalPinMustChange: false,
          deviceBound: false,
          now,
        });
        expect(method).toBe('PIN');
        const { data } = createAudit.mock.lastCall![0];
        expect(data.description).toBe('Approved with a PIN');
        await db.query(
          `INSERT INTO audit_logs ("organizationId",source,outcome,action,"actorId","targetType","targetId",metadata,"createdAt")
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            data.organizationId,
            data.source,
            data.outcome,
            data.action,
            data.actorId,
            data.targetType,
            data.targetId,
            data.metadata,
            now,
          ]
        );
        await db.query(
          `UPDATE restaurant_operator_credentials SET "updatedAt"=$1 WHERE id='self-last'`,
          [now]
        );
      }
      expect(createAudit).toHaveBeenCalledTimes(2);
      await db.query(migration);
      expect(
        (
          await db.query(
            `
      SELECT e.id FROM expected e LEFT JOIN restaurant_operator_credentials c ON c.id = e.id
      WHERE c."approvalPinMustChange" IS DISTINCT FROM e.marked OR c."credentialHash" IS DISTINCT FROM
        CASE WHEN e.id='self-last' THEN $1 ELSE 'unchanged' END
    `,
            [credentialHash]
          )
        ).rows
      ).toEqual([]);
      expect(
        (await db.query(`SELECT "userId" FROM notifications ORDER BY "userId"`)).rows.map(
          (row) => row.userId
        )
      ).toEqual([
        'member-contract-unknown',
        'member-late-provision',
        'member-manager-last',
        'member-prior-issue',
        'member-relinked',
        'member-replacement',
        'member-restaurant-unknown',
        'member-support-last',
        'member-trial-unknown',
      ]);
    } finally {
      await db.end();
    }
  }
);

it.runIf(url)(
  'backfills manager-set and member-set PINs on real tenant tables and rolls back',
  async () => {
    const body = /^BEGIN;\s*([\s\S]+)\s+COMMIT;\s*$/.exec(migration)?.[1];
    if (!body) throw new Error('Expected one transaction around the migration.');
    const db = new Client({ connectionString: url });
    const prefix = 'shared_pin_' + randomUUID();
    const tenants = [prefix + '_delegated', prefix + '_self'];
    await db.connect();
    try {
      await db.query('BEGIN');
      try {
        const {
          rows: [role],
        } = await db.query(
          'SELECT current_database() AS database, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
        );
        expect(role.database).toMatch(/(^|[_-])(test|e2e|tmp|disposable)([_-]|$)/);
        expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
        await db.query("SET LOCAL lock_timeout = '5s'");
        await db.query("SET LOCAL app.is_platform_admin = 'true'");
        // Keep the installed column and its data. Its original name must be absent
        // for the unmodified migration body to exercise its first-deployment path.
        await db.query(
          'ALTER TABLE public.restaurant_operator_credentials RENAME COLUMN "approvalPinMustChange" TO dev934_saved_marker'
        );
        for (const tenant of tenants) {
          await db.query("SELECT set_config('app.current_organization_id', $1, true)", [tenant]);
          await db.query(
            `INSERT INTO organizations (id,slug,"legalName","displayName","updatedAt")
          VALUES ($1,$1,$1,$1,now())`,
            [tenant]
          );
          await db.query(
            `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt")
          VALUES ($1,$2,'OPERATIONS','Operations',now())`,
            [tenant + '_department', tenant]
          );
          const member = tenant + '_member';
          const manager = tenant + '_manager';
          for (const id of [member, manager]) {
            await db.query(
              `INSERT INTO users (id,name,email,department,title,"updatedAt")
            VALUES ($1,$1,$2,'OPERATIONS','Staff',now())`,
              [id, id + '@test.invalid']
            );
          }
          await db.query(
            `INSERT INTO restaurant_staff_profiles (id,"userId","displayName","updatedAt")
          VALUES ($1,$2,'Synthetic member',now())`,
            [tenant + '_profile', member]
          );
          await db.query(
            `INSERT INTO restaurant_operator_credentials (id,"staffProfileId",type,"credentialHash","updatedAt")
          VALUES ($1,$2,'PIN','unused-fixture-hash',now())`,
            [tenant + '_pin', tenant + '_profile']
          );
          await db.query(
            `INSERT INTO audit_logs (id,"actorId",source,category,operation,action,"targetType","targetId")
          VALUES ($1,$2,'TRPC','STAFF','CREATE','restaurantStaff.issueCredential','RestaurantOperatorCredential',$3)`,
            [tenant + '_issue', tenant === tenants[0] ? manager : member, tenant + '_pin']
          );
        }
        await db.query(body);
        await db.query("SET LOCAL app.is_platform_admin = 'false'");
        for (const tenant of tenants) {
          await db.query("SELECT set_config('app.current_organization_id', $1, true)", [tenant]);
          const flagged = tenant === tenants[0];
          expect(
            (
              await db.query(
                `SELECT "approvalPinMustChange","credentialHash" FROM restaurant_operator_credentials
          WHERE "organizationId"=$1 AND id=$2`,
                [tenant, tenant + '_pin']
              )
            ).rows
          ).toEqual([{ approvalPinMustChange: flagged, credentialHash: 'unused-fixture-hash' }]);
          expect(
            (
              await db.query(
                `SELECT "userId" FROM notifications WHERE "organizationId"=$1 AND type='approval_pin_must_change'`,
                [tenant]
              )
            ).rows
          ).toEqual(flagged ? [{ userId: tenant + '_member' }] : []);
        }
      } finally {
        await db.query('ROLLBACK');
      }
      await db.query("SET app.is_platform_admin = 'true'");
      expect(
        (await db.query('SELECT id FROM organizations WHERE id=ANY($1::text[])', [tenants])).rows
      ).toEqual([]);
      expect(
        (
          await db.query(`SELECT attname FROM pg_attribute WHERE attrelid='public.restaurant_operator_credentials'::regclass
      AND NOT attisdropped AND attname IN ('approvalPinMustChange','dev934_saved_marker')`)
        ).rows
      ).toEqual([{ attname: 'approvalPinMustChange' }]);
    } finally {
      await db.end();
    }
  }
);
