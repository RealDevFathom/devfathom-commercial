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

describeIfDatabase('pharmacy medicine PostgreSQL RLS and immutability', () => {
  beforeAll(async () => {
    assertDisposableRlsDatabase(url);
    await client.connect();
    await client.query('BEGIN');
    await client.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT "${role}" TO CURRENT_USER`);
    await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    // Extension preparation revokes PUBLIC EXECUTE. The disposable lane's
    // extension owner must grant this exact function to the test owner WITH
    // GRANT OPTION; this transaction delegates only the catalog-search operator.
    await client.query(`GRANT EXECUTE ON FUNCTION public.similarity_op(text,text) TO "${role}"`);
    await client.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON pharmacy_ingredients,pharmacy_medicines,pharmacy_medicine_strength_components,pharmacy_presentations,pharmacy_pack_levels,pharmacy_medicine_pack_mrps,pharmacy_medicine_provenance,pharmacy_medicine_barcodes,pharmacy_medicine_aliases,pharmacy_medicine_review_decisions,pharmacy_medicine_publication_batches,pharmacy_medicine_publication_entries TO "${role}"`
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
    const runtimeRole = await client.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
    expect(runtimeRole.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
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
    await expectPgCode('23514', () =>
      client.query(
        `INSERT INTO pharmacy_medicine_aliases
          (id,"medicineId",type,value,"normalizedValue")
         VALUES ('cross_tenant_alias',$1,'LEGACY_CODE','legacy-b','legacyb')`,
        [`medicine_b_${suffix}`]
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

  it('keeps scan codes unique per tenant and resolves only the tenant target', async () => {
    await client.query(
      `INSERT INTO pharmacy_medicine_barcodes
        (id,"presentationId","packLevelId",type,code,"normalizedCode")
       VALUES ($1,$2,$3,'GTIN','01-234','01234')`,
      [`barcode_a_${suffix}`, `presentation_a_${suffix}`, `pack_a_${suffix}`]
    );
    await expectPgCode('23505', () =>
      client.query(
        `INSERT INTO pharmacy_medicine_barcodes
          (id,"presentationId",type,code,"normalizedCode") VALUES ($1,$2,'INTERNAL','01234','01234')`,
        [`barcode_duplicate_${suffix}`, `presentation_a_${suffix}`]
      )
    );
    const resolved = await client.query(
      `SELECT "presentationId","packLevelId" FROM pharmacy_medicine_barcodes WHERE "normalizedCode"='01234'`
    );
    expect(resolved.rows).toEqual([
      { presentationId: `presentation_a_${suffix}`, packLevelId: `pack_a_${suffix}` },
    ]);
  });

  it('does not allow scraped or user assertions to replace accepted regulator evidence', async () => {
    await client.query(
      `INSERT INTO pharmacy_medicine_provenance
        (id,"medicineId",field,source,"sourceType","retrievedAt",status,"assertedValue")
       VALUES ($1,$2,'drapRegistrationNumber','DRAP','REGULATOR',now(),'ACCEPTED','"DRAP-1"')`,
      [`assertion_verified_${suffix}`, `medicine_a_${suffix}`]
    );
    await expectPgCode('23514', () =>
      client.query(
        `INSERT INTO pharmacy_medicine_provenance
          (id,"medicineId",field,source,"sourceType","retrievedAt",status,"assertedValue","supersedesId")
         VALUES ($1,$2,'drapRegistrationNumber','scraper','SCRAPED',now(),'UNREVIEWED','"invented"',$3)`,
        [`assertion_scraped_${suffix}`, `medicine_a_${suffix}`, `assertion_verified_${suffix}`]
      )
    );
  });

  it('records review actions append-only and never merges candidates automatically', async () => {
    await client.query(
      `INSERT INTO pharmacy_medicine_review_decisions
        (id,"duplicateKey",action,"medicineIds","reviewerId")
       VALUES ($1,'panadol:500mg:tablet','DEFER',$2,'reviewer')`,
      [`decision_${suffix}`, [`medicine_a_${suffix}`]]
    );
    await expectPgCode('23514', () =>
      client.query(`UPDATE pharmacy_medicine_review_decisions SET action='MERGE' WHERE id=$1`, [
        `decision_${suffix}`,
      ])
    );
    const medicineCount = await client.query(
      `SELECT count(*)::int AS count FROM pharmacy_medicines`
    );
    expect(medicineCount.rows[0].count).toBe(1);
  });

  it('restores the prior assertion by supersession when a publication is reversed', async () => {
    await client.query(
      `INSERT INTO pharmacy_medicine_provenance
        (id,"medicineId",field,source,"sourceType","retrievedAt",status,"assertedValue","supersedesId")
       VALUES ($1,$2,'brandName','manufacturer','MANUFACTURER',now(),'CORRECTED','"New brand"',NULL)`,
      [`assertion_published_${suffix}`, `medicine_a_${suffix}`]
    );
    await client.query(
      `INSERT INTO pharmacy_medicine_provenance
        (id,"medicineId",field,source,"sourceType","retrievedAt",reviewer,status,"assertedValue","supersedesId")
       VALUES ($1,$2,'brandName','rollback','MANUFACTURER',now(),'reviewer','CORRECTED','"Old brand"',$3)`,
      [`assertion_restored_${suffix}`, `medicine_a_${suffix}`, `assertion_published_${suffix}`]
    );
    const current = await client.query(
      `SELECT "assertedValue" FROM pharmacy_medicine_provenance
       WHERE "medicineId"=$1 AND field='brandName'
         AND id NOT IN (SELECT "supersedesId" FROM pharmacy_medicine_provenance WHERE "supersedesId" IS NOT NULL)`,
      [`medicine_a_${suffix}`]
    );
    expect(current.rows).toEqual([{ assertedValue: 'Old brand' }]);
  });

  it('records p95 catalog search latency on a 20k-row tenant fixture', async () => {
    await client.query(
      `INSERT INTO pharmacy_medicines
        (id,"organizationId","productName","brandName","productFamily","updatedAt")
       SELECT 'perf_' || $1 || '_' || n, $2, 'Generic ' || n, 'Brand ' || n,
              'PHARMACEUTICAL', now()
         FROM generate_series(1,20000) AS n`,
      [suffix, orgA]
    );
    const samples: number[] = [];
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const started = performance.now();
      await client.query(
        `SELECT id FROM pharmacy_medicines
          WHERE pharmacy_normalize_catalog_text("productName") % 'generic19999'
             OR pharmacy_normalize_catalog_text(coalesce("brandName",'')) % 'generic19999'
          LIMIT 25`
      );
      if (iteration >= 2) samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const p95Ms = samples[Math.ceil(samples.length * 0.95) - 1]!;
    console.info(`pharmacy catalog search 20k fixture p95=${p95Ms.toFixed(2)}ms`);
    expect(p95Ms).toBeLessThan(200);
  }, 30_000);
});
