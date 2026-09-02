import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.PHARMACY_TEST_OWNER_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (!url) throw new Error('PHARMACY_TEST_OWNER_DATABASE_URL or TEST_DATABASE_URL is required');
const client = new pg.Client({ connectionString: url });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const role = `pharmacy_runtime_${suffix}`;
const orgA = `pharmacy_org_a_${suffix}`;
const orgB = `pharmacy_org_b_${suffix}`;

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

describe('pharmacy medicine PostgreSQL RLS and immutability', () => {
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname))
      throw new Error('Refusing non-local database');
    await client.connect();
    await client.query('BEGIN');
    await client.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT "${role}" TO CURRENT_USER`);
    await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await client.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON pharmacy_ingredients,pharmacy_medicines,pharmacy_medicine_strength_components,pharmacy_presentations,pharmacy_pack_levels,pharmacy_medicine_pack_mrps,pharmacy_medicine_provenance TO "${role}"`
    );
    await client.query(`SELECT set_config('app.is_platform_admin','true',true)`);
    await client.query(
      `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',now(),now()),($2,$2,$2,$2,'ACTIVE','SHARED',now(),now())`,
      [orgA, orgB]
    );
    for (const [key, org] of [
      ['a', orgA],
      ['b', orgB],
    ] as const) {
      await client.query(
        `INSERT INTO pharmacy_ingredients (id,"organizationId",name,"updatedAt") VALUES ($1,$2,$3,now())`,
        [`ingredient_${key}_${suffix}`, org, `Ingredient ${key}`]
      );
      await client.query(
        `INSERT INTO pharmacy_medicines (id,"organizationId","productName","productFamily","updatedAt") VALUES ($1,$2,$3,'PHARMACEUTICAL',now())`,
        [`medicine_${key}_${suffix}`, org, `Medicine ${key}`]
      );
      await client.query(
        `INSERT INTO pharmacy_presentations (id,"organizationId","medicineId",presentation,"updatedAt") VALUES ($1,$2,$3,'tablet',now())`,
        [`presentation_${key}_${suffix}`, org, `medicine_${key}_${suffix}`]
      );
      await client.query(
        `INSERT INTO pharmacy_pack_levels (id,"organizationId","presentationId","versionGroupId",version,level,"unitsPerParent","effectiveFrom","referencedAt") VALUES ($1,$2,$3,$4,1,'CARTON',20,now(),now())`,
        [`pack_${key}_${suffix}`, org, `presentation_${key}_${suffix}`, `group_${key}_${suffix}`]
      );
    }
    await client.query(`SELECT set_config('app.is_platform_admin','false',true)`);
    await client.query(`SET LOCAL ROLE "${role}"`);
    await client.query(`SELECT set_config('app.current_organization_id',$1,true)`, [orgA]);
  });

  afterAll(async () => {
    await client.query('ROLLBACK');
    await client.end();
  });

  it('hides another tenant and rejects explicit tenant substitution', async () => {
    const visible = await client.query(`SELECT id FROM pharmacy_medicines ORDER BY id`);
    expect(visible.rows.map((row) => row.id)).toEqual([`medicine_a_${suffix}`]);
    await expectPgCode('42501', () =>
      client.query(
        `INSERT INTO pharmacy_ingredients (id,"organizationId",name,"updatedAt") VALUES ('substitution',$1,'bad',now())`,
        [orgB]
      )
    );
  });

  it('never rewrites a referenced conversion; correction inserts a version', async () => {
    await expectPgCode('23514', () =>
      client.query(`UPDATE pharmacy_pack_levels SET "unitsPerParent"=25 WHERE id=$1`, [
        `pack_a_${suffix}`,
      ])
    );
    await client.query(
      `INSERT INTO pharmacy_pack_levels (id,"presentationId","versionGroupId",version,level,"unitsPerParent","effectiveFrom","supersedesPackLevelId") VALUES ($1,$2,$3,2,'CARTON',25,now(),$4)`,
      [`pack_a_v2_${suffix}`, `presentation_a_${suffix}`, `group_a_${suffix}`, `pack_a_${suffix}`]
    );
    const versions = await client.query(
      `SELECT version,"unitsPerParent" FROM pharmacy_pack_levels WHERE "versionGroupId"=$1 ORDER BY version`,
      [`group_a_${suffix}`]
    );
    expect(versions.rows).toEqual([
      { version: 1, unitsPerParent: 20 },
      { version: 2, unitsPerParent: 25 },
    ]);
  });

  it('rejects a cyclic pack hierarchy', async () => {
    await client.query(
      `INSERT INTO pharmacy_pack_levels (id,"presentationId","versionGroupId",version,level,"unitsPerParent","effectiveFrom")
       VALUES ($1,$3,$1,1,'BOX',5,now()),($2,$3,$2,1,'STRIP',10,now())`,
      [`cycle_box_${suffix}`, `cycle_strip_${suffix}`, `presentation_a_${suffix}`]
    );
    await client.query(`UPDATE pharmacy_pack_levels SET "parentPackLevelId"=$1 WHERE id=$2`, [
      `cycle_box_${suffix}`,
      `cycle_strip_${suffix}`,
    ]);
    await expectPgCode('23514', () =>
      client.query(`UPDATE pharmacy_pack_levels SET "parentPackLevelId"=$1 WHERE id=$2`, [
        `cycle_strip_${suffix}`,
        `cycle_box_${suffix}`,
      ])
    );
  });
});
