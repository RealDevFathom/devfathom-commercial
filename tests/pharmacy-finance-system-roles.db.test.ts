import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { expect, it } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL;
const migration = readFileSync(
  'prisma/migrations/20261118127200_pharmacy_finance_system_role_grants/migration.sql',
  'utf8'
);

it.skipIf(!ownerUrl)(
  'backfills only missing finance grants on the two pharmacy system roles and preserves denies on replay',
  async () => {
    assertDisposableRlsDatabase(ownerUrl!);
    const client = new pg.Client({ connectionString: ownerUrl });
    const suffix = randomUUID();
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.is_platform_admin','true',true)");
      const identity = await client.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'
      );
      expect(identity.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      for (const [name, vertical] of [
        ['system', 'PHARMACY'],
        ['custom', 'PHARMACY'],
        ['other', 'RESTAURANT'],
      ]) {
        const org = `${suffix}_${name}`;
        await client.query(
          `INSERT INTO organizations (id,slug,"legalName","displayName",vertical,status,"deploymentMode","createdAt","updatedAt") VALUES ($1,$1,'Fixture','Fixture',$2,'ACTIVE','SHARED',now(),now())`,
          [org, vertical]
        );
        for (const key of ['finance', 'owner-operator', 'manager', 'owner']) {
          await client.query(
            `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,$3,$3,$4,now())`,
            [`${org}_${key}`, org, key, name !== 'custom']
          );
        }
      }
      const org = `${suffix}_system`;
      await client.query(
        `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'finance:manage','DENY')`,
        [`${suffix}_deny`, org, `${org}_finance`]
      );
      // Execute the migration body inside this disposable transaction twice, then roll it all back.
      const body = migration.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
      const read = async () =>
        (
          await client.query(
            `SELECT r.key,p.capability,p.effect,p.id FROM organization_role_permissions p JOIN organization_roles r ON r.id=p."organizationRoleId" WHERE p."organizationId" =ANY($1) ORDER BY r.key,p.capability`,
            [[org, `${suffix}_custom`, `${suffix}_other`]]
          )
        ).rows;
      await client.query(body);
      const first = await read();
      expect(first.map(({ key, capability, effect }) => [key, capability, effect])).toEqual([
        ['finance', 'finance:manage', 'DENY'],
        ['finance', 'finance:read', 'ALLOW'],
        ['owner-operator', 'finance:manage', 'ALLOW'],
        ['owner-operator', 'finance:read', 'ALLOW'],
      ]);
      await client.query(body);
      expect(await read()).toEqual(first);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  }
);
