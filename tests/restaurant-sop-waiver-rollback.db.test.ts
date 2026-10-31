/** Credential attempts must survive the real HTTP request's transaction rollback. */
import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedDepartments } from '@/lib/test-support/departments';
import type { TRPCContext } from '@/server/trpc';

const mocks = vi.hoisted(() => ({ actor: vi.fn(), host: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/lib/tenancy/host', async (original) => ({
  ...(await original<typeof import('@/lib/tenancy/host')>()),
  requireOrganizationForRequest: mocks.host,
}));
vi.mock('@/lib/abac', async (original) => ({
  ...(await original<typeof import('@/lib/abac')>()),
  can: async () => true,
}));
vi.mock('@/lib/entitlements', async (original) => ({
  ...(await original<typeof import('@/lib/entitlements')>()),
  resolveOrganizationEntitlements: async (organizationId: string) => {
    const { packageByKey } = await import('@/lib/vertical-catalog');
    const pkg = packageByKey('restaurant-enterprise')!;
    return {
      organizationId,
      enabledModules: [...pkg.moduleKeys],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
      limits: { ...pkg.defaultLimits },
    };
  },
}));
vi.mock('@/server/routers/_app', async () => {
  const { router, protectedProcedure } = await import('@/server/trpc');
  const { restaurantSopExecutionRouter } =
    await import('@/server/routers/restaurant-sop-execution');
  const { z } = await import('zod');
  return {
    appRouter: router({
      restaurantSopExecution: restaurantSopExecutionRouter,
      saveBranch: protectedProcedure
        .input(z.string())
        .mutation(({ ctx, input }) => ctx.db.restaurantBranch.create({ data: { name: input } })),
    }),
  };
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const suite = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const orgId = `org_waiver_rollback_${suffix}`;
const branchId = `branch_waiver_rollback_${suffix}`;
const userId = `user_waiver_rollback_${suffix}`;
const actorId = `actor_waiver_rollback_${suffix}`;
const approverId = `approver_waiver_rollback_${suffix}`;
const PIN = '728163';
let tenancy: typeof import('@/lib/tenancy/scoped-db');
let post: (request: Request) => Promise<Response>;
let flushAudits: () => Promise<void>;
let sequence = 0;

async function occurrence(status: 'MISSED' | 'SCHEDULED' = 'MISSED') {
  const id = `occ_waiver_rollback_${suffix}_${++sequence}`;
  await tenancy.withTenantDb(orgId, async (tx) => {
    const template = await tx.restaurantSopTemplate.create({
      data: { name: id, versions: { create: { versionNumber: 1, status: 'PUBLISHED' } } },
      include: { versions: true },
    });
    const assignment = await tx.restaurantSopAssignment.create({
      data: {
        branchId,
        templateId: template.id,
        frequency: 'ONCE',
        daysOfWeek: [],
        startDate: new Date('2026-10-01'),
        assigneeTargetType: 'PERSON',
        assigneeStaffProfileId: actorId,
      },
    });
    await tx.restaurantSopOccurrence.create({
      data: {
        id,
        branchId,
        assignmentId: assignment.id,
        templateVersionId: template.versions[0]!.id,
        businessDate: new Date('2026-10-01'),
        dueAt: new Date(),
        windowEndsAt: new Date(),
        assignedStaffProfileId: actorId,
        status,
      },
    });
  });
  return id;
}

const payload = (occurrenceId: string, secret = PIN) => ({
  occurrenceId,
  approving: { staffProfileId: approverId, type: 'PIN', secret },
  reason: 'Operational waiver',
});
async function batch(inputs: unknown[], paths = inputs.map(() => 'restaurantSopExecution.waive')) {
  const response = await post(
    new Request(`https://tenant.test/api/trpc/${paths.join(',')}?batch=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(inputs.map((input, i) => [i, { json: input }]))),
    })
  );
  return response.json();
}
const counters = () =>
  tenancy.withTenantDb(orgId, (tx) =>
    tx.restaurantOperatorCredential.findFirstOrThrow({
      where: { staffProfileId: approverId },
      select: { failedAttempts: true, lockedUntil: true },
    })
  );
const reset = (failedAttempts = 0) =>
  tenancy.withTenantDb(orgId, (tx) =>
    tx.restaurantOperatorCredential.updateMany({
      where: { staffProfileId: approverId },
      data: { failedAttempts, lockedUntil: null },
    })
  );

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  tenancy = await import('@/lib/tenancy/scoped-db');
  const { hashOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
  await tenancy.withPlatformDb(async (tx) => {
    const [role] = await tx.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    if (role.rolsuper || role.rolbypassrls)
      throw new Error('Use an unprivileged NOBYPASSRLS test role.');
    await tx.organization.create({
      data: {
        id: orgId,
        slug: orgId,
        legalName: 'Waiver rollback test',
        displayName: 'Waiver rollback test',
        status: 'ACTIVE',
      },
    });
    await seedDepartments(tx, [orgId], ['QUALITY']);
  });
  await tenancy.withTenantDb(orgId, async (tx) => {
    await tx.restaurantBranch.create({ data: { id: branchId, name: 'Waiver branch' } });
    await tx.user.create({
      data: {
        id: userId,
        name: 'Verifier',
        email: `${userId}@example.test`,
        department: 'QUALITY',
        title: 'Verifier',
        role: 'EMPLOYEE',
        status: 'ACTIVE',
      },
    });
    await tx.restaurantStaffProfile.createMany({
      data: [
        { id: actorId, userId, displayName: 'Actor', primaryBranchId: branchId },
        { id: approverId, displayName: 'Approver', primaryBranchId: branchId },
      ],
    });
    await tx.restaurantOperatorCredential.create({
      data: {
        staffProfileId: approverId,
        type: 'PIN',
        credentialHash: await hashOperatorCredential('PIN', PIN),
      },
    });
    await tx.restaurantStaffCapabilityGrant.create({
      data: {
        staffProfileId: approverId,
        branchId,
        capability: 'sop:verify',
      },
    });
  });
  const organization = { id: orgId, slug: orgId, status: 'ACTIVE' } as TRPCContext['organization'];
  const session = {
    expires: 'later',
    user: {
      id: userId,
      organizationId: orgId,
      status: 'ACTIVE',
      role: 'EMPLOYEE',
      department: 'QUALITY',
    },
  } as TRPCContext['session'];
  mocks.actor.mockResolvedValue({ organization, session, support: null });
  mocks.host.mockResolvedValue(organization);
  post = (await import('@/app/api/trpc/[trpc]/route')).POST;
  flushAudits = (await import('@/server/audit')).flushAuditWritesForTest;
}, 60_000);

afterEach(async () => {
  if (TEST_DATABASE_URL) await flushAudits();
});

suite('SOP waiver HTTP batch rollback (real PostgreSQL)', () => {
  it('retains failed attempts and lockout when a validation-failing sibling rolls back the batch', async () => {
    await reset();
    const id = await occurrence('SCHEDULED');
    for (let i = 0; i < 4; i++) {
      const result = await batch([payload(id, '000000'), { ...payload(id), extra: true }]);
      expect(result).toHaveLength(2);
      expect(result.every((entry: object) => 'error' in entry)).toBe(true);
    }
    expect(await counters()).toEqual({ failedAttempts: 4, lockedUntil: null });
    await batch([payload(id, '000000'), { ...payload(id), extra: true }]);
    const locked = await counters();
    expect(locked.failedAttempts).toBe(0);
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    const [correct] = await batch([payload(id)]);
    expect(correct.result.data.json).toEqual({ blocked: 'Waiver authorization failed.' });
  });

  it('commits authentication state even when the waiver itself returns a state error', async () => {
    await reset(2);
    const id = await occurrence('SCHEDULED');
    const [result] = await batch([payload(id)]);
    expect(result.error.json.data.code).toBe('CONFLICT');
    expect(await counters()).toEqual({ failedAttempts: 0, lockedUntil: null });
  });

  it('still rolls back all waiver records when a sibling fails', async () => {
    await reset();
    const id = await occurrence();
    const result = await batch([payload(id), { ...payload(id), extra: true }]);
    expect(result.every((entry: object) => 'error' in entry)).toBe(true);
    const stored = await tenancy.withTenantDb(orgId, async (tx) => ({
      occurrence: await tx.restaurantSopOccurrence.findUniqueOrThrow({ where: { id } }),
      verifications: await tx.restaurantSopVerification.count({ where: { occurrenceId: id } }),
      approvals: await tx.restaurantCoAuthorization.count({ where: { targetId: id } }),
    }));
    expect(stored.occurrence.status).toBe('MISSED');
    expect(stored.verifications).toBe(0);
    expect(stored.approvals).toBe(0);
    // Establish that the same fixture succeeds when the request can commit.
    const [retried] = await batch([payload(id)]);
    expect(retried.result.data.json).toMatchObject({ occurrenceId: id, action: 'WAIVE' });
    expect(
      await tenancy.withTenantDb(orgId, (tx) =>
        tx.restaurantSopOccurrence.findUniqueOrThrow({ where: { id }, select: { status: true } })
      )
    ).toEqual({ status: 'WAIVED' });
  });

  it('persists separate denial and success audit outcomes for batch siblings', async () => {
    await reset();
    const id = await occurrence();
    const name = `Saved sibling ${suffix}`;
    const result = await batch(
      [payload(id, '000000'), name],
      ['restaurantSopExecution.waive', 'saveBranch']
    );
    expect(result[0].result.data.json).toHaveProperty('blocked');
    expect(result[1].result.data.json.name).toBe(name);
    await flushAudits();
    const logs = await tenancy.withTenantDb(orgId, (tx) =>
      tx.auditLog.findMany({
        where: { actorId: userId },
        orderBy: { createdAt: 'desc' },
      })
    );
    expect(logs.find((log) => log.path === 'saveBranch')).toMatchObject({
      outcome: 'SUCCESS',
      input: name,
    });
    expect(logs.find((log) => log.path === 'restaurantSopExecution.waive')).toMatchObject({
      outcome: 'FAILURE',
    });
    expect(JSON.stringify(logs)).not.toContain(PIN);
    expect(JSON.stringify(logs)).not.toContain('000000');
  });
});
