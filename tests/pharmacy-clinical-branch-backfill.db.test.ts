import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { expect, it } from 'vitest';

const ownerUrl = process.env.PHARMACY_DB_TEST_OWNER_URL;
const runtimeUrl = process.env.PHARMACY_DB_TEST_RUNTIME_URL;
const migration =
  'prisma/migrations/20261126010150_pharmacy_clinical_branch_assignments/migration.sql';

it.skipIf(!ownerUrl || !runtimeUrl)(
  'snapshots only missing clinical admissions once, including legacy administrators',
  async () => {
    const owner = new Client({ connectionString: ownerUrl });
    const runtime = new Client({ connectionString: runtimeUrl });
    const schema = 'clinical_fixture_' + randomBytes(8).toString('hex');
    await owner.connect();
    await runtime.connect();
    try {
      for (const client of [owner, runtime]) {
        expect(
          (
            await client.query(
              'select rolsuper, rolbypassrls from pg_roles where rolname=current_user'
            )
          ).rows
        ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      }
      await owner.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};
      CREATE TABLE organizations (id text PRIMARY KEY, vertical text);
      CREATE TABLE users (id text, "organizationId" text, role text, status text, UNIQUE("organizationId",id));
      CREATE TABLE pharmacy_branches (id text, "organizationId" text, active boolean, UNIQUE("organizationId",id));
      CREATE TABLE pharmacy_branch_assignments ("userId" text, "branchId" text, "organizationId" text, active boolean);
      INSERT INTO organizations VALUES ('tenant','PHARMACY'),('second','PHARMACY'),('other','RESTAURANT');
      INSERT INTO users VALUES ('admin','tenant','ADMIN','ACTIVE'),('absent','tenant','ADMIN','INACTIVE'),
        ('staff','tenant','EMPLOYEE','ACTIVE'),('admin2','second','ADMIN','ACTIVE'),('outside','other','ADMIN','ACTIVE');
      INSERT INTO pharmacy_branches VALUES ('A','tenant',true),('B','tenant',true),('C','tenant',false),('D','second',true),('E','other',true);
      INSERT INTO pharmacy_branch_assignments VALUES ('admin','A','tenant',true), ('admin','B','tenant',false);`);
      const sql = await readFile(migration, 'utf8');
      await owner.query(sql);
      const runtimeRole = (await runtime.query('select quote_ident(current_user) as name')).rows[0]
        .name;
      await owner.query(
        `GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}; GRANT SELECT, UPDATE ON pharmacy_clinical_branch_assignments TO ${runtimeRole}`
      );
      await runtime.query(`SET search_path TO ${schema}`);
      const grants = async (tenant: string) => {
        await runtime.query("select set_config('app.current_organization_id',$1,false)", [tenant]);
        return (
          await runtime.query(
            'SELECT "userId","branchId" FROM pharmacy_clinical_branch_assignments WHERE active ORDER BY "branchId"'
          )
        ).rows;
      };
      expect(await grants('second')).toEqual([{ userId: 'admin2', branchId: 'D' }]);
      expect(await grants('tenant')).toEqual([{ userId: 'admin', branchId: 'B' }]);
      expect(await grants('other')).toEqual([]);
      expect(
        (
          await owner.query(
            'SELECT "branchId", active FROM pharmacy_branch_assignments ORDER BY "branchId"'
          )
        ).rows
      ).toEqual([
        { branchId: 'A', active: true },
        { branchId: 'B', active: false },
      ]);
      await grants('tenant');
      await runtime.query(
        'UPDATE pharmacy_clinical_branch_assignments SET active=false WHERE "branchId"=\'B\''
      );
      await owner.query("INSERT INTO pharmacy_branches VALUES ('new','tenant',true)");
      await owner.query(sql);
      expect(await grants('tenant')).toEqual([]);
      expect(await grants('second')).toEqual([{ userId: 'admin2', branchId: 'D' }]);
      expect(
        (
          await owner.query(
            "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='pharmacy_clinical_branch_assignments'::regclass"
          )
        ).rows
      ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    } finally {
      await owner.query('ROLLBACK');
      await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await Promise.all([owner.end(), runtime.end()]);
    }
  }
);
