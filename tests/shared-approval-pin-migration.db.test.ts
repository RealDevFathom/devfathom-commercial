// @vitest-environment node
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { expect, it } from 'vitest';

const url = process.env.PHARMACY_DB_TEST_OWNER_URL;
const migration = readFileSync(
  'prisma/migrations/20261126010000_shared_approval_pin_provenance/migration.sql',
  'utf8'
);

it.runIf(url)('flags unknown or third-party setters and tells each member once', async () => {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    expect(
      (await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'))
        .rows
    ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    // These session-local tables shadow only the inputs of the real migration.
    await db.query(`
      CREATE TEMP TABLE organizations(id text primary key);
      CREATE TEMP TABLE restaurant_staff_profiles(id text, "organizationId" text, "userId" text);
      CREATE TEMP TABLE restaurant_operator_credentials(id text, "organizationId" text, "staffProfileId" text, type text,
        "deviceId" text, "revokedAt" timestamp, "updatedAt" timestamp default '2026-01-02', "credentialHash" text default 'unchanged');
      CREATE TEMP TABLE audit_logs("organizationId" text, source text default 'TRPC', outcome text default 'SUCCESS', "actorType" text default 'USER',
        action text, "actorId" text, "targetType" text, "targetId" text, metadata jsonb, "createdAt" timestamp default '2026-01-03');
      CREATE TEMP TABLE notifications(id text, "organizationId" text, "userId" text, type text, title text, message text);
      INSERT INTO organizations VALUES ('a'),('b');
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
  } finally {
    await db.end();
  }
});
