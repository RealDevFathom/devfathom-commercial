/** Exact SQL migration regression, confined to disposable schemas in a local synthetic DB. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const runtimeUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL;
const describeIfDatabase = runtimeUrl && ownerUrl ? describe : describe.skip;
const migration = readFileSync(
  'prisma/migrations/20261024160000_pharmacy_pakistan_jurisdiction_rules_pending_review/migration.sql',
  'utf8'
);
const baseline = [
  '20260902130000_pharmacy_regulatory_profiles',
  '20261022233600_pharmacy_placeholder_rule_set',
  '20261022235900_restore_regulatory_delete_exceptions',
].map((name) => readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8'));
const columns = `id, code, version, "effectiveFrom", "effectiveTo", "licenceCategories",
  "permittedSchedules", "prescriptionOnlyClasses", "prescriptionRetentionDays", "controlledRegisterFlags",
  "pharmacistCoverageRule", "recordRetentionByClass", "createdAt"`;
const fields = [
  'licenceCategories',
  'permittedSchedules',
  'prescriptionOnlyClasses',
  'prescriptionRetentionDays',
  'controlledRegisterFlags',
  'pharmacistCoverageRule',
  'recordRetentionByClass',
] as const;
const versionedExclusion = `ALTER TABLE pharmacy_jurisdiction_rule_sets
  DROP CONSTRAINT pharmacy_jurisdiction_rule_sets_no_overlap;
  ALTER TABLE pharmacy_jurisdiction_rule_sets ADD CONSTRAINT pharmacy_jurisdiction_rule_sets_no_overlap
  EXCLUDE USING gist (code WITH =, version WITH =,
    tsrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamp), '[)') WITH &&);`;

function localOnly(value: string) {
  const url = new URL(value);
  const socket = url.searchParams.get('host');
  return (
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    (url.hostname === '' && socket?.startsWith('/'))
  );
}

async function fixture(run: (owner: Client, schema: string) => Promise<void>) {
  if (!ownerUrl || !runtimeUrl) throw new Error('Both synthetic database URLs are required');
  if (!localOnly(ownerUrl) || !localOnly(runtimeUrl)) throw new Error('Synthetic local DBs only');
  expect(ownerUrl !== runtimeUrl).toBe(true);
  const owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  const schema = `ph129_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  try {
    const role = await owner.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await owner.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await owner.query(`SET search_path TO "${schema}", public`);
    // Use the shipped regulatory SQL, including placeholder support, rather
    // than approximating the constraints, RLS policies or immutable trigger.
    for (const sql of baseline) await owner.query(sql);
    await owner.query("SELECT set_config('app.is_platform_admin', 'false', false)");
    await run(owner, schema);
  } finally {
    await owner.query('ROLLBACK');
    if (created) await owner.query(`DROP SCHEMA "${schema}" CASCADE`);
    await owner.end();
  }
}

async function rules(owner: Client) {
  return (await owner.query('SELECT * FROM pharmacy_jurisdiction_rule_sets ORDER BY code, version'))
    .rows;
}

async function flag(owner: Client) {
  return (await owner.query("SELECT current_setting('app.is_platform_admin', true) AS flag"))
    .rows[0].flag;
}

describeIfDatabase('#129 exact jurisdiction migration on PostgreSQL', () => {
  it('seeds seven jurisdictions under FORCE RLS without publishing production legal confirmation', async () => {
    await fixture(async (owner, schema) => {
      const before = await rules(owner);
      await owner.query(migration);
      expect(await flag(owner)).toBe('false');
      const seeded = await rules(owner);
      expect(seeded.map((row) => row.code)).toEqual([
        'PK-AJK',
        'PK-BA',
        'PK-GB',
        'PK-ICT',
        'PK-KP',
        'PK-PB',
        'PK-SD',
      ]);
      expect(seeded.find((row) => row.code === 'PK-PB')).toEqual(before[0]);
      expect(seeded.every((row) => row.isPlaceholder === false)).toBe(true);
      const sindh = seeded.find((row) => row.code === 'PK-SD');
      expect(sindh).toMatchObject({ id: 'pk_sd_pending_review_v3', version: 3, effectiveTo: null });
      expect(fields.map((field) => sindh[field])).toEqual(
        [
          ['RETAIL', 'WHOLESALE'],
          ['G', 'H'],
          ['H'],
          { H: 1825 },
          { H: true },
          { minimumHoursPerWeek: 40 },
          { prescription: 1825 },
        ].map((values) => ({ values, provisional: false, pendingLegalReview: true }))
      );
      for (const row of seeded.filter((item) => !['PK-PB', 'PK-SD'].includes(item.code))) {
        for (const field of fields) expect(row[field]).toMatchObject({ provisional: true });
      }
      expect(
        (await owner.query('SELECT count(*)::int count FROM pharmacy_branch_regulatory_profiles'))
          .rows[0].count
      ).toBe(0);
      expect(
        (
          await owner.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE oid = 'pharmacy_jurisdiction_rule_sets'::regclass`)
        ).rows
      ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);

      const runtime = new Client({ connectionString: runtimeUrl });
      await runtime.connect();
      try {
        const role = (
          await runtime.query('SELECT current_user AS name, quote_ident(current_user) AS quoted')
        ).rows[0];
        const ownerRole = (await owner.query('SELECT current_user AS name')).rows[0].name;
        expect(role.name === ownerRole).toBe(false);
        expect(
          (
            await runtime.query(
              'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
            )
          ).rows
        ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
        await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${role.quoted}`);
        await owner.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${role.quoted}`
        );
        await runtime.query(`SET search_path TO "${schema}", public`);
        await runtime.query("SELECT set_config('app.is_platform_admin', 'false', false)");
        expect(await rules(runtime)).toEqual(seeded);
        await expect(
          runtime.query(`INSERT INTO pharmacy_jurisdiction_rule_sets (${columns})
          SELECT 'synthetic_forbidden', 'PK-TEST', 1, "effectiveFrom", "effectiveTo", "licenceCategories",
            "permittedSchedules", "prescriptionOnlyClasses", "prescriptionRetentionDays", "controlledRegisterFlags",
            "pharmacistCoverageRule", "recordRetentionByClass", "createdAt"
          FROM pharmacy_jurisdiction_rule_sets WHERE code = 'PK-PB'`)
        ).rejects.toMatchObject({ code: '42501' });
        await owner.query("SELECT set_config('app.is_platform_admin', 'true', false)");
        await expect(
          owner.query(`UPDATE pharmacy_jurisdiction_rule_sets
          SET "licenceCategories" = '{}' WHERE code = 'PK-SD'`)
        ).rejects.toMatchObject({ code: '23514' });
        const deleted = await owner.query(
          "DELETE FROM pharmacy_jurisdiction_rule_sets WHERE code = 'PK-SD'"
        );
        expect(deleted.rowCount).toBe(0);
        expect(await rules(owner)).toEqual(seeded);
      } finally {
        await runtime.end();
      }
    });
  });

  it.each([1, 2, 3])(
    'appends above existing Sindh v%s without collisions or historical payload rewrites',
    async (maxVersion: number) => {
      await fixture(async (owner) => {
        await owner.query("SELECT set_config('app.is_platform_admin', 'true', false)");
        // v1 alone has main's original exclusion; v2/v3 reconstruct the earlier
        // branch's versioned exclusion so both historical entry paths are covered.
        if (maxVersion > 1) await owner.query(versionedExclusion);
        for (let version = 1; version <= maxVersion; version++) {
          const historicalValues = [
            ['RETAIL', 'WHOLESALE'],
            ['G', 'H'],
            ['H'],
            { H: 1825 },
            { H: true },
            { minimumHoursPerWeek: 40 },
            { prescription: 1825 },
          ].map((values) =>
            JSON.stringify({
              values,
              provisional: false,
              ...(version > 1 ? { pendingLegalReview: true } : {}),
            })
          );
          await owner.query(
            `INSERT INTO pharmacy_jurisdiction_rule_sets
          (id, code, version, "effectiveFrom", "licenceCategories", "permittedSchedules",
           "prescriptionOnlyClasses", "prescriptionRetentionDays", "controlledRegisterFlags",
           "pharmacistCoverageRule", "recordRetentionByClass")
          VALUES ($1, 'PK-SD', $2, '2026-01-01', $3, $4, $5, $6, $7, $8, $9)`,
            [
              version === 1 ? 'pk_sd_confirmed_v1' : `pk_sd_pending_review_v${version}`,
              version,
              ...historicalValues,
            ]
          );
        }
        await owner.query(`INSERT INTO pharmacy_jurisdiction_rule_sets (${columns})
        SELECT 'synthetic_existing_kp', 'PK-KP', 4, "effectiveFrom", "effectiveTo", "licenceCategories",
          "permittedSchedules", "prescriptionOnlyClasses", "prescriptionRetentionDays", "controlledRegisterFlags",
          "pharmacistCoverageRule", "recordRetentionByClass", "createdAt"
        FROM pharmacy_jurisdiction_rule_sets WHERE code = 'PK-PB'`);
        await owner.query(
          "SELECT set_config('app.current_organization_id', 'synthetic-org', false)"
        );
        await owner.query(`INSERT INTO pharmacy_branch_regulatory_profiles
        (id, "organizationId", "branchId", version, "effectiveFrom", "provinceCode", "jurisdictionRuleSetId",
         premises, "licenceCategory", "licenceNumber", "licenceValidFrom", "licenceValidTo", "licenceEvidenceFileRef",
         "permittedSchedules", "qualifiedPersonRegistration", "qualifiedPersonValidFrom", "qualifiedPersonValidTo",
         "qualifiedPersonCoverageRosterRef", "fiscalStatus", "retentionPolicy")
        VALUES ('synthetic-profile', 'synthetic-org', 'synthetic-branch', 1, '2026-01-01', 'PK-SD',
          'pk_sd_confirmed_v1', '{}', 'RETAIL', 'synthetic-licence', '2026-01-01', '2027-01-01',
          'synthetic/licence', ARRAY['G', 'H'], 'synthetic-qp', '2026-01-01', '2027-01-01',
          'synthetic/roster', 'synthetic-fiscal', '{}')`);
        const profilesBefore = await owner.query(
          'SELECT * FROM pharmacy_branch_regulatory_profiles'
        );
        const before = await rules(owner);
        await owner.query("SELECT set_config('app.is_platform_admin', 'false', false)");
        await owner.query(migration);
        expect(await flag(owner)).toBe('false');
        const after = await rules(owner);
        const oldIds = new Set(before.map((row) => row.id));
        expect(after.filter((row) => oldIds.has(row.id))).toEqual(before);
        expect(
          (await owner.query('SELECT * FROM pharmacy_branch_regulatory_profiles')).rows
        ).toEqual(profilesBefore.rows);
        const latest = (
          await owner.query(`SELECT * FROM pharmacy_jurisdiction_rule_sets
        WHERE code = 'PK-SD' AND "effectiveFrom" <= '2026-10-24'
          AND ("effectiveTo" IS NULL OR "effectiveTo" > '2026-10-24')
        ORDER BY "effectiveFrom" DESC, version DESC LIMIT 1`)
        ).rows[0];
        const next = Math.max(maxVersion + 1, 3);
        expect(latest).toMatchObject({ id: `pk_sd_pending_review_v${next}`, version: next });
        for (const field of fields)
          expect(latest[field]).toMatchObject({ pendingLegalReview: true });
        expect(after.filter((row) => row.code === 'PK-KP')).toHaveLength(1);
        expect(after.filter((row) => row.code === 'PK-SD')).toHaveLength(maxVersion + 1);
        expect(new Set(after.map((row) => `${row.code}:${row.version}`)).size).toBe(after.length);
      });
    }
  );

  it('rolls back all seeds, the exclusion change and the platform flag on a late insert failure', async () => {
    await fixture(async (owner) => {
      await owner.query(`ALTER TABLE pharmacy_jurisdiction_rule_sets ADD CONSTRAINT synthetic_reject_ajk
        CHECK (code <> 'PK-AJK')`);
      const before = await rules(owner);
      const exclusion = await owner.query(`SELECT pg_get_constraintdef(oid) def FROM pg_constraint
        WHERE conrelid = 'pharmacy_jurisdiction_rule_sets'::regclass
          AND conname = 'pharmacy_jurisdiction_rule_sets_no_overlap'`);
      await expect(owner.query(migration)).rejects.toMatchObject({ code: '23514' });
      await owner.query('ROLLBACK');
      expect(await flag(owner)).toBe('false');
      expect(await rules(owner)).toEqual(before);
      expect(
        (
          await owner.query(`SELECT pg_get_constraintdef(oid) def FROM pg_constraint
        WHERE conrelid = 'pharmacy_jurisdiction_rule_sets'::regclass
          AND conname = 'pharmacy_jurisdiction_rule_sets_no_overlap'`)
        ).rows
      ).toEqual(exclusion.rows);
    });
  });
});
