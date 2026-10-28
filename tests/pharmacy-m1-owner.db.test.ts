// @vitest-environment node
import { randomUUID } from 'node:crypto';
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
        for (const capability of [
          'pharmacy:dispense',
          'pharmacy:safety',
          'pharmacy:catalogue-review',
        ])
          await db.query(
            `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,$4,'ALLOW')`,
            [org + capability, org, role, capability]
          );
        const permissions = (
          await db.query(
            `SELECT capability,effect FROM organization_role_permissions WHERE "organizationRoleId"=$1`,
            [role]
          )
        ).rows;
        const authDb = {
          user: {
            findUnique: async () => ({
              organizationId: org,
              status: 'ACTIVE',
              role: 'EMPLOYEE',
              organization: { vertical: 'PHARMACY' },
              organizationRole: { organizationId: org, isSystem: true, key: 'owner', permissions },
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

it('migrates real bootstrap admin identities, preserves DENYs and manual assignment provenance, and safely repeats the owner migration', async () => {
  expect(url).toBeTruthy();
  const { readFile } = await import('node:fs/promises');
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  const org = `bootstrap_${randomUUID().replaceAll('-', '')}`;
  const adminRole = `${org}_admin`,
    user = `${org}_user`,
    branch = `${org}_branch`;
  const migration = async (name: string) =>
    (await readFile(`prisma/migrations/${name}/migration.sql`, 'utf8'))
      .replace(/^BEGIN;\s*/m, '')
      .replace(/^COMMIT;\s*/m, '');
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.is_platform_admin','true',true)");
    await db.query(
      `INSERT INTO organizations (id,slug,"legalName","displayName",vertical,"updatedAt") VALUES ($1,$1,$1,$1,'PHARMACY',now())`,
      [org]
    );
    await db.query(
      `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'PHARMACY','Pharmacy',now())`,
      [`${org}_department`, org]
    );
    await db.query(
      `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,'admin','Bootstrap administrator',true,now())`,
      [adminRole, org]
    );
    await db.query(
      `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'*','ALLOW'),($4,$2,$3,'pharmacy:safety','DENY')`,
      [`${org}_allow`, org, adminRole, `${org}_deny`]
    );
    await db.query(
      `INSERT INTO users (id,"organizationId","organizationRoleId",name,email,role,department,title,"updatedAt") VALUES ($1,$2,$3,$1,$1,'ADMIN','PHARMACY','Organization administrator',now())`,
      [user, org, adminRole]
    );
    await db.query(
      `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","updatedAt") VALUES ($1,$2,'MAIN','Main','Road','Lahore','PK-PB',now())`,
      [branch, org]
    );
    await db.query(
      `INSERT INTO pharmacy_branch_assignments (id,"organizationId","branchId","userId",active,"ownerManaged","updatedAt") VALUES ($1,$2,$3,$4,true,false,now())`,
      [`${org}_manual`, org, branch, user]
    );
    await db.query(await migration('20261029106000_pharmacy_bootstrap_and_pv_guard'));
    expect(
      (
        await db.query(
          `SELECT r.key,r."isSystem" FROM users u JOIN organization_roles r ON r.id=u."organizationRoleId" WHERE u.id=$1`,
          [user]
        )
      ).rows
    ).toEqual([{ key: 'owner', isSystem: true }]);
    expect(
      (
        await db.query('SELECT pharmacy_solo_owner_eligible($1,$2,$3) AS eligible', [
          org,
          branch,
          user,
        ])
      ).rows[0].eligible
    ).toBe(true);
    expect(
      (
        await db.query(
          `SELECT effect,"expiresAt" FROM user_permission_overrides WHERE "userId"=$1 AND capability='pharmacy:safety'`,
          [user]
        )
      ).rows
    ).toEqual([{ effect: 'DENY', expiresAt: null }]);
    await db.query(await migration('20261029104000_pharmacy_owner_branch_assignments'));
    await db.query(await migration('20261029104000_pharmacy_owner_branch_assignments'));
    await db.query(`UPDATE users SET "organizationRoleId"=NULL WHERE id=$1`, [user]);
    expect(
      (
        await db.query(
          `SELECT active,"ownerManaged" FROM pharmacy_branch_assignments WHERE id=$1`,
          [`${org}_manual`]
        )
      ).rows
    ).toEqual([{ active: true, ownerManaged: false }]);
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
});
