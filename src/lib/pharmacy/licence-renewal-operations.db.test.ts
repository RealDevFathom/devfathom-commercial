// @vitest-environment node
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('server-only', () => ({}));

const runtimeUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL ?? process.env.M8_TEST_OWNER_DATABASE_URL;
if (runtimeUrl) process.env.DATABASE_URL = runtimeUrl;
const describeDb = runtimeUrl && ownerUrl ? describe : describe.skip;

const suffix = randomBytes(5).toString('hex');
const orgA = `org_ren720_a_${suffix}`;
const orgB = `org_ren720_b_${suffix}`;
const branchA = `branch_ren720_a_${suffix}`;
const branchB = `branch_ren720_b_${suffix}`;
const supplierA = `supplier_ren720_a_${suffix}`;
const DAY_MS = 86_400_000;
const NOW = new Date();
// Columns are `timestamp(3)` holding UTC wall time, as Prisma writes them: send
// ISO strings, whose zone suffix Postgres ignores for a zoneless timestamp.
const iso = (date: Date) => date.toISOString();
const inDays = (days: number) => iso(new Date(NOW.getTime() + days * DAY_MS));

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  operations: typeof import('./licence-renewal-operations');
};
let deps: Deps;

const PROFILE_INSERT = `INSERT INTO pharmacy_branch_regulatory_profiles
  (id, "organizationId", "branchId", version, "effectiveFrom", "effectiveTo", "provinceCode",
   "jurisdictionRuleSetId", premises, "licenceCategory", "licenceNumber",
   "licenceValidFrom", "licenceValidTo", "licenceEvidenceFileRef", "permittedSchedules",
   "qualifiedPersonRegistration", "qualifiedPersonValidFrom", "qualifiedPersonValidTo",
   "qualifiedPersonCoverageRosterRef", "fiscalStatus", "retentionPolicy")
  VALUES ($1, $2, $3, $4, $5, $6, 'PK-PB', 'pk_pb_provisional_v1', '{}',
   'PHARMACY', $7, $5, $8, 'file', ARRAY[]::text[],
   'QP-1', $5, $9, 'roster', 'UNCONFIRMED', '{}')`;

async function asOwner<T>(work: (client: pg.Client) => Promise<T>) {
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    await owner.query(`SET app.is_platform_admin = 'true'`);
    return await work(owner);
  } finally {
    await owner.end();
  }
}

const read = (organizationId: string, branchIds: string[]) =>
  deps.withTenantDb(organizationId, (db: ScopedDb) =>
    deps.operations.readLicenceRenewalReminders(db, { organizationId, branchIds, at: NOW })
  );

beforeAll(async () => {
  if (!runtimeUrl || !ownerUrl) return;
  const [scoped, operations, guard] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./licence-renewal-operations'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  deps = { withTenantDb: scoped.withTenantDb, operations };
  await guard.assertRlsEnforcingRole(scoped.withPlatformDb);
  await asOwner(async (owner) => {
    await owner.query(
      `INSERT INTO organizations
         (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $2, 'REN-720 A', 'REN-720 A', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now()),
              ($3, $4, 'REN-720 B', 'REN-720 B', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      [orgA, `ren720-a-${suffix}`, orgB, `ren720-b-${suffix}`]
    );
    await owner.query(
      `INSERT INTO pharmacy_branches
         (id, "organizationId", code, name, "addressLine", city, "provinceCode", "updatedAt")
       VALUES ($1, $2, $1, 'Main', '1 Test Road', 'Lahore', 'PB', now()),
              ($3, $4, $3, 'Other', '2 Test Road', 'Lahore', 'PB', now())`,
      [branchA, orgA, branchB, orgB]
    );
    // Seeded: org A's branch licence expires in 30 days; its qualified person is current.
    await owner.query(PROFILE_INSERT, [
      `profile_ren720_a1_${suffix}`,
      orgA,
      branchA,
      1,
      inDays(-700),
      null,
      'DSL-OLD',
      inDays(30),
      inDays(400),
    ]);
    // Org B's licence is also due; it must never surface in org A.
    await owner.query(PROFILE_INSERT, [
      `profile_ren720_b1_${suffix}`,
      orgB,
      branchB,
      1,
      inDays(-700),
      null,
      'DSL-B',
      inDays(20),
      inDays(400),
    ]);
    await owner.query(
      `INSERT INTO pharmacy_suppliers (id, "organizationId", name, authorized, "updatedAt")
       VALUES ($1, $2, $1, true, now())`,
      [supplierA, orgA]
    );
    await owner.query(
      `INSERT INTO pharmacy_supplier_licences
         (id, "organizationId", "supplierId", "licenceType", "licenceNumber",
          "issuingAuthority", "issuedAt", "expiresAt", "verifiedAt")
       VALUES ($1, $2, $3, 'WHOLESALE', 'WS-1', 'Test authority', now(), $4, now())`,
      [`licence_ren720_a1_${suffix}`, orgA, supplierA, inDays(7)]
    );
  });
}, 120_000);

afterAll(async () => {
  // Regulated profile rows are append-only; fixture rows stay in the throwaway database.
});

describeDb('#720 licence renewal reminders (forced RLS)', () => {
  it('reminds about a branch licence expiring in 30 days and a supplier licence at 7 days', async () => {
    const reminders = await read(orgA, [branchA]);
    expect(
      reminders.map(({ kind, reference, stage, branchId }) => ({ kind, reference, stage, branchId }))
    ).toEqual([
      { kind: 'SUPPLIER_LICENCE', reference: 'WS-1', stage: 7, branchId: null },
      { kind: 'BRANCH_LICENCE', reference: 'DSL-OLD', stage: 30, branchId: branchA },
    ]);
    expect(reminders[1]!.checklist.fee).toBe('Rs 3,000 (pharmacy)');
  });

  it('never reads another tenant’s licences, even when its branch id is asked for', async () => {
    const reminders = await read(orgA, [branchA, branchB]);
    expect(reminders.some((reminder) => reminder.reference === 'DSL-B')).toBe(false);
  });

  it('stops the reminders once the renewed licences are saved', async () => {
    await asOwner(async (owner) => {
      // Saved the way the regulatory profile form saves a new version.
      await owner.query(
        `UPDATE pharmacy_branch_regulatory_profiles SET "effectiveTo" = $1 WHERE id = $2`,
        [iso(NOW), `profile_ren720_a1_${suffix}`]
      );
      await owner.query(PROFILE_INSERT, [
        `profile_ren720_a2_${suffix}`,
        orgA,
        branchA,
        2,
        iso(NOW),
        null,
        'DSL-NEW',
        inDays(730),
        inDays(400),
      ]);
      await owner.query(
        `INSERT INTO pharmacy_supplier_licences
           (id, "organizationId", "supplierId", "licenceType", "licenceNumber",
            "issuingAuthority", "issuedAt", "expiresAt", "verifiedAt", "supersedesId")
         VALUES ($1, $2, $3, 'WHOLESALE', 'WS-2', 'Test authority', now(), $4, now(), $5)`,
        [`licence_ren720_a2_${suffix}`, orgA, supplierA, inDays(730), `licence_ren720_a1_${suffix}`]
      );
    });
    await expect(read(orgA, [branchA])).resolves.toEqual([]);
  });
});
