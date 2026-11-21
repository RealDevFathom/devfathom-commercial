/**
 * DEV-961: authenticator by default, against PostgreSQL under a restricted runtime role.
 *  - a new organization requires an approval authenticator unless created otherwise;
 *  - approval_authenticator_recovery_codes is tenant isolated, stores only a hex hash, holds one
 *    row per (member, code), and its rows go with the member.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertDisposableRlsDatabase } from './disposable-rls-database';

const url = process.env.PHARMACY_TEST_OWNER_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? '';
// Skipped, never silently passed, without a disposable database.
const describeIfDatabase = url ? describe : describe.skip;
const client = new pg.Client({ connectionString: url });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const role = `approval_runtime_${suffix}`;
const orgA = `approval_rc_org_a_${suffix}`;
const orgB = `approval_rc_org_b_${suffix}`;
const userA = `approval_rc_user_a_${suffix}`;
const userB = `approval_rc_user_b_${suffix}`;
const hash = (n: number) => n.toString(16).padStart(64, '0');

async function expectPgCode(code: string, operation: () => Promise<unknown>) {
  await client.query('SAVEPOINT expected_failure');
  try {
    await operation();
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT expected_failure');
    await client.query('RELEASE SAVEPOINT expected_failure');
    expect(error).toMatchObject({ code });
    return;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_failure');
  await client.query('RELEASE SAVEPOINT expected_failure');
  throw new Error(`Expected PostgreSQL error ${code}`);
}

const insertCode = (id: string, codeHash: string, userId = userA) =>
  client.query(
    `INSERT INTO approval_authenticator_recovery_codes (id,"userId","codeHash") VALUES ($1,$2,$3)`,
    [id, userId, codeHash]
  );

describeIfDatabase(
  'approval authenticator default and recovery codes in PostgreSQL (DEV-961)',
  () => {
    beforeAll(async () => {
      assertDisposableRlsDatabase(url);
      await client.connect();
      await client.query('BEGIN');
      await client.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS`);
      await client.query(`GRANT "${role}" TO CURRENT_USER`);
      await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await client.query(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON approval_authenticator_recovery_codes,organizations,users,organization_departments TO "${role}"`
      );
      await client.query(`SELECT set_config('app.is_platform_admin','true',true)`);
      await client.query(
        `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',now(),now()),($2,$2,$2,$2,'ACTIVE','SHARED',now(),now())`,
        [orgA, orgB]
      );
      for (const [org, user] of [
        [orgA, userA],
        [orgB, userB],
      ] as const) {
        await client.query(
          `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'Pharmacy','Pharmacy',now())`,
          [`dept_${user}`, org]
        );
        await client.query(
          `INSERT INTO users (id,"organizationId",email,name,role,title,department,"updatedAt") VALUES ($1,$2,$3,'Approver','EMPLOYEE','Manager','Pharmacy',now())`,
          [user, org, `${user}@example.test`]
        );
      }
      await client.query(`SELECT set_config('app.current_organization_id',$1,true)`, [orgB]);
      await insertCode(`code_b_${suffix}`, hash(1), userB);
      await client.query(`SELECT set_config('app.is_platform_admin','false',true)`);
      await client.query(`SET LOCAL ROLE "${role}"`);
      const runtimeRole = await client.query(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      );
      expect(runtimeRole.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await client.query(`SELECT set_config('app.current_organization_id',$1,true)`, [orgA]);
    });

    afterAll(async () => {
      if (!url) return;
      await client.query('ROLLBACK');
      await client.end();
    });

    it('requires an approval authenticator for a new organization by default', async () => {
      const created = await client.query(
        `SELECT "requireApprovalAuthenticator" AS required FROM organizations WHERE id = $1`,
        [orgA]
      );
      expect(created.rows).toEqual([{ required: true }]);
    });

    it('hides another organization’s recovery codes and refuses writing into it', async () => {
      await insertCode(`code_a_${suffix}`, hash(1));
      const visible = await client.query(
        `SELECT id FROM approval_authenticator_recovery_codes WHERE "codeHash" = $1`,
        [hash(1)]
      );
      expect(visible.rows.map((row) => row.id)).toEqual([`code_a_${suffix}`]);
      await expectPgCode('42501', () =>
        client.query(
          `INSERT INTO approval_authenticator_recovery_codes (id,"organizationId","userId","codeHash") VALUES ('foreign',$1,$2,$3)`,
          [orgB, userB, hash(2)]
        )
      );
      const spent = await client.query(
        `UPDATE approval_authenticator_recovery_codes SET "usedAt" = now() WHERE "userId" = $1`,
        [userB]
      );
      expect(spent.rowCount).toBe(0);
    });

    it('stores only a hex hash, once per member', async () => {
      await expectPgCode('23514', () => insertCode('plaintext', 'aaaaa-11111'));
      await expectPgCode('23505', () => insertCode('duplicate', hash(1)));
    });

    it('removes a member’s codes with the member', async () => {
      await insertCode(`code_a2_${suffix}`, hash(3));
      await client.query(`DELETE FROM users WHERE id = $1`, [userA]);
      const left = await client.query(
        `SELECT count(*)::int AS n FROM approval_authenticator_recovery_codes WHERE "userId" = $1`,
        [userA]
      );
      expect(left.rows).toEqual([{ n: 0 }]);
    });
  }
);
