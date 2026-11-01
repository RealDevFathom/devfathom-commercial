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
const sindhBranchId = `ph1198_sindh_${suffix}`;
const otherBranchId = `ph1198_otherbranch_${suffix}`;
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

/** ISO date `offset` days from today (UTC); profiles cannot be backdated. */
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** A complete, valid profile; individual tests vary one field at a time. */
const profile = {
  branchId,
  effectiveFrom: day(0),
  provinceCode: 'PK-PB',
  premisesAddressLine: '12 Mall Road',
  premisesCity: 'Lahore',
  premisesStorageDescription: 'Cold chain fridge and a locked controlled-drug cabinet.',
  licenceCategory: 'PROVISIONAL',
  licenceNumber: 'LIC-4471',
  licenceValidFrom: '2026-01-01',
  licenceValidTo: day(400),
  licenceEvidenceFileRef: '/api/files/licence.pdf',
  permittedSchedules: [] as string[],
  qualifiedPersonRegistration: 'PC-9981',
  qualifiedPersonValidFrom: '2026-01-01',
  qualifiedPersonValidTo: day(400),
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
       VALUES ($1,$2,$1,'Gulberg','12 Mall Road','Lahore','PK-PB',now()),
              ($3,$2,$3,'Model Town','9 Link Road','Lahore','PK-PB',now()),
              ($6,$2,$6,'Clifton','5 Clifton Road','Karachi','PK-SD',now()),
              ($4,$5,$4,'Other tenant','1 Elsewhere','Karachi','PK-SD',now())`,
      [branchId, organizationId, secondBranchId, otherBranchId, otherOrganizationId, sindhBranchId]
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
        [branchId, secondBranchId, sindhBranchId].sort()
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

  it('hides and refuses Sindh rules pending legal review in production (Punjab only)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_ENV', 'production');
    try {
      await withTenantDb(organizationId, async (db) => {
        const result = await caller(db).regulatory();
        expect(result.jurisdictions.some((option) => option.provinceCode === 'PK-SD')).toBe(false);
        expect(result.jurisdictions.some((option) => option.provinceCode === 'PK-PB')).toBe(true);
        await expect(
          caller(db).saveRegulatoryProfile({
            ...profile,
            branchId: sindhBranchId,
            effectiveFrom: day(0),
            provinceCode: 'PK-SD',
            licenceCategory: 'RETAIL',
            permittedSchedules: ['G'],
          })
        ).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: expect.stringContaining('No jurisdiction rules are published'),
        });
      });
    } finally {
      vi.unstubAllEnvs();
    }
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

  it('refuses a province that differs from the branch’s own province (QA-129)', async () => {
    await withTenantDb(organizationId, async (db) => {
      await expect(
        caller(db).saveRegulatoryProfile({
          ...profile,
          effectiveFrom: day(0),
          provinceCode: 'PK-SD',
          licenceCategory: 'RETAIL',
          permittedSchedules: ['G'],
        })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('This branch is registered in'),
      });
    });
  });

  it('fails closed when the branch has no province on record (#162)', async () => {
    // A branch that predates the non-empty province CHECK — added NOT VALID, so
    // it never validated the rows already on file — carries an empty province.
    // The client picks a published province (PK-PB), which clears the
    // jurisdiction lookup, so the only thing standing between it and a stored
    // profile is the branch-province check. That check must refuse, never wave
    // an unverifiable branch through on the client's say-so.
    await owner.query(
      'ALTER TABLE pharmacy_branches DROP CONSTRAINT IF EXISTS pharmacy_branches_province_nonempty'
    );
    await owner.query(`UPDATE pharmacy_branches SET "provinceCode" = '' WHERE id = $1`, [
      secondBranchId,
    ]);
    try {
      await withTenantDb(organizationId, async (db) => {
        const before = await db.branchRegulatoryProfile.count({ where: { organizationId } });
        await expect(
          caller(db).saveRegulatoryProfile({
            ...profile,
            branchId: secondBranchId,
            provinceCode: 'PK-PB',
          })
        ).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: expect.stringContaining('no province on record'),
        });
        expect(await db.branchRegulatoryProfile.count({ where: { organizationId } })).toBe(before);
      });
    } finally {
      await owner.query(`UPDATE pharmacy_branches SET "provinceCode" = 'PK-PB' WHERE id = $1`, [
        secondBranchId,
      ]);
      await owner.query(
        `ALTER TABLE pharmacy_branches ADD CONSTRAINT pharmacy_branches_province_nonempty CHECK (btrim("provinceCode") <> '') NOT VALID`
      );
    }
  });

  it('rejects an invalid workspace time zone with a validation error, not a 500 (#162)', async () => {
    // A bad IANA zone stored on the organization once reached the licence-expiry
    // check and threw a RangeError deep inside the schema — an uncaught 500. It
    // must surface as a BAD_REQUEST instead.
    await owner.query(`UPDATE organizations SET "timezone" = 'Not/AZone' WHERE id = $1`, [
      organizationId,
    ]);
    try {
      await withTenantDb(organizationId, async (db) => {
        await expect(caller(db).saveRegulatoryProfile(profile)).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: expect.stringContaining('time zone'),
        });
      });
    } finally {
      await owner.query(`UPDATE organizations SET "timezone" = 'UTC' WHERE id = $1`, [
        organizationId,
      ]);
    }
  });

  it.each([
    ['expired', '2026-01-01', '2026-06-01'],
    ['reversed', day(30), day(20)],
  ])('refuses a %s licence window without storing a profile', async (_, validFrom, validTo) => {
    await withTenantDb(organizationId, async (db) => {
      const before = await db.branchRegulatoryProfile.count({ where: { organizationId } });
      await expect(
        caller(db).saveRegulatoryProfile({
          ...profile,
          licenceValidFrom: validFrom,
          licenceValidTo: validTo,
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await db.branchRegulatoryProfile.count({ where: { organizationId } })).toBe(before);
    });
  });

  it('accepts a licence expiring today in Asia/Karachi (#240, #291)', async () => {
    const todayInKarachi = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Karachi',
    }).format(new Date());
    await owner.query(`UPDATE organizations SET "timezone" = 'Asia/Karachi' WHERE id = $1`, [
      organizationId,
    ]);
    await withTenantDb(organizationId, async (db) => {
      await expect(
        caller(db).saveRegulatoryProfile({
          ...profile,
          branchId: secondBranchId,
          licenceValidTo: todayInKarachi,
        })
      ).resolves.toMatchObject({ version: 1 });
    });
  });

  it('refuses a backdated effective date (#162)', async () => {
    await withTenantDb(organizationId, async (db) => {
      await expect(
        caller(db).saveRegulatoryProfile({ ...profile, effectiveFrom: day(-1) })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('cannot be in the past'),
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
        inForce: true,
        provinceName: 'Punjab',
        licenceNumber: 'LIC-4471',
      });
      expect(listed.versions[0]?.effectiveTo).toBeNull();
    });
  });

  it('appends the next version and closes the previous one, in one transaction', async () => {
    await withTenantDb(organizationId, async (db) => {
      const saved = await caller(db).saveRegulatoryProfile({
        ...profile,
        effectiveFrom: day(29),
        licenceNumber: 'LIC-5588',
      });
      expect(saved.version).toBe(2);

      const listed = await caller(db).regulatory({ branchId });
      expect(listed.versions.map((version) => version.version)).toEqual([2, 1]);
      // Exactly one version is in force, and version 1's history survives.
      expect(listed.versions.filter((version) => version.inForce)).toHaveLength(1);
      expect(listed.versions[1]?.licenceNumber).toBe('LIC-4471');
      expect(listed.versions[1]?.effectiveTo).not.toBeNull();
    });
  });

  it('refuses a version that starts on or before the one already on file', async () => {
    await withTenantDb(organizationId, async (db) => {
      await expect(
        caller(db).saveRegulatoryProfile({ ...profile, effectiveFrom: day(29) })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('must start after the version already on file'),
      });
      // The refusal left the record exactly as it was: still two versions, one
      // in force. A partial write here would close the history with nothing
      // succeeding it.
      const listed = await caller(db).regulatory({ branchId });
      expect(listed.versions).toHaveLength(2);
      expect(listed.versions.filter((version) => version.inForce)).toHaveLength(1);
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

  // Use the other tenant so earlier Punjab profiles cannot tie with the Sindh
  // profile on effectiveFrom when readiness chooses a branch.
  it('lets a Sindh branch record an operable profile that passes the licences gate (QA-129)', async () => {
    await withTenantDb(otherOrganizationId, async (db) => {
      // Sindh publishes RETAIL/WHOLESALE licence categories and G/H schedules,
      // so a complete profile on that confirmed rule set is one the regulatory
      // guard allows the branch to operate on — unlike the provisional Punjab a
      // Karachi branch used to be forced onto.
      const saved = await caller(db, otherOrganizationId).saveRegulatoryProfile({
        ...profile,
        branchId: otherBranchId,
        effectiveFrom: day(0),
        provinceCode: 'PK-SD',
        premisesCity: 'Karachi',
        licenceCategory: 'RETAIL',
        licenceNumber: 'SD-LIC-1001',
        permittedSchedules: ['G', 'H'],
        fiscalStatus: 'REGISTERED',
      });
      expect(saved.version).toBe(1);
      const stored = await db.branchRegulatoryProfile.findFirst({
        where: { organizationId: otherOrganizationId, branchId: otherBranchId },
        include: { jurisdictionRuleSet: true },
      });
      expect(stored?.jurisdictionRuleSet.version).toBe(2);
      expect(stored?.jurisdictionRuleSet.licenceCategories).toMatchObject({
        pendingLegalReview: true,
      });

      // The gate the operator came for: with published rules and a complete
      // profile, premises-and-licences is done and activation is no longer
      // blocked on it.
      const licences = saved.readiness.items.find((item) => item.key === 'PREMISES_AND_LICENCES');
      expect(licences?.state).toBe('DONE');

      const listed = await caller(db, otherOrganizationId).regulatory({ branchId: otherBranchId });
      expect(listed.versions).toHaveLength(1);
      expect(listed.versions[0]).toMatchObject({
        version: 1,
        inForce: true,
        provinceName: 'Sindh',
        licenceCategory: 'RETAIL',
      });
    });
  });
});
