/**
 * #709 — the FBR Tier-1 self-check router, against PostgreSQL.
 *
 * What matters here is persistence: the answers and the server-computed result
 * land in one tenant-scoped audit row under forced RLS, the latest row is read
 * back as the current answer, another tenant never sees it, and a row older
 * than twelve months asks the question again.
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
    // The middleware's per-call row is not what this suite asserts; the
    // self-check's own transactional row is.
    recordTrpcAudit: vi.fn(),
  };
});

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let pharmacyOnboardingRouter: typeof import('./pharmacy-onboarding').pharmacyOnboardingRouter;

const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const organizationId = `ph709_org_${suffix}`;
const otherOrganizationId = `ph709_other_${suffix}`;
const userId = `ph709_user_${suffix}`;
const otherUserId = `ph709_otheruser_${suffix}`;
const owner = new pg.Client({ connectionString: ownerUrl });

function caller(db: ScopedDb, actingOrganizationId = organizationId, actingUserId = userId) {
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
        id: actingUserId,
        name: 'Tier Check Admin',
        email: `${actingUserId}@example.test`,
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

const notTier1 = {
  chainOutlet: 'NO' as const,
  airConditionedMallOrPlaza: 'NO' as const,
  electricityBillRupees12Months: 250_000,
  bulkImportWholesaleAndRetail: 'NO' as const,
  bankCardPos: 'NO' as const,
  otherNotifiedCategory: 'NO' as const,
  annualTurnoverRupees: 15_000_000,
};

/**
 * Age or reshape this run's own audit rows to stand in for older history.
 * `audit_logs` is append-only for every role (DEV-155), so the table owner
 * lifts the guard for this one statement inside a transaction and restores it.
 */
async function rewriteAuditFixture(statement: string, params: unknown[]) {
  try {
    await owner.query('BEGIN');
    await owner.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only');
    await owner.query(statement, params);
    await owner.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only');
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK');
    throw error;
  }
}

describeIfDatabase('#709 FBR Tier-1 self-check against PostgreSQL', () => {
  beforeAll(async () => {
    ({ withTenantDb } = await import('@/lib/tenancy/scoped-db'));
    ({ pharmacyOnboardingRouter } = await import('./pharmacy-onboarding'));
    await owner.connect();
    await owner.query(`SET app.is_platform_admin = 'true'`);
    for (const [id, user] of [
      [organizationId, userId],
      [otherOrganizationId, otherUserId],
    ] as const) {
      await owner.query(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
         VALUES ($1,$1,$1,$1,'PHARMACY','ONBOARDING','SHARED',now(),now())`,
        [id]
      );
      await owner.query(
        `INSERT INTO organization_departments
          (id, "organizationId", key, name, active, "sortOrder", "createdAt", "updatedAt")
         VALUES ($1,$2,'LEADERSHIP','Leadership',true,0,now(),now())`,
        [`dept_${id}`, id]
      );
      await owner.query(
        `INSERT INTO users
          (id, "organizationId", "organizationRoleId", name, email, role, department, title, "startDate", status, "createdAt", "updatedAt")
         VALUES ($1,$2,NULL,'Tier Check Admin',$3,'ADMIN','LEADERSHIP','Owner',now(),'ACTIVE',now(),now())`,
        [user, id, `${user}@example.test`]
      );
    }
  });

  afterAll(async () => {
    const organizations = [organizationId, otherOrganizationId];
    try {
      await owner.query('BEGIN');
      // Audit rows are append-only (DEV-155) and stay behind under this run's
      // unique organization ids; deleting their actors only clears `actorId`.
      await owner.query('DELETE FROM users WHERE "organizationId" = ANY($1)', [organizations]);
      await owner.query('DELETE FROM organization_departments WHERE "organizationId" = ANY($1)', [
        organizations,
      ]);
      await owner.query('DELETE FROM organizations WHERE id = ANY($1)', [organizations]);
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    } finally {
      await owner.end();
    }
  });

  it('asks the question when it has never been answered', async () => {
    await withTenantDb(organizationId, async (db) => {
      const status = await caller(db).fbrTier1Status();
      expect(status.latest).toBeNull();
      expect(status.recheckDue).toBe(true);
      expect(status.disclaimer).toMatch(/not tax advice/i);
      expect(status.criteria).toHaveLength(7);
    });
  });

  it('stores the answers and the server-computed result in one audit row', async () => {
    const status = await withTenantDb(organizationId, (db) =>
      caller(db).recordFbrTier1Check({ ...notTier1, chainOutlet: 'YES' })
    );
    expect(status.latest?.evaluation.result).toBe('TIER_1');
    expect(status.latest?.evaluation.headline).toBe('Tier-1: FBR integration required');
    expect(status.recheckDue).toBe(false);

    const rows = await owner.query<{
      actorId: string;
      category: string;
      action: string;
      targetType: string;
      input: Record<string, unknown>;
      result: { result: string; criteria: { key: string; outcome: string }[] };
      metadata: { rulesVersion: string; disclaimer: string };
    }>(
      `SELECT "actorId", category, action, "targetType", input, result, metadata
         FROM audit_logs WHERE "organizationId" = $1 AND action = 'pharmacy.fbrTier1Check'`,
      [organizationId]
    );
    expect(rows.rows).toHaveLength(1);
    const [row] = rows.rows;
    expect(row).toMatchObject({
      actorId: userId,
      category: 'PHARMACY',
      targetType: 'FbrTier1SelfCheck',
      input: { ...notTier1, chainOutlet: 'YES' },
    });
    expect(row.result.result).toBe('TIER_1');
    expect(row.result.criteria.find((c) => c.key === 'chainOutlet')?.outcome).toBe('MET');
    expect(row.metadata.disclaimer).toMatch(/not tax advice/i);
    expect(row.metadata.rulesVersion).toBeTruthy();
  });

  it('keeps every answer and reports the newest as current', async () => {
    const status = await withTenantDb(organizationId, (db) =>
      caller(db).recordFbrTier1Check(notTier1)
    );
    expect(status.latest?.evaluation.result).toBe('NOT_TIER_1');
    expect(status.latest?.answers).toEqual(notTier1);
    const count = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs
        WHERE "organizationId" = $1 AND action = 'pharmacy.fbrTier1Check'`,
      [organizationId]
    );
    expect(count.rows[0].count).toBe('2');
  });

  it('refuses a client-supplied result and malformed amounts', async () => {
    await withTenantDb(organizationId, async (db) => {
      await expect(
        caller(db).recordFbrTier1Check({ ...notTier1, result: 'NOT_TIER_1' } as never)
      ).rejects.toThrow();
      await expect(
        caller(db).recordFbrTier1Check({ ...notTier1, electricityBillRupees12Months: -5 })
      ).rejects.toThrow();
      await expect(
        caller(db).recordFbrTier1Check({ ...notTier1, annualTurnoverRupees: 1.5 })
      ).rejects.toThrow();
      const missingCategory: Record<string, unknown> = { ...notTier1 };
      delete missingCategory.bankCardPos;
      await expect(
        caller(db).recordFbrTier1Check(missingCategory as never)
      ).rejects.toThrow();
      await expect(
        caller(db).recordFbrTier1Check({ ...notTier1, otherNotifiedCategory: 'MAYBE' } as never)
      ).rejects.toThrow();
    });
  });

  it('never shows one tenant’s answer to another', async () => {
    await withTenantDb(otherOrganizationId, async (db) => {
      const status = await caller(db, otherOrganizationId, otherUserId).fbrTier1Status();
      expect(status.latest).toBeNull();
      expect(status.recheckDue).toBe(true);
    });
  });

  it('asks again once twelve months have passed', async () => {
    await rewriteAuditFixture(
      `UPDATE audit_logs SET "createdAt" = "createdAt" - interval '13 months'
        WHERE "organizationId" = $1 AND action = 'pharmacy.fbrTier1Check'`,
      [organizationId]
    );
    await withTenantDb(organizationId, async (db) => {
      const status = await caller(db).fbrTier1Status();
      expect(status.latest?.evaluation.result).toBe('NOT_TIER_1');
      expect(status.recheckDue).toBe(true);
    });
  });

  it('re-evaluates legacy negative answers as Unsure without losing their history', async () => {
    await rewriteAuditFixture(
      `UPDATE audit_logs SET input = input::jsonb - 'bankCardPos' - 'otherNotifiedCategory'
        WHERE "organizationId" = $1 AND action = 'pharmacy.fbrTier1Check'`,
      [organizationId]
    );
    await withTenantDb(organizationId, async (db) => {
      const status = await caller(db).fbrTier1Status();
      expect(status.latest?.evaluation.result).toBe('UNSURE');
      expect(status.latest?.answers).toMatchObject({
        bankCardPos: 'UNSURE',
        otherNotifiedCategory: 'UNSURE',
      });
    });
  });

  it('stores a card-payment POS as a sufficient criterion for a standalone shop', async () => {
    const answers = { ...notTier1, bankCardPos: 'YES' as const };
    const status = await withTenantDb(organizationId, (db) =>
      caller(db).recordFbrTier1Check(answers)
    );
    expect(status.latest?.evaluation.result).toBe('TIER_1');
    expect(status.latest?.answers).toEqual(answers);
    expect(status.latest?.evaluation.criteria.find((c) => c.key === 'bankCardPos')).toMatchObject({
      outcome: 'MET',
      confirmed: true,
    });
    const rows = await owner.query<{ input: unknown; result: { result: string } }>(
      'SELECT input, result FROM audit_logs WHERE id = $1 AND "organizationId" = $2',
      [status.latest!.id, organizationId]
    );
    expect(rows.rows[0].input).toEqual(answers);
    expect(rows.rows[0].result.result).toBe('TIER_1');
  });
});
