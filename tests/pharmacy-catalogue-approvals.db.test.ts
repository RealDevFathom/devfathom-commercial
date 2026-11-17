import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

const url = process.env.PHARMACY_TEST_OWNER_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? '';
const client = new pg.Client({ connectionString: url });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const role = `catalogue_runtime_${suffix}`;
const id = (value: string) => `catalogue_${value}_${suffix}`;
async function refused(code: string, sql: string, values: unknown[] = []) {
  await client.query('SAVEPOINT refusal');
  let failure: unknown;
  try {
    await client.query(sql, values);
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT refusal');
  expect(failure).toMatchObject({ code });
}

(url ? describe : describe.skip)('DEV-766 catalogue queue PostgreSQL boundaries', () => {
  beforeAll(async () => {
    assertDisposableRlsDatabase(url);
    await client.connect();
    await client.query('BEGIN');
    await client.query(`CREATE ROLE "${role}" NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT "${role}" TO CURRENT_USER`);
    await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await client.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON pharmacy_catalogue_edits TO "${role}"`
    );
    await client.query(`SELECT set_config('app.is_platform_admin','true',true)`);
    for (const key of ['a', 'b']) {
      await client.query(
        `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',now(),now())`,
        [id(key)]
      );
      await client.query(
        `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'Pharmacy','Pharmacy',now())`,
        [id(`department_${key}`), id(key)]
      );
      for (const person of ['editor', 'reviewer']) {
        await client.query(
          `INSERT INTO users (id,"organizationId",name,email,department,title,"updatedAt") VALUES ($1,$2,$1,$1,'Pharmacy','Staff',now())`,
          [id(`${person}_${key}`), id(key)]
        );
      }
      await client.query(
        `INSERT INTO pharmacy_medicines (id,"organizationId","productName","productFamily","updatedAt") VALUES ($1,$2,'Fixture soap','FRONT_SHOP',now())`,
        [id(`medicine_${key}`), id(key)]
      );
    }
    await client.query(
      `SELECT set_config('app.is_platform_admin','false',true), set_config('app.current_organization_id',$1,true)`,
      [id('a')]
    );
    await client.query(`SET LOCAL ROLE "${role}"`);
    expect(
      (await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'))
        .rows
    ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await client.query(
      `INSERT INTO pharmacy_catalogue_edits (id,"medicineId","editorId",changes,"expectedUpdatedAt") VALUES ($1,$2,$3,'{"productName":"Reviewed soap"}',now())`,
      [id('edit'), id('medicine_a'), id('editor_a')]
    );
  });
  afterAll(async () => {
    await client.query('ROLLBACK');
    await client.end();
  });
  it('forces RLS and hides the other tenant queue', async () => {
    expect(
      (
        await client.query(
          `SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='pharmacy_catalogue_edits'::regclass`
        )
      ).rows
    ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    await client.query(`SELECT set_config('app.current_organization_id',$1,true)`, [id('b')]);
    expect((await client.query('SELECT id FROM pharmacy_catalogue_edits')).rows).toEqual([]);
    expect(
      (
        await client.query(
          `UPDATE pharmacy_catalogue_edits SET status='REJECTED',"reviewerId"=$1,"reviewedAt"=now() WHERE id=$2`,
          [id('reviewer_b'), id('edit')]
        )
      ).rowCount
    ).toBe(0);
    await client.query(`SELECT set_config('app.current_organization_id',$1,true)`, [id('a')]);
  });
  it('rejects tenant substitution, foreign medicine and foreign reviewer references', async () => {
    await refused(
      '42501',
      `INSERT INTO pharmacy_catalogue_edits (id,"organizationId","medicineId","editorId",changes,"expectedUpdatedAt") VALUES ($1,$2,$3,$4,'{}',now())`,
      [id('bad_org'), id('b'), id('medicine_b'), id('editor_b')]
    );
    await refused(
      '23503',
      `INSERT INTO pharmacy_catalogue_edits (id,"medicineId","editorId",changes,"expectedUpdatedAt") VALUES ($1,$2,$3,'{}',now())`,
      [id('bad_med'), id('medicine_b'), id('editor_a')]
    );
    await refused(
      '23503',
      `UPDATE pharmacy_catalogue_edits SET status='APPROVED',"reviewerId"=$1,"reviewedAt"=now() WHERE id=$2`,
      [id('reviewer_b'), id('edit')]
    );
  });
  it('retains proposals and refuses editing their payload or self approving without verified evidence', async () => {
    await refused('23514', `INSERT INTO pharmacy_catalogue_edits (id,"medicineId","editorId",changes,"expectedUpdatedAt",status,"reviewerId","reviewedAt") VALUES ($1,$2,$3,'{}',now(),'APPROVED',$4,now())`, [id('preapproved'),id('medicine_a'),id('editor_a'),id('reviewer_a')]);
    await refused('23514', `DELETE FROM pharmacy_catalogue_edits WHERE id=$1`, [id('edit')]);
    await refused('23514', `UPDATE pharmacy_catalogue_edits SET changes='{}' WHERE id=$1`, [
      id('edit'),
    ]);
    await refused(
      '23514',
      `UPDATE pharmacy_catalogue_edits SET status='APPROVED',"reviewerId"="editorId","reviewedAt"=now(),"soloPinVerifiedAt"=now() WHERE id=$1`,
      [id('edit')]
    );
  });
  it('allows a separate reviewer exactly once', async () => {
    await client.query(
      `UPDATE pharmacy_catalogue_edits SET status='APPROVED',"reviewerId"=$1,"reviewedAt"=now() WHERE id=$2`,
      [id('reviewer_a'), id('edit')]
    );
    expect(
      (await client.query(`SELECT status FROM pharmacy_catalogue_edits WHERE id=$1`, [id('edit')]))
        .rows
    ).toEqual([{ status: 'APPROVED' }]);
    await refused('23514', `UPDATE pharmacy_catalogue_edits SET status='REJECTED' WHERE id=$1`, [
      id('edit'),
    ]);
  });
});
