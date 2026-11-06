// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: vi.fn(async () => true),
}));
vi.mock('@/server/audit', async () => ({
  ...(await vi.importActual<typeof import('@/server/audit')>('@/server/audit')),
  isAuditExcludedPath: () => true,
}));
let credentialHash: string;
const userId = 'user_h5_' + randomBytes(6).toString('hex');
const approverId = 'staff_h5_' + randomBytes(6).toString('hex');
const credentialId = 'cred_h5_' + randomBytes(6).toString('hex');
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const dbSuffix = randomBytes(6).toString('hex');
const dbIds = {
  organization: `org_wha434_${dbSuffix}`,
  branch: `branch_wha434_${dbSuffix}`,
  staff: `staff_wha434_${dbSuffix}`,
  template: `template_wha434_${dbSuffix}`,
  version: `version_wha434_${dbSuffix}`,
  templateStep: `template_step_wha434_${dbSuffix}`,
  assignment: `assignment_wha434_${dbSuffix}`,
  occurrence: `occurrence_wha434_${dbSuffix}`,
  occurrenceStep: `occurrence_step_wha434_${dbSuffix}`,
};
let tenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];

describeIfDatabase('SOP authenticated identity PostgreSQL regression', () => {
  beforeAll(async () => {
    const setup = new Client({ connectionString: TEST_DATABASE_URL });
    await setup.connect();
    try {
      const role = await setup.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      // Fixture provisioning uses the same explicit platform scope as other DB
      // suites; every command below runs through the tenant-scoped runtime role.
      await setup.query(`SET app.is_platform_admin = 'true'`);
      await setup.query(
        `INSERT INTO "organizations"
          ("id", "slug", "legalName", "displayName", "status", "deploymentMode", "createdAt", "updatedAt")
         VALUES ($1, $2, 'WHA-434 Test Co', 'WHA-434 Test', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [dbIds.organization, `wha434-${dbSuffix}`]
      );
    } finally {
      await setup.end();
    }

    ({ createTenantDb: tenantDb } = await import('@/lib/tenancy/scoped-db'));
    const scoped = tenantDb(dbIds.organization);
    const { hashOperatorCredential } = await import('./operator-credentials');
    credentialHash = await hashOperatorCredential('PIN', '7264');
    await scoped.$transaction(async (tx) => {
      await tx.restaurantBranch.create({
        data: { id: dbIds.branch, name: 'Retry Lab', timezone: 'UTC', businessDayCutoff: '00:00' },
      });
      await tx.restaurantStaffProfile.create({
        data: { id: dbIds.staff, displayName: 'Retry Operator', primaryBranchId: dbIds.branch },
      });
      await tx.restaurantSopTemplate.create({
        data: { id: dbIds.template, name: 'Retry SOP' },
      });
      await tx.restaurantSopTemplateVersion.create({
        data: {
          id: dbIds.version,
          templateId: dbIds.template,
          versionNumber: 1,
          status: 'PUBLISHED',
        },
      });
      await tx.restaurantSopTemplateStep.create({
        data: {
          id: dbIds.templateStep,
          templateVersionId: dbIds.version,
          stepOrder: 1,
          title: 'Capture proof',
        },
      });
      await tx.restaurantSopAssignment.create({
        data: {
          id: dbIds.assignment,
          branchId: dbIds.branch,
          templateId: dbIds.template,
          daysOfWeek: [],
          startDate: new Date('2026-08-29T00:00:00.000Z'),
          assigneeTargetType: 'PERSON',
          assigneeStaffProfileId: dbIds.staff,
        },
      });
      await tx.restaurantSopOccurrence.create({
        data: {
          id: dbIds.occurrence,
          assignmentId: dbIds.assignment,
          templateVersionId: dbIds.version,
          branchId: dbIds.branch,
          businessDate: new Date('2026-08-29T00:00:00.000Z'),
          status: 'IN_PROGRESS',
          dueAt: new Date('2026-08-29T12:00:00.000Z'),
          windowEndsAt: new Date('2026-08-30T12:00:00.000Z'),
          assignedStaffProfileId: dbIds.staff,
        },
      });
      await tx.restaurantSopOccurrenceStep.create({
        data: {
          id: dbIds.occurrenceStep,
          occurrenceId: dbIds.occurrence,
          templateStepId: dbIds.templateStep,
        },
      });
      await tx.organizationDepartment.create({ data: { key: 'ops', name: 'Operations' } });
      await tx.user.create({
        data: {
          id: userId,
          name: 'Session Operator',
          email: userId + '@test.invalid',
          department: 'ops',
          title: 'Operator',
        },
      });
      await tx.restaurantStaffProfile.update({ where: { id: dbIds.staff }, data: { userId } });
      await tx.restaurantStaffProfile.create({
        data: {
          id: approverId,
          displayName: 'Approving Manager',
          primaryBranchId: dbIds.branch,
        },
      });
      await tx.restaurantOperatorCredential.create({
        data: {
          id: credentialId,
          staffProfileId: approverId,
          type: 'PIN',
          credentialHash,
        },
      });
      await tx.restaurantStaffCapabilityGrant.create({
        data: {
          staffProfileId: approverId,
          branchId: dbIds.branch,
          capability: 'sop:verify',
          effect: 'ALLOW',
        },
      });
    });
  }, 30000);

  afterAll(async () => {
    if (!TEST_DATABASE_URL) return;
    const cleanup = new Client({ connectionString: TEST_DATABASE_URL });
    await cleanup.connect();
    try {
      await cleanup.query(`SET app.is_platform_admin = 'true'`);
      await cleanup.query(`DELETE FROM "organizations" WHERE "id" = $1`, [dbIds.organization]);
    } finally {
      await cleanup.end();
    }
  });

  async function caller(db = tenantDb(dbIds.organization)) {
    const { restaurantSopExecutionRouter } =
      await import('@/server/routers/restaurant-sop-execution');
    const { packageByKey } = await import('@/lib/vertical-catalog');
    const pkg = packageByKey('restaurant-enterprise')!;
    return restaurantSopExecutionRouter.createCaller({
      db,
      entitlements: {
        organizationId: dbIds.organization,
        enabledModules: [...pkg.moduleKeys],
        limits: { ...pkg.defaultLimits },
      },
      session: {
        expires: 'later',
        user: {
          id: userId,
          organizationId: dbIds.organization,
          role: 'EMPLOYEE',
          status: 'ACTIVE',
        },
      },
      organization: null,
      support: null,
      requestMeta: { ip: null, userAgent: null },
      audit: { detail: {} },
    } as never);
  }

  it('uses an unprivileged RLS runtime role', async () => {
    const rows = await tenantDb(dbIds.organization).$queryRawUnsafe<
      Array<{ rolsuper: boolean; rolbypassrls: boolean }>
    >('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  it('cannot complete another staff member’s occurrence by forging its owner', async () => {
    await tenantDb(dbIds.organization).restaurantSopOccurrence.update({
      where: { id: dbIds.occurrence },
      data: { assignedStaffProfileId: approverId },
    });
    const api = await caller();
    await expect(
      api.completeStep({
        occurrenceId: dbIds.occurrence,
        templateStepId: dbIds.templateStep,
        actorStaffProfileId: approverId,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const step = await tenantDb(dbIds.organization).restaurantSopOccurrenceStep.findUnique({
      where: { id: dbIds.occurrenceStep },
    });
    expect(step?.completed).toBe(false);
    await tenantDb(dbIds.organization).restaurantSopOccurrence.update({
      where: { id: dbIds.occurrence },
      data: { assignedStaffProfileId: dbIds.staff },
    });
    await api.completeStep({
      occurrenceId: dbIds.occurrence,
      templateStepId: dbIds.templateStep,
      actorStaffProfileId: approverId,
    });
    const completed = await tenantDb(dbIds.organization).restaurantSopOccurrenceStep.findUnique({
      where: { id: dbIds.occurrenceStep },
    });
    expect(completed?.completedByStaffProfileId).toBe(dbIds.staff);
  });

  const waiver = () => ({
    occurrenceId: dbIds.occurrence,
    actorStaffProfileId: approverId,
    approvingStaffProfileId: approverId,
    approvingType: 'PIN' as const,
    approvingSecret: '7264',
    reason: 'Approved exception',
  });

  it('persists failed PIN attempts despite an outer request rollback and enforces lockout', async () => {
    await tenantDb(dbIds.organization).restaurantSopOccurrence.update({
      where: { id: dbIds.occurrence },
      data: { status: 'MISSED' },
    });
    const api = await caller();
    const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
    for (let i = 0; i < 5; i++) {
      await expect(
        withTenantDb(dbIds.organization, async (db) => {
          // Match HTTP request behavior: a failed procedure aborts the enclosing transaction.
          const contextCaller = await caller(db);
          await contextCaller.waive({ ...waiver(), approvingSecret: '0000' });
        })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Approving credential is invalid or locked.',
      });
      const attempt = await tenantDb(dbIds.organization).restaurantOperatorCredential.findUnique({
        where: { id: credentialId },
      });
      expect(attempt?.failedAttempts).toBe(i < 4 ? i + 1 : 0);
    }
    const credential = await tenantDb(dbIds.organization).restaurantOperatorCredential.findUnique({
      where: { id: credentialId },
    });
    expect(credential?.failedAttempts).toBe(0);
    expect(credential?.lockedUntil).toBeInstanceOf(Date);
    await expect(api.waive(waiver())).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Approving credential is invalid or locked.',
    });
    expect(await tenantDb(dbIds.organization).restaurantCoAuthorization.count()).toBe(0);
  }, 30000);

  it('serializes concurrent bad PIN attempts into a durable lock', async () => {
    const db = tenantDb(dbIds.organization);
    await db.restaurantSopOccurrence.update({
      where: { id: dbIds.occurrence },
      data: { status: 'MISSED' },
    });
    await db.restaurantOperatorCredential.update({
      where: { id: credentialId },
      data: { failedAttempts: 0, lockedUntil: null },
    });
    const api = await caller();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => api.waive({ ...waiver(), approvingSecret: '0000' }))
    );
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    const credential = await db.restaurantOperatorCredential.findUnique({
      where: { id: credentialId },
    });
    expect(credential?.lockedUntil).toBeInstanceOf(Date);
    expect(credential?.failedAttempts).toBe(0);
    await expect(api.waive(waiver())).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Approving credential is invalid or locked.',
    });
    expect(await db.restaurantCoAuthorization.count()).toBe(0);
  }, 30000);

  it('rejects revoked and inactive approvers, then accepts a capable credential-proven manager', async () => {
    const db = tenantDb(dbIds.organization);
    const api = await caller();
    await db.restaurantSopOccurrence.update({
      where: { id: dbIds.occurrence },
      data: { status: 'MISSED' },
    });
    await db.restaurantOperatorCredential.update({
      where: { id: credentialId },
      data: { lockedUntil: null, failedAttempts: 0, revokedAt: new Date() },
    });
    await expect(api.waive(waiver())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await db.restaurantOperatorCredential.update({
      where: { id: credentialId },
      data: { revokedAt: null },
    });
    await db.restaurantStaffProfile.update({
      where: { id: approverId },
      data: { status: 'SUSPENDED' },
    });
    await expect(api.waive(waiver())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await db.restaurantStaffProfile.update({
      where: { id: approverId },
      data: { status: 'ACTIVE' },
    });
    await expect(api.waive(waiver())).resolves.toMatchObject({ action: 'WAIVE' });
    const record = await db.restaurantCoAuthorization.findFirst({
      where: { targetId: dbIds.occurrence },
    });
    expect(record).toMatchObject({
      actingStaffProfileId: dbIds.staff,
      approvingStaffProfileId: approverId,
    });
  }, 30000);
});
