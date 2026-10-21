import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runtimeUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL;
const describeIfDatabase = runtimeUrl && ownerUrl ? describe : describe.skip;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const orgA = `org_wha1168_a_${suffix}`;
const orgB = `org_wha1168_b_${suffix}`;
// PLAT-04: a regulatory profile's branchId is now a foreign key onto the branch
// aggregate, whose id is a primary key and therefore unique across tenants.
const branchA = `branch_a_${suffix}`;
const branchB = `branch_b_${suffix}`;

beforeAll(async () => {
  if (!runtimeUrl || !ownerUrl) return;
  expect(runtimeUrl).not.toBe(ownerUrl);
  const owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    await owner.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await owner.query(
      `INSERT INTO organizations
        (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $2, 'WHA-1168 A', 'WHA-1168 A', 'PHARMACY', 'ONBOARDING', 'SHARED', now(), now()),
              ($3, $4, 'WHA-1168 B', 'WHA-1168 B', 'PHARMACY', 'ONBOARDING', 'SHARED', now(), now())`,
      [orgA, `wha1168-a-${suffix}`, orgB, `wha1168-b-${suffix}`]
    );
    await owner.query(
      `INSERT INTO pharmacy_branches
        (id, "organizationId", code, name, "addressLine", city, "provinceCode", "updatedAt")
       VALUES ($1, $2, $1, 'Branch A', '1 Test Road', 'Lahore', 'PB', now()),
              ($3, $4, $3, 'Branch B', '2 Test Road', 'Karachi', 'SD', now())`,
      [branchA, orgA, branchB, orgB]
    );
    await owner.query(
      `INSERT INTO pharmacy_branch_regulatory_profiles
       (id, "organizationId", "branchId", version, "effectiveFrom", "provinceCode",
        "jurisdictionRuleSetId", premises, "licenceCategory", "licenceNumber",
        "licenceValidFrom", "licenceValidTo", "licenceEvidenceFileRef", "permittedSchedules",
        "qualifiedPersonRegistration", "qualifiedPersonValidFrom", "qualifiedPersonValidTo",
        "qualifiedPersonCoverageRosterRef", "fiscalStatus", "retentionPolicy")
       VALUES
       ($1, $2, $5, 1, '2026-09-02', 'PK-PB', 'pk_pb_provisional_v1', '{}',
        'PROVISIONAL', 'LIC-A', '2026-01-01', '2027-01-01', 'file-a', ARRAY[]::text[],
        'QP-A', '2026-01-01', '2027-01-01', 'roster-a', 'UNCONFIRMED', '{}'),
       ($3, $4, $6, 1, '2026-09-02', 'PK-PB', 'pk_pb_provisional_v1', '{}',
        'PROVISIONAL', 'LIC-B', '2026-01-01', '2027-01-01', 'file-b', ARRAY[]::text[],
        'QP-B', '2026-01-01', '2027-01-01', 'roster-b', 'UNCONFIRMED', '{}')`,
      [`profile-a-${suffix}`, orgA, `profile-b-${suffix}`, orgB, branchA, branchB]
    );
  } finally {
    await owner.end();
  }
});

afterAll(async () => {
  if (!ownerUrl) return;
  const owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    await owner.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await owner.query('BEGIN');
    await owner.query('DELETE FROM organizations WHERE id = ANY($1)', [[orgA, orgB]]);
    await owner.query(
      'ALTER TABLE pharmacy_branch_regulatory_profiles DISABLE TRIGGER pharmacy_branch_regulatory_profiles_immutable'
    );
    await owner.query(
      'DELETE FROM pharmacy_branch_regulatory_profiles WHERE "organizationId" = ANY($1)',
      [[orgA, orgB]]
    );
    await owner.query('DELETE FROM pharmacy_branches WHERE "organizationId" = ANY($1)', [
      [orgA, orgB],
    ]);
    await owner.query(
      'ALTER TABLE pharmacy_branch_regulatory_profiles ENABLE TRIGGER pharmacy_branch_regulatory_profiles_immutable'
    );
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK');
    throw error;
  } finally {
    await owner.end();
  }
});

describeIfDatabase('pharmacy regulatory persistence', () => {
  it('runs as LOGIN NOSUPERUSER NOBYPASSRLS', async () => {
    const client = new Client({ connectionString: runtimeUrl });
    await client.connect();
    try {
      const result = await client.query<{
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(`SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
      expect(result.rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });
    } finally {
      await client.end();
    }
  });

  it('forces tenant RLS for branch profiles', async () => {
    const client = new Client({ connectionString: runtimeUrl });
    await client.connect();
    try {
      await client.query(`SELECT set_config('app.current_organization_id', $1, false)`, [orgA]);
      await client.query(`SELECT set_config('app.is_platform_admin', 'false', false)`);
      const visible = await client.query<{ organizationId: string }>(
        `SELECT "organizationId" FROM pharmacy_branch_regulatory_profiles ORDER BY "organizationId"`
      );
      expect(visible.rows).toEqual([{ organizationId: orgA }]);
    } finally {
      await client.end();
    }
  });

  it('seeds provisional PK-PB and pending-review PK-SD v2, and rejects regulated-record rewrites', async () => {
    const client = new Client({ connectionString: runtimeUrl });
    await client.connect();
    try {
      const rules = await client.query<{ code: string; provisional: boolean }>(
        `SELECT DISTINCT ON (code) code, ("licenceCategories"->>'provisional')::boolean provisional
           FROM pharmacy_jurisdiction_rule_sets
          WHERE code IN ('PK-PB', 'PK-SD')
          ORDER BY code, "effectiveFrom" DESC, version DESC`
      );
      // PK-SD is usable in staging/pilots while awaiting counsel sign-off.
      expect(rules.rows).toEqual([
        { code: 'PK-PB', provisional: true },
        { code: 'PK-SD', provisional: false },
      ]);
      const sindh = await client.query(`
        SELECT version, "licenceCategories", "permittedSchedules", "prescriptionOnlyClasses",
          "prescriptionRetentionDays", "controlledRegisterFlags", "pharmacistCoverageRule", "recordRetentionByClass"
        FROM pharmacy_jurisdiction_rule_sets WHERE code = 'PK-SD' ORDER BY version DESC
      `);
      expect(sindh.rows.map((row) => row.version)).toEqual([2, 1]);
      for (const [key, value] of Object.entries(sindh.rows[0])) {
        if (key !== 'version') expect(value).toMatchObject({ pendingLegalReview: true });
      }
      expect(sindh.rows[1].licenceCategories).not.toHaveProperty('pendingLegalReview');
      const security = await client.query(`
        SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE oid = 'pharmacy_jurisdiction_rule_sets'::regclass
      `);
      expect(security.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
      const role = await client.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await expect(
        client.query(
          `INSERT INTO pharmacy_jurisdiction_rule_sets
           (id, code, version, "effectiveFrom", "licenceCategories", "permittedSchedules",
            "prescriptionOnlyClasses", "prescriptionRetentionDays", "controlledRegisterFlags",
            "pharmacistCoverageRule", "recordRetentionByClass")
           VALUES ('forbidden', 'PK-KP', 1, now(), '{}', '{}', '{}', '{}', '{}', '{}', '{}')`
        )
      ).rejects.toMatchObject({ code: '42501' });
      await client.query(`SELECT set_config('app.current_organization_id', $1, false)`, [orgA]);
      await client.query(`SELECT set_config('app.is_platform_admin', 'false', false)`);
      await expect(
        client.query(
          `UPDATE pharmacy_branch_regulatory_profiles SET "fiscalStatus" = 'CHANGED' WHERE "organizationId" = $1`,
          [orgA]
        )
      ).rejects.toThrow(/append-only/);
    } finally {
      await client.end();
    }
  });

  it('allows only a one-time effective-date close so a successor can be appended', async () => {
    const client = new Client({ connectionString: ownerUrl });
    await client.connect();
    try {
      await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
      await client.query(
        `UPDATE pharmacy_branch_regulatory_profiles
            SET "effectiveTo" = '2026-10-01'
          WHERE id = $1`,
        [`profile-a-${suffix}`]
      );
      await client.query(
        `INSERT INTO pharmacy_branch_regulatory_profiles
         (id, "organizationId", "branchId", version, "effectiveFrom", "provinceCode",
          "jurisdictionRuleSetId", premises, "licenceCategory", "licenceNumber",
          "licenceValidFrom", "licenceValidTo", "licenceEvidenceFileRef", "permittedSchedules",
          "qualifiedPersonRegistration", "qualifiedPersonValidFrom", "qualifiedPersonValidTo",
          "qualifiedPersonCoverageRosterRef", "fiscalStatus", "retentionPolicy")
         SELECT $1, "organizationId", "branchId", 2, '2026-10-01', "provinceCode",
                "jurisdictionRuleSetId", premises, "licenceCategory", "licenceNumber",
                "licenceValidFrom", "licenceValidTo", "licenceEvidenceFileRef", "permittedSchedules",
                "qualifiedPersonRegistration", "qualifiedPersonValidFrom", "qualifiedPersonValidTo",
                "qualifiedPersonCoverageRosterRef", "fiscalStatus", "retentionPolicy"
           FROM pharmacy_branch_regulatory_profiles WHERE id = $2`,
        [`profile-a-v2-${suffix}`, `profile-a-${suffix}`]
      );
      await expect(
        client.query(
          `UPDATE pharmacy_branch_regulatory_profiles SET "effectiveTo" = '2026-11-01' WHERE id = $1`,
          [`profile-a-${suffix}`]
        )
      ).rejects.toThrow(/append-only/);
    } finally {
      await client.end();
    }
  });
});
