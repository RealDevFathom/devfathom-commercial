// @vitest-environment node
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

const url = process.env.PHARMACY_TEST_OWNER_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? '';
const sql = readFileSync(
  'prisma/migrations/20261021183000_qa233_pg_trgm_app_execute/migration.sql',
  'utf8'
);
const client = new pg.Client({ connectionString: url });

(url ? describe : describe.skip)('QA-233 pg_trgm application grants', () => {
  beforeAll(async () => {
    assertDisposableRlsDatabase(url);
    await client.connect();
    // Dedicated disposable database with the catalog migrations and runtime role.
    await client.query(`DO $$ DECLARE f regprocedure; BEGIN
      FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
        JOIN pg_depend d ON d.classid = 'pg_proc'::regclass AND d.objid = p.oid
        JOIN pg_extension e ON e.oid = d.refobjid
        WHERE d.refclassid = 'pg_extension'::regclass AND d.deptype = 'e'
          AND e.extname = 'pg_trgm'
      LOOP EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, devfathom_app', f);
      END LOOP;
    END $$`);
  });

  afterAll(async () => {
    await client.query('ROLLBACK');
    await client.end();
  });

  it('reproduces 42501, applies twice, then searches as devfathom_app with tenant RLS', async () => {
    await client.query('SET ROLE devfathom_app');
    await expect(client.query(`SELECT 'panadol' % 'panadol'`)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(client.query(sql)).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('migration role devfathom_app cannot grant it'),
      hint: expect.stringContaining(
        'prisma/prepare-extensions.ts with EXTENSION_ADMIN_DATABASE_URL'
      ),
    });
    await client.query('ROLLBACK');
    await client.query('RESET ROLE');
    await client.query(sql);
    await client.query(sql);

    const publicGrants = await client.query(`SELECT p.proname FROM pg_proc p
      JOIN pg_depend d ON d.classid = 'pg_proc'::regclass AND d.objid = p.oid
      JOIN pg_extension e ON e.oid = d.refobjid
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      WHERE d.refclassid = 'pg_extension'::regclass AND d.deptype = 'e'
        AND e.extname = 'pg_trgm' AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'`);
    expect(publicGrants.rows).toEqual([]);
    expect(
      (
        await client.query(`SELECT has_function_privilege('devfathom_app',
      'public.show_trgm(text)', 'EXECUTE') AS allowed`)
      ).rows
    ).toEqual([{ allowed: false }]);

    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_platform_admin','true',true)`);
    await client.query(`INSERT INTO organizations
      (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt")
      SELECT id,id,id,id,'ACTIVE','SHARED',now(),now()
      FROM unnest(ARRAY['qa233_org_a','qa233_org_b']) AS id`);
    await client.query(`INSERT INTO pharmacy_medicines
      (id,"organizationId","productName","productFamily",saleable,"updatedAt") VALUES
      ('qa233_med_a','qa233_org_a','Panadol','PHARMACEUTICAL',true,now()),
      ('qa233_med_b','qa233_org_b','Panadol','PHARMACEUTICAL',true,now())`);
    await client.query(`GRANT SELECT ON pharmacy_medicines, pharmacy_presentations,
      pharmacy_medicine_strength_components, pharmacy_ingredients, pharmacy_medicine_aliases
      TO devfathom_app`);
    await client.query(`SELECT set_config('app.is_platform_admin','false',true),
      set_config('app.current_organization_id','qa233_org_a',true)`);
    await client.query('SET LOCAL ROLE devfathom_app');
    expect(
      (
        await client.query(`SELECT current_user, rolsuper, rolbypassrls
      FROM pg_roles WHERE rolname = current_user`)
      ).rows
    ).toEqual([{ current_user: 'devfathom_app', rolsuper: false, rolbypassrls: false }]);
    // Execute the actual pack-setup search SQL, so new predicates remain covered.
    const router = readFileSync('src/server/routers/pharmacy-medicine.ts', 'utf8');
    const searchSql = router.match(
      /`(SELECT DISTINCT medicine\.id[\s\S]*?ORDER BY medicine\.id LIMIT \$2)`/
    )?.[1];
    expect(searchSql).toBeDefined();
    expect((await client.query(searchSql!, ['panadol', 25])).rows).toEqual([{ id: 'qa233_med_a' }]);
    expect(
      (
        await client.query(`SELECT
      similarity('panadol','panadol') = 1 AS similarity,
      word_similarity('panadol','panadol') = 1 AS word,
      strict_word_similarity('panadol','panadol') = 1 AS strict,
      'panadol' <% 'panadol' AS word_op, 'panadol' %> 'panadol' AS word_commutator,
      'panadol' <<% 'panadol' AS strict_op, 'panadol' %>> 'panadol' AS strict_commutator`)
      ).rows
    ).toEqual([
      {
        similarity: true,
        word: true,
        strict: true,
        word_op: true,
        word_commutator: true,
        strict_op: true,
        strict_commutator: true,
      },
    ]);
    expect(
      (
        await client.query(`SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE oid = 'pharmacy_medicines'::regclass`)
      ).rows
    ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });
});
