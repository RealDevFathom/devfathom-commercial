import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * DEV-751 — pharmacy SOP sites and record links under PostgreSQL RLS.
 *
 * Runs against a migrated database as the restricted runtime role. Every write
 * happens inside one transaction that is rolled back at the end, so the
 * append-only rows it creates never outlive the suite. Skips when the URLs are
 * absent; the static migration contract below always runs.
 */
const runtimeUrl =
  process.env.PHARMACY_SOP_TEST_RUNTIME_DATABASE_URL ??
  process.env.WHA1316_RUNTIME_DATABASE_URL ??
  process.env.TEST_DATABASE_URL;
const ownerUrl =
  process.env.PHARMACY_SOP_TEST_OWNER_DATABASE_URL ?? process.env.WHA1316_OWNER_DATABASE_URL;
const describeIfDatabase = runtimeUrl && ownerUrl ? describe : describe.skip;
const tables = ['pharmacy_sop_record_links', 'pharmacy_sop_sites'] as const;
const migration = readFileSync(
  'prisma/migrations/20261104090000_pharmacy_sop_sites/migration.sql',
  'utf8'
);

describe('DEV-751 pharmacy SOP migration contract', () => {
  it('forces tenant/branch RLS on both tables and keeps record links append-only', () => {
    for (const table of tables) {
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    }
    expect(migration).toContain('app.current_branch_id');
    expect(migration).toMatch(/ON "pharmacy_sop_record_links" FOR SELECT/);
    expect(migration).toMatch(/ON "pharmacy_sop_record_links" FOR INSERT/);
    expect(migration).not.toMatch(/ON "pharmacy_sop_record_links" FOR (UPDATE|DELETE|ALL)/);
  });

  it('keys every cross-table reference by organization', () => {
    for (const reference of [
      'REFERENCES "pharmacy_branches" ("organizationId", "id")',
      'REFERENCES "restaurant_branches" ("organizationId", "id")',
      'REFERENCES "restaurant_sop_occurrences" ("organizationId", "id")',
      'REFERENCES "restaurant_sop_occurrence_steps" ("organizationId", "id")',
      'REFERENCES "restaurant_staff_profiles" ("organizationId", "id")',
    ]) {
      expect(migration).toContain(reference);
    }
  });

  it('backfills nothing and changes no existing table', () => {
    expect(migration).not.toMatch(/\bUPDATE\s+"/);
    expect(migration).not.toMatch(/INSERT\s+INTO/i);
    expect(migration).not.toMatch(/ALTER TABLE "(?!pharmacy_sop_)/);
  });
});

let runtime: Client;
const run = Math.random().toString(36).slice(2, 10);
const id = (name: string) => `dev751_${run}_${name}`;
const A = id('org_a');
const B = id('org_b');

async function as(organizationId: string | null, branchId: string | null = null) {
  await runtime.query(
    `SELECT set_config('app.is_platform_admin', $1, true),
            set_config('app.current_organization_id', $2, true),
            set_config('app.current_branch_id', $3, true)`,
    [organizationId === null ? 'true' : 'false', organizationId ?? '', branchId ?? '']
  );
}

/** Run one statement that is expected to fail, without aborting the outer transaction. */
async function refused(sql: string, params: unknown[] = []) {
  await runtime.query('SAVEPOINT attempt');
  try {
    await runtime.query(sql, params);
    return 'ACCEPTED';
  } catch (error) {
    return (error as { code?: string }).code ?? 'ERROR';
  } finally {
    await runtime.query('ROLLBACK TO SAVEPOINT attempt');
  }
}

async function seedTenant(org: string) {
  const values = (...items: string[]) => items;
  const q = (sql: string, params: unknown[]) => runtime.query(sql, params);
  await q(
    `INSERT INTO "organizations" ("id","slug","legalName","displayName","updatedAt")
     VALUES ($1,$1,$1,$1,now())`,
    values(org)
  );
  await q(
    `INSERT INTO "pharmacy_branches" ("id","organizationId","code","name","addressLine","city","provinceCode","updatedAt")
     VALUES ($1,$2,'PB1','Main','1 Road','Lahore','PB',now()), ($3,$2,'PB2','Second','2 Road','Lahore','PB',now())`,
    [`${org}_pb`, org, `${org}_pb2`]
  );
  await q(
    `INSERT INTO "restaurant_branches" ("id","organizationId","name","timezone","updatedAt")
     VALUES ($1,$2,'Main · SOP','Asia/Karachi',now()), ($3,$2,'Unbound','Asia/Karachi',now())`,
    [`${org}_rb`, org, `${org}_rb_unbound`]
  );
  await q(
    `INSERT INTO "restaurant_staff_profiles" ("id","organizationId","displayName","updatedAt")
     VALUES ($1,$2,'Staff',now())`,
    [`${org}_sp`, org]
  );
  await q(
    `INSERT INTO "restaurant_sop_templates" ("id","organizationId","name","updatedAt")
     VALUES ($1,$2,'Pharmacy — opening',now())`,
    [`${org}_tpl`, org]
  );
  await q(
    `INSERT INTO "restaurant_sop_template_versions" ("id","organizationId","templateId","versionNumber","status","updatedAt")
     VALUES ($1,$2,$3,1,'PUBLISHED',now())`,
    [`${org}_ver`, org, `${org}_tpl`]
  );
  await q(
    `INSERT INTO "restaurant_sop_template_steps" ("id","organizationId","templateVersionId","stepOrder","title","updatedAt")
     VALUES ($1,$2,$3,1,'Record temperature',now())`,
    [`${org}_tstep`, org, `${org}_ver`]
  );
  for (const [suffix, branch] of [
    ['', `${org}_rb`],
    ['_unbound', `${org}_rb_unbound`],
  ]) {
    await q(
      `INSERT INTO "restaurant_sop_assignments" ("id","organizationId","branchId","templateId","startDate","assigneeTargetType","assigneeStaffProfileId","updatedAt")
       VALUES ($1,$2,$3,$4,'2026-11-01','PERSON',$5,now())`,
      [`${org}_asg${suffix}`, org, branch, `${org}_tpl`, `${org}_sp`]
    );
    await q(
      `INSERT INTO "restaurant_sop_occurrences" ("id","organizationId","assignmentId","templateVersionId","branchId","businessDate","dueAt","windowEndsAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,'2026-11-02','2026-11-02 03:00','2026-11-02 05:00',now())`,
      [`${org}_occ${suffix}`, org, `${org}_asg${suffix}`, `${org}_ver`, branch]
    );
  }
  await q(
    `INSERT INTO "restaurant_sop_occurrence_steps" ("id","organizationId","occurrenceId","templateStepId","updatedAt")
     VALUES ($1,$2,$3,$4,now()), ($5,$2,$6,$4,now())`,
    [
      `${org}_ostep`,
      org,
      `${org}_occ`,
      `${org}_tstep`,
      `${org}_ostep_unbound`,
      `${org}_occ_unbound`,
    ]
  );
  await q(
    `INSERT INTO "pharmacy_sop_sites" ("id","organizationId","pharmacyBranchId","sopBranchId","enabledByUserId")
     VALUES ($1,$2,$3,$4,'user_seed')`,
    [`${org}_site`, org, `${org}_pb`, `${org}_rb`]
  );
  await q(
    `INSERT INTO "pharmacy_sop_record_links" ("id","organizationId","pharmacyBranchId","occurrenceId","occurrenceStepId","recordType","recordId","linkedByStaffProfileId","linkedByUserId")
     VALUES ($1,$2,$3,$4,$5,'TEMPERATURE_LOG','temp_seed',$6,'user_seed')`,
    [`${org}_link`, org, `${org}_pb`, `${org}_occ`, `${org}_ostep`, `${org}_sp`]
  );
}

const linkColumns = `("id","organizationId","pharmacyBranchId","occurrenceId","occurrenceStepId","recordType","recordId","linkedByStaffProfileId","linkedByUserId")`;

describeIfDatabase('DEV-751 pharmacy SOP PostgreSQL RLS', () => {
  beforeAll(async () => {
    runtime = new Client({ connectionString: runtimeUrl });
    await runtime.connect();
    await runtime.query('BEGIN');
    await as(null);
    await seedTenant(A);
    await seedTenant(B);
  });

  afterAll(async () => {
    await runtime?.query('ROLLBACK').catch(() => undefined);
    await runtime?.end();
  });

  it('runs as a restricted role, never SUPERUSER or BYPASSRLS', async () => {
    expect(ownerUrl).not.toBe(runtimeUrl);
    const result = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'
    );
    expect(result.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('creates both tables with RLS enabled and forced', async () => {
    const result = await runtime.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = ANY($1::text[]) AND relkind = 'r' ORDER BY relname`,
      [tables]
    );
    expect(result.rows).toEqual([
      { relname: 'pharmacy_sop_record_links', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'pharmacy_sop_sites', relrowsecurity: true, relforcerowsecurity: true },
    ]);
    const policies = await runtime.query<{ tablename: string; cmd: string; expr: string }>(
      `SELECT tablename, cmd, COALESCE(qual, with_check) AS expr FROM pg_policies
        WHERE tablename = ANY($1::text[]) ORDER BY tablename, cmd`,
      [tables]
    );
    expect(policies.rows.map((row) => [row.tablename, row.cmd])).toEqual([
      ['pharmacy_sop_record_links', 'INSERT'],
      ['pharmacy_sop_record_links', 'SELECT'],
      ['pharmacy_sop_sites', 'ALL'],
    ]);
    for (const policy of policies.rows) {
      expect(policy.expr).toContain('app.current_organization_id');
      expect(policy.expr).toContain('app.current_branch_id');
      expect(policy.expr).toContain('app.is_platform_admin');
    }
  });

  it('hides another tenant’s sites and links', async () => {
    await as(A);
    const sites = await runtime.query<{ id: string }>(
      `SELECT id FROM pharmacy_sop_sites WHERE id = ANY($1::text[]) ORDER BY id`,
      [[`${A}_site`, `${B}_site`]]
    );
    expect(sites.rows.map((row) => row.id)).toEqual([`${A}_site`]);
    const links = await runtime.query<{ id: string }>(
      `SELECT id FROM pharmacy_sop_record_links WHERE id = ANY($1::text[]) ORDER BY id`,
      [[`${A}_link`, `${B}_link`]]
    );
    expect(links.rows.map((row) => row.id)).toEqual([`${A}_link`]);

    // A branch-scoped session sees only its branch's rows.
    await as(A, `${A}_pb2`);
    const scoped = await runtime.query(`SELECT id FROM pharmacy_sop_sites WHERE id = $1`, [
      `${A}_site`,
    ]);
    expect(scoped.rowCount).toBe(0);
  });

  it('refuses explicit cross-tenant inserts', async () => {
    await as(A);
    expect(
      await refused(
        `INSERT INTO pharmacy_sop_sites ("id","organizationId","pharmacyBranchId","sopBranchId","enabledByUserId")
         VALUES ($1,$2,$3,$4,'u')`,
        [id('cross_site'), B, `${B}_pb2`, `${B}_rb_unbound`]
      )
    ).toBe('42501');
    expect(
      await refused(
        `INSERT INTO pharmacy_sop_record_links ${linkColumns} VALUES ($1,$2,$3,$4,NULL,'GOODS_RECEIPT','grn',$5,'u')`,
        [id('cross_link'), B, `${B}_pb`, `${B}_occ`, `${B}_sp`]
      )
      // The BEFORE INSERT scope trigger runs ahead of the WITH CHECK policy and,
      // under tenant A's RLS, cannot see tenant B's site: either refusal is final.
    ).toMatch(/^(42501|23514)$/);
  });

  it('refuses references into another tenant even under the caller’s own organization', async () => {
    await as(A);
    // Engine branch of tenant B.
    expect(
      await refused(
        `INSERT INTO pharmacy_sop_sites ("id","organizationId","pharmacyBranchId","sopBranchId","enabledByUserId")
         VALUES ($1,$2,$3,$4,'u')`,
        [id('foreign_engine'), A, `${A}_pb2`, `${B}_rb_unbound`]
      )
    ).toBe('23503');
    // Occurrence and staff profile of tenant B.
    expect(
      await refused(
        `INSERT INTO pharmacy_sop_record_links ${linkColumns} VALUES ($1,$2,$3,$4,NULL,'GOODS_RECEIPT','grn',$5,'u')`,
        [id('foreign_occ'), A, `${A}_pb`, `${B}_occ`, `${A}_sp`]
      )
    ).toMatch(/^(23503|23514)$/);
    expect(
      await refused(
        `INSERT INTO pharmacy_sop_record_links ${linkColumns} VALUES ($1,$2,$3,$4,NULL,'GOODS_RECEIPT','grn',$5,'u')`,
        [id('foreign_staff'), A, `${A}_pb`, `${A}_occ`, `${B}_sp`]
      )
    ).toBe('23503');
  });

  it('only links occurrences of the branch’s own SOP site, and steps of that occurrence', async () => {
    await as(A);
    expect(
      await refused(
        `INSERT INTO pharmacy_sop_record_links ${linkColumns} VALUES ($1,$2,$3,$4,NULL,'GOODS_RECEIPT','grn',$5,'u')`,
        [id('unbound_occ'), A, `${A}_pb`, `${A}_occ_unbound`, `${A}_sp`]
      )
    ).toBe('23514');
    expect(
      await refused(
        `INSERT INTO pharmacy_sop_record_links ${linkColumns} VALUES ($1,$2,$3,$4,$5,'GOODS_RECEIPT','grn',$6,'u')`,
        [id('foreign_step'), A, `${A}_pb`, `${A}_occ`, `${A}_ostep_unbound`, `${A}_sp`]
      )
    ).toBe('23514');
    // A pharmacy branch without a site cannot carry links at all.
    expect(
      await refused(
        `INSERT INTO pharmacy_sop_record_links ${linkColumns} VALUES ($1,$2,$3,$4,NULL,'GOODS_RECEIPT','grn',$5,'u')`,
        [id('siteless'), A, `${A}_pb2`, `${A}_occ`, `${A}_sp`]
      )
    ).toBe('23514');
  });

  it('keeps record links append-only and unique per occurrence and record', async () => {
    await as(A);
    await runtime.query(
      `INSERT INTO pharmacy_sop_record_links ${linkColumns} VALUES ($1,$2,$3,$4,NULL,'GOODS_RECEIPT','grn_1',$5,'u')`,
      [id('fresh'), A, `${A}_pb`, `${A}_occ`, `${A}_sp`]
    );
    expect(
      await refused(
        `INSERT INTO pharmacy_sop_record_links ${linkColumns} VALUES ($1,$2,$3,$4,NULL,'GOODS_RECEIPT','grn_1',$5,'u')`,
        [id('duplicate'), A, `${A}_pb`, `${A}_occ`, `${A}_sp`]
      )
    ).toBe('23505');

    const updated = await runtime.query(
      `UPDATE pharmacy_sop_record_links SET "note" = 'edited' WHERE id = $1`,
      [id('fresh')]
    );
    expect(updated.rowCount).toBe(0);
    const deleted = await runtime.query(`DELETE FROM pharmacy_sop_record_links WHERE id = $1`, [
      id('fresh'),
    ]);
    expect(deleted.rowCount).toBe(0);
    const row = await runtime.query<{ note: string | null }>(
      `SELECT "note" FROM pharmacy_sop_record_links WHERE id = $1`,
      [id('fresh')]
    );
    expect(row.rows).toEqual([{ note: null }]);

    // Not even the platform-admin escape grants UPDATE or DELETE.
    await as(null);
    expect(
      (await runtime.query(`DELETE FROM pharmacy_sop_record_links WHERE id = $1`, [id('fresh')]))
        .rowCount
    ).toBe(0);
  });
});
