// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { can } from '@/lib/abac';
import type { AuthzDb } from '@/lib/authz';
import { PHARMACY_CHECKED_CAPABILITIES } from '@/lib/vertical-catalog';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

const url = process.env.DATABASE_URL;
(url ? describe : describe.skip)(
  'M1 owner grants and automatic branch assignments on Postgres',
  () => {
    it('backfills existing owners and assigns newly created branches and owners without cross-tenant grants', async () => {
      assertDisposableRlsDatabase(url!);
      const db = new pg.Client({ connectionString: url });
      await db.connect();
      const org = `m1_${randomUUID().replaceAll('-', '')}`;
      const role = `${org}_owner`;
      const user = `${org}_user`;
      const branch = `${org}_branch`;
      try {
        await db.query('BEGIN');
        await db.query("SELECT set_config('app.is_platform_admin','true',true)");
        await db.query(
          `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode",vertical,"createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED','PHARMACY',now(),now())`,
          [org]
        );
        await db.query(
          `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'Pharmacy','Pharmacy',now())`,
          [`${org}_dept`, org]
        );
        await db.query(
          `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,'owner','Owner',true,now())`,
          [role, org]
        );
        await db.query(
          `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'pharmacy:*','ALLOW'),($4,$2,$3,'reports:operational','ALLOW'),($5,$2,$3,'reports:financial','ALLOW')`,
          [`${org}_grant`, org, role, `${org}_report`, `${org}_finance`]
        );
        await db.query(
          `INSERT INTO users (id,"organizationId","organizationRoleId",name,email,department,title,"updatedAt") VALUES ($1,$2,$3,$1,$1,'Pharmacy','Owner',now())`,
          [user, org, role]
        );
        const addBranch = async (id: string) =>
          db.query(
            `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","updatedAt") VALUES ($1,$2,$1,$1,'Road','Lahore','PB',now())`,
            [id, org]
          );
        await addBranch(branch);
        await db.query(
          readFileSync(
            'prisma/migrations/20261028100000_pharmacy_catalogue_owner_authorization/migration.sql',
            'utf8'
          )
        );
        const assignments = async () =>
          (
            await db.query(
              `SELECT "branchId" FROM pharmacy_branch_assignments WHERE "organizationId"=$1 AND "userId"=$2 AND active=true ORDER BY "branchId"`,
              [org, user]
            )
          ).rows.map((r) => r.branchId);
        expect(await assignments()).toEqual([branch]);
        await db.query(
          "SELECT set_config('app.is_platform_admin','false',true), set_config('app.current_organization_id',$1,true)",
          [org]
        );
        await addBranch(`${branch}_new`);
        expect(await assignments()).toEqual([branch, `${branch}_new`]);
        await db.query(`UPDATE users SET "organizationRoleId"=NULL WHERE id=$1`, [user]);
        await db.query(`DELETE FROM pharmacy_branch_assignments WHERE "userId"=$1`, [user]);
        await db.query(`UPDATE users SET "organizationRoleId"=$2 WHERE id=$1`, [user, role]);
        expect(await assignments()).toEqual([branch, `${branch}_new`]);
        // Exercise the database witness guard itself, independent of ledger fixtures.
        await db.query(
          `CREATE TEMP TABLE m1_witness_probe ("organizationId" text, "branchId" text, "recordedByUserId" text, "witnessedByUserId" text) ON COMMIT DROP`
        );
        await db.query(
          `CREATE TRIGGER m1_witness_guard BEFORE INSERT ON m1_witness_probe FOR EACH ROW EXECUTE FUNCTION pharmacy_check_solo_register_witness()`
        );
        const insertWitness = () =>
          db.query(`INSERT INTO m1_witness_probe VALUES ($1,$2,$3,$3)`, [org, branch, user]);
        await db.query('SAVEPOINT no_pin');
        await expect(insertWitness()).rejects.toMatchObject({ code: '23514' });
        await db.query('ROLLBACK TO SAVEPOINT no_pin');
        await db.query(
          `INSERT INTO audit_logs (id,"organizationId","actorId",source,category,action,metadata) VALUES ($1,$2,$3,'TRPC','PHARMACY','pharmacy.soloOwnerSelfApproval',$4::jsonb)`,
          [
            `${org}_audit`,
            org,
            user,
            JSON.stringify({
              branchId: branch,
              credentialId: 'verified-pin',
              purpose: 'controlled-restoration',
            }),
          ]
        );
        await insertWitness();
        await db.query(
          `INSERT INTO users (id,"organizationId",name,email,department,title,"updatedAt") VALUES ($1,$2,$1,$1,'Pharmacy','Cashier',now())`,
          [`${user}_second`, org]
        );
        await db.query('SAVEPOINT multi_staff');
        await expect(insertWitness()).rejects.toMatchObject({ code: '23514' });
        await db.query('ROLLBACK TO SAVEPOINT multi_staff');
        const permissions = (
          await db.query(
            `SELECT capability,effect FROM organization_role_permissions WHERE "organizationRoleId"=$1`,
            [role]
          )
        ).rows;
        const authDb = {
          user: {
            findUnique: async () => ({
              organizationRole: { permissions },
              permissionOverrides: [],
            }),
          },
        } as unknown as AuthzDb;
        for (const action of PHARMACY_CHECKED_CAPABILITIES) {
          expect(
            await can(
              { id: user, role: 'ADMIN', status: 'ACTIVE', department: 'Pharmacy' },
              action,
              undefined,
              { db: authDb }
            )
          ).toBe(true);
        }
        expect(
          (
            await db.query(
              `SELECT count(*)::int AS n FROM pharmacy_branch_assignments WHERE "userId"=$1 AND "organizationId"<>$2`,
              [user, org]
            )
          ).rows[0].n
        ).toBe(0);
      } finally {
        await db.query('ROLLBACK');
        await db.end();
      }
    });
  }
);
