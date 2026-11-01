/**
 * PLAT-02/03 router, against PostgreSQL.
 *
 * The interesting behaviour of this router is all database behaviour — an
 * append-only table whose only permitted UPDATE is a one-time effective-date
 * close, a forced-RLS tenant boundary, and a readiness verdict recomputed from
 * six live queries. None of that survives a mock, so this suite runs against a
 * real cluster with the restricted runtime role, exactly as production does.
 */
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const runtimeUrl =
  process.env.WHA1198_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? '';
const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL ?? '';
// Skipped, never silently passed, until both URLs name a disposable database.
const describeIfDatabase = runtimeUrl && ownerUrl ? describe : describe.skip;
if (runtimeUrl && runtimeUrl === ownerUrl)
  throw new Error('Runtime and owner database URLs must differ');
if (runtimeUrl) process.env.DATABASE_URL = runtimeUrl;

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async () => true) };
});
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return {
    ...actual,
    annotateAudit: vi.fn(),
    ipFromHeaders: vi.fn(() => null),
    isAuditExcludedPath: vi.fn(() => false),
    recordTrpcAudit: vi.fn(),
  };
});

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let pharmacyOnboardingRouter: typeof import('./pharmacy-onboarding').pharmacyOnboardingRouter;

const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const organizationId = `ph1198_org_${suffix}`;
const otherOrganizationId = `ph1198_other_${suffix}`;
const branchId = `ph1198_branch_${suffix}`;
const secondBranchId = `ph1198_branch2_${suffix}`;
const otherBranchId = `ph1198_otherbranch_${suffix}`;
const lockedBranchId = `ph1198_lockedbranch_${suffix}`;
const userId = `ph1198_user_${suffix}`;
const owner = new pg.Client({ connectionString: ownerUrl });

function caller(db: ScopedDb, actingOrganizationId = organizationId) {
  return pharmacyOnboardingRouter.createCaller({
    db,
    entitlements: {
      organizationId: actingOrganizationId,
      enabledModules: ['pharmacy-core'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: {
        id: userId,
        role: 'ADMIN',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId: actingOrganizationId,
      },
    },
    organization: { id: actingOrganizationId },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

/** A complete, valid profile; individual tests vary one field at a time. */
const profile = {
  branchId,
  effectiveFrom: '2026-09-02',
  provinceCode: 'PK-PB',
  premisesAddressLine: '12 Mall Road',
  premisesCity: 'Lahore',
  premisesStorageDescription: 'Cold chain fridge and a locked controlled-drug cabinet.',
  licenceCategory: 'PROVISIONAL',
  licenceNumber: 'LIC-4471',
  licenceValidFrom: '2026-01-01',
  licenceValidTo: '2027-01-01',
  licenceEvidenceFileRef: '/api/files/licence.pdf',
  permittedSchedules: [] as string[],
  qualifiedPersonRegistration: 'PC-9981',
  qualifiedPersonValidFrom: '2026-01-01',
  qualifiedPersonValidTo: '2027-01-01',
  qualifiedPersonCoverageRosterRef: '/api/files/roster.pdf',
  fiscalStatus: 'UNCONFIRMED' as const,
  retentionPrescriptionYears: 5,
  retentionInvoiceYears: 6,
  retentionControlledRegisterYears: 10,
};

describeIfDatabase('pharmacy onboarding router against PostgreSQL', () => {
  beforeAll(async () => {
    ({ withTenantDb } = await import('@/lib/tenancy/scoped-db'));
    ({ pharmacyOnboardingRouter } = await import('./pharmacy-onboarding'));
    await owner.connect();
    await owner.query(`SET app.is_platform_admin = 'true'`);
    for (const id of [organizationId, otherOrganizationId]) {
      await owner.query(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
         VALUES ($1,$1,$1,$1,'PHARMACY','ONBOARDING','SHARED',now(),now())`,
        [id]
      );
    }
    await owner.query(
      `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","updatedAt")
       VALUES ($1,$2,$1,'Gulberg','12 Mall Road','Lahore','PB',now()),
              ($3,$2,$3,'Model Town','9 Link Road','Lahore','PB',now()),
              ($4,$5,$4,'Other tenant','1 Elsewhere','Karachi','SD',now())`,
      [branchId, organizationId, secondBranchId, otherBranchId, otherOrganizationId]
    );
  });

  afterAll(async () => {
    // `pharmacy_onboarding_events` is append-only, but only for a tenant that
    // still exists (WHA-1209). Deleting the organization runs the ON DELETE
    // CASCADE the schema declares, and the trigger recognises a delete whose
    // organization is already gone — so dropping this fixture no longer needs
    // the owner to DISABLE TRIGGER. The append-only guarantee itself is asserted
    // below, and again in `src/lib/platform/jobs.purge.db.test.ts`.
    try {
      await owner.query('BEGIN');
      // The organization first: its cascade clears the gate states, which hold
      // an ON DELETE RESTRICT reference to the branches. The regulatory-profile
      // trigger then recognizes that the owning organization is gone, so the
      // profiles and finally the branches can be removed without disabling it.
      await owner.query('DELETE FROM organizations WHERE id = ANY($1)', [
        [organizationId, otherOrganizationId],
      ]);
      await owner.query(
        'DELETE FROM pharmacy_branch_regulatory_profiles WHERE "organizationId" = ANY($1)',
        [[organizationId, otherOrganizationId]]
      );
      await owner.query('DELETE FROM pharmacy_branches WHERE "organizationId" = ANY($1)', [
        [organizationId, otherOrganizationId],
      ]);
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    } finally {
      await owner.end();
    }
  });

  it('runs on a role that is neither superuser nor RLS-exempt', async () => {
    await withTenantDb(organizationId, async (db) => {
      const rows = await db.$queryRaw<
        { rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }[]
      >`SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
      expect(rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });
    });
  });

  it('reports twelve outstanding steps and an activation refusal for a fresh workspace', async () => {
    await withTenantDb(organizationId, async (db) => {
      const overview = await caller(db).overview();
      expect(overview.items).toHaveLength(12);
      expect(overview.ready).toBe(false);
      expect(overview.doneCount).toBe(0);
      expect(overview.blocking).toHaveLength(12);
      expect(overview.activationSummary).toContain('Activation is refused');
    });
  });

  it('offers only this organization’s branches, and only published jurisdictions', async () => {
    await withTenantDb(organizationId, async (db) => {
      const result = await caller(db).regulatory();
      expect(result.branches.map((branch) => branch.id).sort()).toEqual(
        [branchId, secondBranchId].sort()
      );
      // The other tenant's branch is absent from the picker, by an explicit
      // organization predicate — RLS is the second wall, not the only one.
      expect(result.branches.some((branch) => branch.id === otherBranchId)).toBe(false);
      // Asserted by content, not by count: the jurisdiction table is global, so
      // another suite publishing a province must not fail this one. What the
      // migration ships is a provisional Punjab, named rather than coded.
      expect(result.jurisdictions.find((option) => option.provinceCode === 'PK-PB')).toMatchObject({
        provinceName: 'Punjab',
        provisional: true,
      });
      for (const option of result.jurisdictions) {
        expect(option.provinceName).not.toBe(option.provinceCode);
      }
      expect(result.versions).toEqual([]);
    });
  });

  it('never falls back to another branch when an unknown one is requested', async () => {
    await withTenantDb(organizationId, async (db) => {
      // A branch id from another tenant resolves to nothing, and the page opens
      // on this organization's own first branch — never on the requested one.
      const result = await caller(db).regulatory({ branchId: otherBranchId });
      expect(result.selectedBranchId).toBeNull();
      expect(result.versions).toEqual([]);
    });
  });

  it('refuses a profile for a branch outside the organization, on the branch field', async () => {
    await withTenantDb(organizationId, async (db) => {
      await expect(
        caller(db).saveRegulatoryProfile({ ...profile, branchId: otherBranchId })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Choose one of this workspace’s active branches.',
      });
    });
    // Nothing was written for the other tenant.
    const leaked = await owner.query(
      `SELECT 1 FROM pharmacy_branch_regulatory_profiles WHERE "branchId" = $1`,
      [otherBranchId]
    );
    expect(leaked.rowCount).toBe(0);
  });

  it('refuses a province with no published rules, on the province field', async () => {
    await withTenantDb(organizationId, async (db) => {
      await expect(
        // A province no rule set can name, so this stays true whatever else the
        // shared jurisdiction table holds.
        caller(db).saveRegulatoryProfile({ ...profile, provinceCode: 'PK-ZZ' })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('No jurisdiction rules are published'),
      });
    });
  });

  it('refuses literal PLACEHOLDER licence text when the platform override is not active', async () => {
    await withTenantDb(organizationId, async (db) => {
      await expect(
        caller(db).saveRegulatoryProfile({ ...profile, licenceNumber: 'PLACEHOLDER' })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'PLACEHOLDER text is reserved for the active platform placeholder rule set.',
      });
    });
  });

  it('accepts and persists a licence that expires today', async () => {
    const todayInKarachi = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Karachi',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date())
      .reduce<Record<string, string>>((parts, part) => {
        parts[part.type] = part.value;
        return parts;
      }, {});
    const expiryDate = `${todayInKarachi.year}-${todayInKarachi.month}-${todayInKarachi.day}`;

    await withTenantDb(organizationId, async (db) => {
      const saved = await caller(db).saveRegulatoryProfile({
        ...profile,
        branchId: secondBranchId,
        licenceValidTo: expiryDate,
      });
      expect(saved.version).toBe(1);

      const listed = await caller(db).regulatory({ branchId: secondBranchId });
      expect(listed.versions).toHaveLength(1);
      expect(listed.versions[0]).toMatchObject({
        version: 1,
        licenceValidTo: new Date(`${expiryDate}T00:00:00.000Z`),
      });
    });
  });

  it('saves version 1 and leaves the licences step outstanding while the rules are provisional', async () => {
    await withTenantDb(organizationId, async (db) => {
      const saved = await caller(db).saveRegulatoryProfile(profile);
      expect(saved.version).toBe(1);

      // The profile exists; the branch still may not operate, because PK-PB's
      // rule set is provisional. A surface that reported this step as done would
      // be telling the operator something activation will refuse.
      const licences = saved.readiness.items.find((item) => item.key === 'PREMISES_AND_LICENCES');
      expect(licences?.state).toBe('NEEDS_YOU');

      const listed = await caller(db).regulatory({ branchId });
      expect(listed.versions).toHaveLength(1);
      expect(listed.versions[0]).toMatchObject({
        version: 1,
        effective: true,
        inForce: false,
        provinceName: 'Punjab',
        licenceNumber: 'LIC-4471',
        // #977 — the open version that cannot operate is "not in force", never
        // "superseded".
        state: 'NOT_IN_FORCE',
      });
      expect(listed.versions[0]?.effectiveTo).toBeNull();
    });
  });

  it('appends the next version and closes the previous one, in one transaction', async () => {
    await withTenantDb(organizationId, async (db) => {
      const saved = await caller(db).saveRegulatoryProfile({
        ...profile,
        effectiveFrom: '2026-10-01',
        licenceNumber: 'LIC-5588',
      });
      expect(saved.version).toBe(2);

      const listed = await caller(db).regulatory({ branchId });
      expect(listed.versions.map((version) => version.version)).toEqual([2, 1]);
      // Exactly one version is effective, but provisional rules keep it from
      // being labelled in force; version 1's history still survives.
      expect(listed.versions.filter((version) => version.effective)).toHaveLength(1);
      expect(listed.versions.filter((version) => version.inForce)).toHaveLength(0);
      expect(listed.versions[1]?.licenceNumber).toBe('LIC-4471');
      expect(listed.versions[1]?.effectiveTo).not.toBeNull();
      // #977 — only the version whose period has ended is superseded.
      expect(listed.versions.map((version) => version.state)).toEqual([
        'NOT_IN_FORCE',
        'SUPERSEDED',
      ]);
    });
  });

  it('refuses a version that starts on or before the one already on file', async () => {
    await withTenantDb(organizationId, async (db) => {
      await expect(
        caller(db).saveRegulatoryProfile({ ...profile, effectiveFrom: '2026-10-01' })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('must start after the version already on file'),
      });
      // The refusal left the record exactly as it was: still two versions, one
      // effective. A partial write here would close the history with nothing
      // succeeding it.
      const listed = await caller(db).regulatory({ branchId });
      expect(listed.versions).toHaveLength(2);
      expect(listed.versions.filter((version) => version.effective)).toHaveLength(1);
    });
  });

  it('records an attestation with its actor and evidence, and appends the history event', async () => {
    await withTenantDb(organizationId, async (db) => {
      const after = await caller(db).recordGate({
        gate: 'ORG_TYPE',
        evidenceRef: 'Board minute 2026-09-02',
        note: 'Confirmed at the September board meeting.',
      });
      const row = after.items.find((item) => item.key === 'ORG_TYPE');
      expect(row?.state).toBe('DONE');
      expect(after.doneCount).toBe(1);
    });

    const stored = await owner.query<{ status: string; evidenceRef: string; actorId: string }>(
      `SELECT status::text, "evidenceRef", "actorId" FROM pharmacy_onboarding_gate_states
        WHERE "organizationId" = $1 AND gate = 'ORG_TYPE'`,
      [organizationId]
    );
    expect(stored.rows[0]).toEqual({
      status: 'PASSED',
      evidenceRef: 'Board minute 2026-09-02',
      actorId: userId,
    });
    const events = await owner.query(
      `SELECT 1 FROM pharmacy_onboarding_events
        WHERE "organizationId" = $1 AND gate = 'ORG_TYPE' AND "toStatus" = 'PASSED'`,
      [organizationId]
    );
    expect(events.rowCount).toBe(1);
  });

  it('refuses an attestation against a step the platform answers from data', async () => {
    await withTenantDb(organizationId, async (db) => {
      await expect(
        caller(db).recordGate({
          gate: 'OPENING_STOCK_READINESS',
          evidenceRef: 'A note claiming stock exists',
        })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('answered from your records'),
      });
    });
    const written = await owner.query(
      `SELECT 1 FROM pharmacy_onboarding_gate_states
        WHERE "organizationId" = $1 AND gate = 'OPENING_STOCK_READINESS'`,
      [organizationId]
    );
    expect(written.rowCount).toBe(0);
  });

  it('counts an assigned pharmacy package even though the tenant cannot read the package table', async () => {
    // `platform_packages` is FORCE row-level security with no tenant policy, so
    // the evaluator's own package lookup returns nothing on this connection.
    await withTenantDb(organizationId, async (db) => {
      const visible = await db.$queryRaw<
        { count: bigint }[]
      >`SELECT count(*) FROM platform_packages`;
      expect(Number(visible[0]!.count)).toBe(0);
      const before = await caller(db).overview();
      expect(before.items.find((item) => item.key === 'COMMERCIAL_PACKAGE')?.state).toBe(
        'NEEDS_YOU'
      );
    });

    await owner.query(
      `INSERT INTO platform_packages (id, key, name, vertical, version, active, "defaultSeats", "createdAt", "updatedAt")
       VALUES ($1, $1, 'WHA-1198 Pharmacy', 'PHARMACY', 1, true, 10, now(), now())
       ON CONFLICT (key) DO NOTHING`,
      [`ph1198_pkg_${suffix}`]
    );
    await owner.query(`UPDATE organizations SET "packageId" = $2 WHERE id = $1`, [
      organizationId,
      `ph1198_pkg_${suffix}`,
    ]);

    await withTenantDb(organizationId, async (db) => {
      const after = await caller(db).overview();
      // The gate the platform's own activation preflight already considers
      // satisfied now reads the same way on the tenant's surface.
      expect(after.items.find((item) => item.key === 'COMMERCIAL_PACKAGE')?.state).toBe('DONE');
      expect(after.blocking.some((item) => item.key === 'COMMERCIAL_PACKAGE')).toBe(false);
    });

    // And it is the assignment that does it, not the vertical alone.
    await owner.query(`UPDATE organizations SET "packageId" = NULL WHERE id = $1`, [
      organizationId,
    ]);
    await withTenantDb(organizationId, async (db) => {
      const cleared = await caller(db).overview();
      expect(cleared.items.find((item) => item.key === 'COMMERCIAL_PACKAGE')?.state).toBe(
        'NEEDS_YOU'
      );
    });
  });

  it('keeps one tenant’s profiles and gate claims out of another tenant’s reads', async () => {
    await withTenantDb(otherOrganizationId, async (db) => {
      const overview = await caller(db, otherOrganizationId).overview();
      expect(overview.doneCount).toBe(0);
      const result = await caller(db, otherOrganizationId).regulatory();
      expect(result.branches.map((branch) => branch.id)).toEqual([otherBranchId]);
      expect(result.versions).toEqual([]);
    });
  });

  it('locks a branch to its own province and names unpublished rules', async () => {
    // #977 — added last so the branch-list assertions above are unaffected.
    // Gilgit-Baltistan is a known province no rule set is published for.
    await owner.query(
      `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","updatedAt")
       VALUES ($1,$2,$1,'Gilgit','1 Airport Road','Gilgit','PK-GB',now())`,
      [lockedBranchId, organizationId]
    );
    await withTenantDb(organizationId, async (db) => {
      const listed = await caller(db).regulatory({ branchId: lockedBranchId });
      expect(listed.branches.find((branch) => branch.id === lockedBranchId)).toMatchObject({
        provinceCode: 'PK-GB',
      });

      // Another province's published rules are refused, on the province field.
      await expect(
        caller(db).saveRegulatoryProfile({
          ...profile,
          branchId: lockedBranchId,
          provinceCode: 'PK-PB',
        })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('This branch is in Gilgit-Baltistan'),
      });

      // Its own province has no rules yet, and the refusal says so plainly.
      await expect(
        caller(db).saveRegulatoryProfile({
          ...profile,
          branchId: lockedBranchId,
          provinceCode: 'PK-GB',
        })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('Gilgit-Baltistan rules not published yet'),
      });
    });
    const written = await owner.query(
      `SELECT 1 FROM pharmacy_branch_regulatory_profiles WHERE "branchId" = $1`,
      [lockedBranchId]
    );
    expect(written.rowCount).toBe(0);
  });
});
