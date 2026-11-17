/**
 * DEV-748: the pharmacy_loyalty_cards table's own rules, run against PostgreSQL under a restricted
 * runtime role: tenant isolation, a hash-only code column, one working card per customer, and a
 * guard trigger that never lets a card be deleted, moved or brought back after revocation.
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
const role = `pharmacy_runtime_${suffix}`;
const orgA = `loyalty_card_org_a_${suffix}`;
const orgB = `loyalty_card_org_b_${suffix}`;
const customerA = `loyalty_card_customer_a_${suffix}`;
const customerB = `loyalty_card_customer_b_${suffix}`;
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

const insertCard = (id: string, codeHash: string, customerId = customerA) =>
  client.query(
    `INSERT INTO pharmacy_loyalty_cards (id,"customerId","codeHash","issuedById","updatedAt")
     VALUES ($1,$2,$3,'owner',now())`,
    [id, customerId, codeHash]
  );

describeIfDatabase('pharmacy loyalty cards PostgreSQL RLS and guards (DEV-748)', () => {
  beforeAll(async () => {
    assertDisposableRlsDatabase(url);
    await client.connect();
    await client.query('BEGIN');
    await client.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT "${role}" TO CURRENT_USER`);
    await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await client.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON pharmacy_loyalty_cards,pharmacy_customers TO "${role}"`
    );
    await client.query(`SELECT set_config('app.is_platform_admin','true',true)`);
    await client.query(
      `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',now(),now()),($2,$2,$2,$2,'ACTIVE','SHARED',now(),now())`,
      [orgA, orgB]
    );
    for (const [org, customer] of [
      [orgA, customerA],
      [orgB, customerB],
    ] as const) {
      await client.query(
        `INSERT INTO pharmacy_patients (id,"organizationId","displayName","createdAt","updatedAt") VALUES ($1,$2,'Card holder',now(),now())`,
        [`patient_${customer}`, org]
      );
      await client.query(
        `INSERT INTO pharmacy_customers (id,"organizationId","patientId","displayName",active,"createdAt","updatedAt") VALUES ($1,$2,$3,'Card holder',true,now(),now())`,
        [customer, org, `patient_${customer}`]
      );
    }
    await client.query(
      `INSERT INTO pharmacy_loyalty_cards (id,"organizationId","customerId","codeHash","issuedById","updatedAt") VALUES ($1,$2,$3,$4,'owner',now())`,
      [`card_b_${suffix}`, orgB, customerB, hash(1)]
    );
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

  it('hides another organization’s cards and refuses writing into it', async () => {
    // The same hash in another organization is a different card: it neither resolves nor clashes.
    await insertCard(`card_a_${suffix}`, hash(1));
    const visible = await client.query(
      `SELECT id FROM pharmacy_loyalty_cards WHERE "codeHash" = $1`,
      [hash(1)]
    );
    expect(visible.rows.map((row) => row.id)).toEqual([`card_a_${suffix}`]);
    await expectPgCode('42501', () =>
      client.query(
        `INSERT INTO pharmacy_loyalty_cards (id,"organizationId","customerId","codeHash","issuedById","updatedAt") VALUES ('substitution',$1,$2,$3,'owner',now())`,
        [orgB, customerB, hash(2)]
      )
    );
    // A customer of another organization cannot be given a card here.
    await expectPgCode('23503', () => insertCard('foreign_customer', hash(3), customerB));
  });

  it('stores only a hex hash and keeps one working card per customer', async () => {
    await expectPgCode('23514', () => insertCard('plaintext', 'DFLCABCDEFGHIJKLMNOPQRSTUVWXYZ'));
    await expectPgCode('23505', () => insertCard('second_active', hash(4)));
    await expectPgCode('23505', () => insertCard('same_hash', hash(1)));
  });

  it('revokes once, never deletes, moves or revives a card, and allows a replacement', async () => {
    const card = `card_a_${suffix}`;
    await expectPgCode('23514', () =>
      client.query(`UPDATE pharmacy_loyalty_cards SET "revokedAt"=now() WHERE id=$1`, [card])
    );
    await client.query(
      `UPDATE pharmacy_loyalty_cards SET "revokedAt"=now(),"revokedById"='owner',"revokedReason"='Card lost' WHERE id=$1`,
      [card]
    );
    await insertCard(`card_a2_${suffix}`, hash(5));
    await expectPgCode('55000', () =>
      client.query(
        `UPDATE pharmacy_loyalty_cards SET "revokedAt"=NULL,"revokedById"=NULL,"revokedReason"=NULL WHERE id=$1`,
        [card]
      )
    );
    await expectPgCode('55000', () =>
      client.query(`UPDATE pharmacy_loyalty_cards SET "codeHash"=$2 WHERE id=$1`, [
        `card_a2_${suffix}`,
        hash(6),
      ])
    );
    await expectPgCode('55000', () =>
      client.query(`DELETE FROM pharmacy_loyalty_cards WHERE id=$1`, [`card_a2_${suffix}`])
    );
    const working = await client.query(
      `SELECT id FROM pharmacy_loyalty_cards WHERE "customerId"=$1 AND "revokedAt" IS NULL`,
      [customerA]
    );
    expect(working.rows.map((row) => row.id)).toEqual([`card_a2_${suffix}`]);
  });
});
