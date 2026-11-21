/**
 * End-to-end terminal transport, against a REAL PostgreSQL, driving the actual
 * route handlers exactly as an HTTP request would.
 *
 * These are the M2-L3 named integration checks that only a database can
 * establish: the C5 per-call revalidation (a device revoked MID-SESSION is
 * rejected on the very next call, and a post-revocation replay of a still-"valid"
 * session token is refused), the C6 operator state machine (unlock → switch →
 * lock), the C7 co-authorization evidence (acting + approving pinned, self-
 * approval refused), and the C4 durable lockout (five failures lock the
 * credential across calls).
 *
 * Requires TEST_DATABASE_URL (a migrated, throwaway database, never
 * DATABASE_URL); without it the suite reports itself skipped rather than passing
 * vacuously. One per-run-unique organization; every read filters by id, so it is
 * valid on a superuser TEST_DATABASE_URL too. No Auth.js is involved — the
 * terminal transport is device-authenticated, not NextAuth.
 */
import { createHash, randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePlatformModule, seedDepartments } from '@/lib/test-support/departments';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha22_term_${suffix}`;
const branchId = `branch_${suffix}`;
const otherOrgId = `org_wha149_other_${suffix}`;
const OTHER_BRANCH_STAFF = { id: `staff_other_branch_${suffix}`, pin: '333333' };
const FOREIGN_STAFF = { id: `staff_foreign_${suffix}`, pin: '444444' };
const STAFF = {
  A: { id: `staff_a_${suffix}`, pin: '111111' },
  B: { id: `staff_b_${suffix}`, pin: '222222' },
  M: { id: `staff_m_${suffix}`, pin: '999999' },
  L: { id: `staff_l_${suffix}`, pin: '555555' },
};

type RouteModule = { POST: (request: Request) => Promise<Response> };
type GetRouteModule = { GET: (request: Request) => Promise<Response> };

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  enrollDevice: (typeof import('@/lib/restaurant/devices'))['enrollDevice'];
  revokeDevice: (typeof import('@/lib/restaurant/devices'))['revokeDevice'];
  endSession: (typeof import('@/lib/restaurant/terminal-session'))['endSession'];
  flushAuditWrites: (typeof import('@/server/audit'))['flushAuditWritesForTest'];
  routes: {
    establish: RouteModule;
    unlock: RouteModule;
    switchOperator: RouteModule;
    lock: RouteModule;
    coAuthorize: RouteModule;
    heartbeat: RouteModule;
    operators: GetRouteModule;
  };
};

let deps: Deps;

function createLinkedAccount(tx: import('@/lib/tenancy/scoped-db').ScopedDb) {
  return tx.user.create({
    data: {
      name: 'Linked cashier',
      email: randomBytes(12).toString('hex') + '@test.invalid',
      department: 'OPERATIONS',
      title: 'Cashier',
    },
  });
}

async function call(
  route: RouteModule,
  opts: { secret?: string; session?: string; body?: unknown }
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.secret) headers.authorization = `Bearer ${opts.secret}`;
  if (opts.session) headers['x-terminal-session'] = opts.session;
  const request = new Request('https://tenant.test/api/restaurant/terminal', {
    method: 'POST',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res = await route.POST(request);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/** Enroll a fresh device (isolates per-test rate-limit keys and revocation). */
async function enroll(name: string): Promise<{ deviceId: string; secret: string }> {
  const { device, secret } = await deps.withTenantDb(orgId, (tx) =>
    deps.enrollDevice(tx, { branchId, name })
  );
  return { deviceId: device.id, secret };
}

/** Establish a session on a device and return the one-time session token + id. */
async function establish(secret: string): Promise<{ token: string; sessionId: string }> {
  const res = await call(deps.routes.establish, { secret });
  expect(res.status).toBe(201);
  const session = res.json.session as { id: string };
  return { token: res.json.sessionToken as string, sessionId: session.id };
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [
    scopedDb,
    devices,
    session,
    credentials,
    audit,
    establishR,
    unlockR,
    switchR,
    lockR,
    coAuthR,
    heartbeatR,
    operatorsR,
  ] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/restaurant/devices'),
    import('@/lib/restaurant/terminal-session'),
    import('@/lib/restaurant/operator-credentials'),
    import('@/server/audit'),
    import('@/app/api/restaurant/terminal/establish/route'),
    import('@/app/api/restaurant/terminal/unlock/route'),
    import('@/app/api/restaurant/terminal/switch/route'),
    import('@/app/api/restaurant/terminal/lock/route'),
    import('@/app/api/restaurant/terminal/co-authorize/route'),
    import('@/app/api/restaurant/terminal/heartbeat/route'),
    import('@/app/api/restaurant/terminal/operators/route'),
  ]);

  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    enrollDevice: devices.enrollDevice,
    revokeDevice: devices.revokeDevice,
    endSession: session.endSession,
    flushAuditWrites: audit.flushAuditWritesForTest,
    routes: {
      establish: establishR,
      unlock: unlockR,
      switchOperator: switchR,
      lock: lockR,
      coAuthorize: coAuthR,
      heartbeat: heartbeatR,
      operators: operatorsR,
    },
  };

  // A minimal, ACTIVE organization so the transport's org-status gate passes.
  await deps.withPlatformDb(async (tx) => {
    await tx.organization.createMany({
      data: [
        {
          id: orgId,
          slug: `wha22-term-${suffix}`,
          legalName: 'Terminal Test Co',
          displayName: 'Terminal Test',
          status: 'ACTIVE',
        },
        {
          id: otherOrgId,
          slug: `wha149-other-${suffix}`,
          legalName: 'Other Tenant Co',
          displayName: 'Other Tenant',
          status: 'ACTIVE',
        },
      ],
    });
    const posModule = await ensurePlatformModule(tx, 'restaurant-pos', {
      name: 'POS',
      category: 'Operations',
    });
    await tx.organizationModule.createMany({
      data: [
        { organizationId: orgId, moduleId: posModule.id },
        { organizationId: otherOrgId, moduleId: posModule.id },
      ],
    });
  });

  await deps.withTenantDb(orgId, async (tx) => {
    await seedDepartments(tx, [orgId], ['OPERATIONS']);
    await tx.restaurantBranch.create({ data: { id: branchId, name: 'Main' } });
    for (const staff of Object.values(STAFF)) {
      await tx.restaurantStaffProfile.create({
        data: {
          id: staff.id,
          displayName: staff.id,
          primaryBranchId: branchId,
          status: 'ACTIVE',
        },
      });
      await tx.restaurantOperatorCredential.create({
        data: {
          staffProfileId: staff.id,
          type: 'PIN',
          credentialHash: await credentials.hashOperatorCredential('PIN', staff.pin),
        },
      });
    }
    await tx.restaurantStaffCapabilityGrant.createMany({
      data: [
        ...Object.values(STAFF).map(({ id }) => ({
          staffProfileId: id,
          branchId,
          capability: 'pos:operate',
        })),
        { staffProfileId: STAFF.A.id, branchId, capability: 'orders:take' },
        { staffProfileId: STAFF.B.id, branchId, capability: 'orders:take' },
        { staffProfileId: STAFF.M.id, branchId, capability: 'coauth:approve' },
      ],
    });
    const { device } = await deps.enrollDevice(tx, { branchId, name: 'Approval order fixture' });
    await tx.restaurantOrder.createMany({
      data: [`ord_${suffix}`, `ord_audit_${suffix}`, `sole_owner_order_${suffix}`].map(
        (id, index) => ({
          id,
          branchId,
          orderNumber: index + 1,
          businessDate: new Date(),
          channel: 'TAKEAWAY' as const,
          status: 'OPEN' as const,
          staffProfileId: STAFF.A.id,
          deviceId: device.id,
        })
      ),
    });
    const otherBranchId = `branch_other_${suffix}`;
    await tx.restaurantBranch.create({ data: { id: otherBranchId, name: 'Other branch' } });
    await tx.restaurantStaffProfile.createMany({
      data: [
        {
          id: OTHER_BRANCH_STAFF.id,
          displayName: 'Other Branch Operator',
          primaryBranchId: otherBranchId,
          status: 'ACTIVE',
        },
        {
          id: `staff_inactive_${suffix}`,
          displayName: 'Inactive Operator',
          primaryBranchId: branchId,
          status: 'SUSPENDED',
        },
      ],
    });
    for (const staffProfileId of [OTHER_BRANCH_STAFF.id, `staff_inactive_${suffix}`]) {
      await tx.restaurantOperatorCredential.create({
        data: {
          staffProfileId,
          type: 'PIN',
          credentialHash: await credentials.hashOperatorCredential(
            'PIN',
            staffProfileId === OTHER_BRANCH_STAFF.id ? OTHER_BRANCH_STAFF.pin : '333333'
          ),
        },
      });
    }
  });

  await deps.withTenantDb(otherOrgId, async (tx) => {
    const foreignBranchId = `branch_foreign_${suffix}`;
    await tx.restaurantBranch.create({ data: { id: foreignBranchId, name: 'Foreign branch' } });
    const foreign = await tx.restaurantStaffProfile.create({
      data: {
        id: FOREIGN_STAFF.id,
        displayName: 'Foreign Operator',
        primaryBranchId: foreignBranchId,
        status: 'ACTIVE',
      },
    });
    await tx.restaurantOperatorCredential.create({
      data: {
        staffProfileId: foreign.id,
        type: 'PIN',
        credentialHash: await credentials.hashOperatorCredential('PIN', FOREIGN_STAFF.pin),
      },
    });
  });
});

// Unlock/lockout journeys perform multiple real production-cost bcrypt checks.
describeIfDatabase('terminal transport end-to-end (real DB)', { timeout: 30_000 }, () => {
  it('returns the authenticated non-secret organization and branch scope', async () => {
    const { secret } = await enroll('branch-name');
    const response = await call(deps.routes.establish, { secret });

    expect(response.status).toBe(201);
    expect(response.json.device).toEqual(
      expect.objectContaining({ branchName: 'Main', organizationId: orgId, branchId })
    );
  });

  it('returns only active, credentialed operators from the device branch', async () => {
    const { secret } = await enroll('directory');
    const { token } = await establish(secret);
    const request = new Request('https://tenant.test/api/restaurant/terminal/operators', {
      headers: { authorization: `Bearer ${secret}`, 'x-terminal-session': token },
    });

    const response = await deps.routes.operators.GET(request);
    const body = (await response.json()) as {
      operators: {
        staffProfileId: string;
        displayName: string;
        role: string;
        canApprove: boolean;
        canSelfApprove: boolean;
      }[];
    };

    expect(response.status).toBe(200);
    expect(body.operators.map((operator) => operator.staffProfileId).sort()).toEqual(
      Object.values(STAFF)
        .map((staff) => staff.id)
        .sort()
    );
    for (const operator of body.operators) {
      expect(Object.keys(operator).sort()).toEqual(
        ['staffProfileId', 'displayName', 'role', 'canApprove', 'canSelfApprove'].sort()
      );
      expect(operator.canSelfApprove).toBe(false);
    }
    expect(JSON.stringify(body)).not.toContain('Other Branch Operator');
    expect(JSON.stringify(body)).not.toContain('Inactive Operator');
    expect(JSON.stringify(body)).not.toContain('Foreign Operator');
  });

  it('establishes, unlocks, switches operator, and locks (C6 state machine)', async () => {
    const { secret } = await enroll('lifecycle');
    const { token } = await establish(secret);

    const locked = await call(deps.routes.heartbeat, { secret, session: token });
    expect(locked.status).toBe(200);
    expect((locked.json.session as { state: string }).state).toBe('LOCKED');

    const unlocked = await call(deps.routes.unlock, {
      secret,
      session: token,
      body: { staffProfileId: STAFF.A.id, type: 'PIN', secret: STAFF.A.pin },
    });
    expect(unlocked.status).toBe(200);
    expect((unlocked.json.session as { activeStaffProfileId: string }).activeStaffProfileId).toBe(
      STAFF.A.id
    );

    // Unlocking an already-unlocked terminal is a 409 (use switch instead).
    const reUnlock = await call(deps.routes.unlock, {
      secret,
      session: token,
      body: { staffProfileId: STAFF.B.id, type: 'PIN', secret: STAFF.B.pin },
    });
    expect(reUnlock.status).toBe(409);

    const switched = await call(deps.routes.switchOperator, {
      secret,
      session: token,
      body: { staffProfileId: STAFF.B.id, type: 'PIN', secret: STAFF.B.pin },
    });
    expect(switched.status).toBe(200);
    expect((switched.json.session as { activeStaffProfileId: string }).activeStaffProfileId).toBe(
      STAFF.B.id
    );

    const relocked = await call(deps.routes.lock, { secret, session: token });
    expect(relocked.status).toBe(200);
    expect((relocked.json.session as { state: string }).state).toBe('LOCKED');
  });

  it('enforces the authenticated device branch for unlock and operator switch', async () => {
    const { secret } = await enroll('branch-eligibility');
    const { token } = await establish(secret);

    for (const operator of [OTHER_BRANCH_STAFF, FOREIGN_STAFF]) {
      const rejectedUnlock = await call(deps.routes.unlock, {
        secret,
        session: token,
        body: { staffProfileId: operator.id, type: 'PIN', secret: operator.pin },
      });
      expect(rejectedUnlock).toMatchObject({
        status: 401,
        json: { error: 'Invalid operator credential.' },
      });
    }

    const unlocked = await call(deps.routes.unlock, {
      secret,
      session: token,
      body: { staffProfileId: STAFF.A.id, type: 'PIN', secret: STAFF.A.pin },
    });
    expect(unlocked.status).toBe(200);

    for (const operator of [OTHER_BRANCH_STAFF, FOREIGN_STAFF]) {
      const rejectedSwitch = await call(deps.routes.switchOperator, {
        secret,
        session: token,
        body: { staffProfileId: operator.id, type: 'PIN', secret: operator.pin },
      });
      expect(rejectedSwitch).toMatchObject({
        status: 401,
        json: { error: 'Invalid operator credential.' },
      });
    }

    const switched = await call(deps.routes.switchOperator, {
      secret,
      session: token,
      body: { staffProfileId: STAFF.B.id, type: 'PIN', secret: STAFF.B.pin },
    });
    expect(switched.status).toBe(200);
    expect((switched.json.session as { activeStaffProfileId: string }).activeStaffProfileId).toBe(
      STAFF.B.id
    );
  });

  it.each(['status', 'branch', 'grant'] as const)(
    'ends only the affected operator session immediately after a %s edit',
    async (change) => {
      const { deviceId } = await enroll(`kitchen-access-${change}`);
      await deps.withTenantDb(orgId, async (tx) => {
        const profile = await tx.restaurantStaffProfile.create({
          data: { displayName: 'Access fixture', primaryBranchId: branchId },
        });
        const grant = await tx.restaurantStaffCapabilityGrant.create({
          data: { staffProfileId: profile.id, branchId, capability: 'kitchen:operate' },
        });
        const lastActivityAt = new Date('2026-01-01T00:00:00Z');
        const session = await tx.restaurantTerminalSession.create({
          data: {
            deviceId,
            activeStaffProfileId: profile.id,
            lastActivityAt,
            tokenHash: randomBytes(32).toString('hex'),
          },
        });
        const other = await tx.restaurantTerminalSession.create({
          data: {
            deviceId,
            activeStaffProfileId: STAFF.B.id,
            lastActivityAt,
            tokenHash: randomBytes(32).toString('hex'),
          },
        });
        if (change === 'grant')
          await tx.restaurantStaffCapabilityGrant.delete({ where: { id: grant.id } });
        else
          await tx.restaurantStaffProfile.update({
            where: { id: profile.id },
            data:
              change === 'status'
                ? { status: 'SUSPENDED' }
                : { primaryBranchId: `branch_other_${suffix}` },
          });
        expect(
          await tx.restaurantTerminalSession.findUniqueOrThrow({ where: { id: session.id } })
        ).toMatchObject({ activeStaffProfileId: null, endedAt: expect.any(Date), lastActivityAt });
        expect(
          await tx.restaurantTerminalSession.findUniqueOrThrow({ where: { id: other.id } })
        ).toMatchObject({ activeStaffProfileId: STAFF.B.id, endedAt: null, lastActivityAt });
        await tx.restaurantStaffProfile.update({
          where: { id: profile.id },
          data: { status: 'ARCHIVED' },
        });
      });
    }
  );

  it.each([
    'job role holding',
    'job role deletion',
    'job role activation',
    'job role permission',
    'organization role',
    'organization role permission',
    'role permission writer',
    'user override',
    'user override expiry',
    'staff user link',
  ] as const)(
    'ends a binding only on loss of effective terminal access through %s',
    async (source) => {
      const { deviceId } = await enroll('rights-' + source);
      await deps.withTenantDb(orgId, async (tx) => {
        const tag = randomBytes(6).toString('hex');
        const amount = 'payments:collect';
        const role = await tx.organizationRole.create({
          data: { key: 'role-' + tag, name: 'Role ' + tag },
        });
        const user = await tx.user.create({
          data: {
            name: 'Test cashier',
            email: tag + '@local.test',
            department: 'OPERATIONS',
            title: 'Cashier',
            organizationRoleId: role.id,
          },
        });
        const staff = await tx.restaurantStaffProfile.create({
          data: { displayName: 'Test cashier', primaryBranchId: branchId, userId: user.id },
        });
        const scope = { staffProfileId: staff.id, branchId };
        const job = await tx.restaurantJobRole.create({
          data: { key: tag, name: 'Cashier ' + tag },
        });
        const holding = await tx.restaurantStaffJobRole.create({
          data: { ...scope, jobRoleId: job.id },
        });
        await tx.restaurantStaffCapabilityGrant.create({
          data: { ...scope, capability: 'pos:operate' },
        });
        const session = await tx.restaurantTerminalSession.create({
          data: {
            deviceId,
            activeStaffProfileId: staff.id,
            tokenHash: randomBytes(32).toString('hex'),
          },
        });
        const snapshot = () =>
          tx.restaurantTerminalSession.findUniqueOrThrow({ where: { id: session.id } });
        const open = {
          activeStaffProfileId: staff.id,
          endedAt: null,
          lastActivityAt: session.lastActivityAt,
        };
        const otherStaff = await tx.restaurantStaffProfile.create({
          data: {
            displayName: 'Second cashier',
            primaryBranchId: branchId,
            directCapabilityGrants: { create: { branchId, capability: 'pos:operate' } },
          },
        });
        const other = await tx.restaurantTerminalSession.create({
          data: {
            deviceId,
            activeStaffProfileId: otherStaff.id,
            tokenHash: randomBytes(32).toString('hex'),
          },
        });
        // Neither granting, reaffirming an existing permission, losing a duplicate
        // grant nor an unrelated back-office permission change retires the binding.
        const jobPermission = await tx.restaurantJobRoleCapability.create({
          data: { jobRoleId: job.id, capability: amount },
        });
        const rolePermission = await tx.organizationRolePermission.create({
          data: { organizationRoleId: role.id, capability: amount, effect: 'ALLOW' },
        });
        const unrelated = await tx.userPermissionOverride.create({
          data: {
            userId: user.id,
            capability: 'finance:manage',
            effect: 'ALLOW',
            reason: 'Fixture',
          },
        });
        await tx.userPermissionOverride.update({
          where: { id: unrelated.id },
          data: { effect: 'DENY' },
        });
        await tx.restaurantJobRole.update({
          where: { id: job.id },
          data: { name: 'New name ' + tag },
        });
        if (source.startsWith('job role')) {
          await tx.organizationRolePermission.delete({ where: { id: rolePermission.id } });
          expect(await snapshot()).toMatchObject(open);
          if (source === 'job role deletion') {
            // A second holder keeps the same right through an independent grant.
            await tx.restaurantStaffJobRole.create({
              data: { staffProfileId: otherStaff.id, branchId, jobRoleId: job.id },
            });
            await tx.restaurantStaffCapabilityGrant.create({
              data: { staffProfileId: otherStaff.id, branchId, capability: amount },
            });
            await tx.restaurantJobRole.delete({ where: { id: job.id } });
            expect(await tx.restaurantStaffJobRole.count({ where: { jobRoleId: job.id } })).toBe(0);
          }
          if (source === 'job role holding')
            await tx.restaurantStaffJobRole.delete({ where: { id: holding.id } });
          if (source === 'job role activation')
            await tx.restaurantJobRole.update({ where: { id: job.id }, data: { active: false } });
          if (source === 'job role permission') {
            const { setJobRoleCapabilities } = await import('./job-roles');
            await setJobRoleCapabilities(tx, job.id, ['payments:*']);
            expect(await snapshot()).toMatchObject(open);
            await setJobRoleCapabilities(tx, job.id, []);
          }
        } else {
          await tx.restaurantJobRoleCapability.delete({ where: { id: jobPermission.id } });
          expect(await snapshot()).toMatchObject(open);
          if (source === 'organization role') {
            const wider = await tx.organizationRole.create({
              data: {
                key: 'wider-' + tag,
                name: 'Wider ' + tag,
                permissions: {
                  create: [{ capability: 'payments:*' }, { capability: 'orders:take' }],
                },
              },
            });
            await tx.user.update({
              where: { id: user.id },
              data: { organizationRoleId: wider.id },
            });
            expect(await snapshot()).toMatchObject(open);
            await tx.user.update({ where: { id: user.id }, data: { organizationRoleId: role.id } });
          }
          if (source === 'organization role permission')
            await tx.organizationRolePermission.update({
              where: { id: rolePermission.id },
              data: { effect: 'DENY' },
            });
          if (source === 'role permission writer') {
            const { replaceRolePermissions } = await import('@/lib/organization-role');
            const mixed = [
              { capability: 'payments:*', effect: 'ALLOW' as const },
              { capability: 'payments:refund', effect: 'DENY' as const },
            ];
            await replaceRolePermissions(tx, orgId, role.id, [rolePermission], mixed);
            expect(await snapshot()).toMatchObject(open);
            await replaceRolePermissions(tx, orgId, role.id, mixed, [
              { capability: 'payments:refund', effect: 'ALLOW' },
            ]);
          }
          if (source === 'staff user link')
            await tx.restaurantStaffProfile.update({
              where: { id: staff.id },
              data: { userId: null },
            });
          if (source === 'user override expiry') {
            const override = await tx.userPermissionOverride.create({
              data: {
                userId: user.id,
                capability: amount,
                effect: 'ALLOW',
                reason: 'Temporary register coverage',
              },
            });
            await tx.organizationRolePermission.delete({ where: { id: rolePermission.id } });
            await tx.userPermissionOverride.update({
              where: { id: override.id },
              data: { expiresAt: new Date(Date.now() + 86_400_000) },
            });
            expect(await snapshot()).toMatchObject(open);
            await tx.userPermissionOverride.update({
              where: { id: override.id },
              data: { expiresAt: new Date(Date.now() - 86_400_000) },
            });
          }
          if (source === 'user override') {
            await tx.userPermissionOverride.create({
              data: {
                userId: user.id,
                capability: 'payments:*',
                effect: 'DENY',
                reason: 'Withdraw tender access',
              },
            });
          }
        }
        expect(await snapshot()).toMatchObject({
          activeStaffProfileId: null,
          endedAt: expect.any(Date),
          lastActivityAt: session.lastActivityAt,
        });
        expect(
          await tx.restaurantTerminalSession.findUniqueOrThrow({ where: { id: other.id } })
        ).toMatchObject({
          activeStaffProfileId: otherStaff.id,
          endedAt: null,
          lastActivityAt: other.lastActivityAt,
        });
      });
    }
  );

  it.each(['staff', 'linked user', 'organization role'] as const)(
    'compares all %s rules in a single insert, including overlapping wildcards and denies',
    async (source) => {
      const { deviceId } = await enroll('bulk-' + source);
      await deps.withTenantDb(orgId, async (tx) => {
        const tag = randomBytes(6).toString('hex');
        const role = await tx.organizationRole.create({ data: { key: tag, name: 'Bulk ' + tag } });
        const user = await tx.user.create({
          data: {
            name: 'Bulk cashier',
            email: tag + '@local.test',
            department: 'OPERATIONS',
            title: 'Cashier',
            organizationRoleId: role.id,
          },
        });
        const staff = await tx.restaurantStaffProfile.create({
          data: { displayName: 'Bulk cashier', primaryBranchId: branchId, userId: user.id },
        });
        const store = (rows: { capability: string; effect: 'ALLOW' | 'DENY' }[]) => {
          if (source === 'staff')
            return tx.restaurantStaffCapabilityGrant.createMany({
              data: rows.map((row) => ({ ...row, staffProfileId: staff.id, branchId })),
            });
          if (source === 'linked user')
            return tx.userPermissionOverride.createMany({
              data: rows.map((row) => ({ ...row, userId: user.id, reason: 'Test edit' })),
            });
          return tx.organizationRolePermission.createMany({
            data: rows.map((row) => ({ ...row, organizationRoleId: role.id })),
          });
        };
        await store([{ capability: 'pos:operate', effect: 'ALLOW' }]);
        const session = await tx.restaurantTerminalSession.create({
          data: {
            deviceId,
            activeStaffProfileId: staff.id,
            tokenHash: randomBytes(32).toString('hex'),
          },
        });
        const binding = () =>
          tx.restaurantTerminalSession.findUniqueOrThrow({ where: { id: session.id } });
        await store([
          { capability: 'payments:*', effect: 'ALLOW' },
          { capability: 'payments:refund', effect: 'DENY' },
        ]);
        expect(await binding()).toMatchObject({
          activeStaffProfileId: staff.id,
          endedAt: null,
          lastActivityAt: session.lastActivityAt,
        });
        // Deny an inherited order-taking right at both wildcard and exact scope,
        // on a separate source so both rows are newly inserted.
        await tx.restaurantJobRole.create({
          data: {
            key: 'ord-' + tag,
            name: 'Order ' + tag,
            capabilities: { create: { capability: 'orders:take' } },
            holdings: { create: { staffProfileId: staff.id, branchId } },
          },
        });
        await store([
          { capability: 'orders:*', effect: 'DENY' },
          { capability: 'orders:take', effect: 'DENY' },
        ]);
        expect(await binding()).toMatchObject({
          activeStaffProfileId: null,
          endedAt: expect.any(Date),
          lastActivityAt: session.lastActivityAt,
        });
      });
    }
  );

  it.each(['PIN reset', 'PIN revocation', 'deactivation', 'linked account on leave'] as const)(
    'ends every bound session in the same transaction as %s',
    async (change) => {
      const first = await enroll('control-a-' + change);
      const second = await enroll('control-b-' + change);
      const { rotateOperatorCredential, revokeOperatorCredential, issueOperatorCredential } =
        await import('./credential-lifecycle');
      const fixture = await deps.withTenantDb(orgId, async (tx) => {
        const user = change === 'linked account on leave' ? await createLinkedAccount(tx) : null;
        const staff = await tx.restaurantStaffProfile.create({
          data: { displayName: 'Credential fixture', primaryBranchId: branchId, userId: user?.id },
        });
        const credential = await issueOperatorCredential(tx, {
          staffProfileId: staff.id,
          type: 'PIN',
          secret: '381794',
        });
        const sessions = await Promise.all(
          [first, second].map((device) =>
            tx.restaurantTerminalSession.create({
              data: {
                deviceId: device.deviceId,
                activeStaffProfileId: staff.id,
                tokenHash: randomBytes(32).toString('hex'),
              },
            })
          )
        );
        return { staff, credential, sessions };
      });
      const verifyChange = async (rollback: boolean) =>
        deps.withTenantDb(orgId, async (tx) => {
          await tx.restaurantOperatorCredential.update({
            where: { id: fixture.credential.id },
            data: { failedAttempts: 1 },
          });
          expect(
            await tx.restaurantTerminalSession.count({
              where: { activeStaffProfileId: fixture.staff.id, endedAt: null },
            })
          ).toBe(2);
          if (change === 'PIN reset')
            await rotateOperatorCredential(tx, {
              credentialId: fixture.credential.id,
              secret: '391872',
            });
          else if (change === 'PIN revocation')
            await revokeOperatorCredential(tx, { credentialId: fixture.credential.id });
          else if (change === 'linked account on leave')
            await tx.user.update({
              where: { id: fixture.staff.userId! },
              data: { status: 'ON_LEAVE' },
            });
          else
            await tx.restaurantStaffProfile.update({
              where: { id: fixture.staff.id },
              data: { status: 'SUSPENDED' },
            });
          for (const session of fixture.sessions)
            expect(
              await tx.restaurantTerminalSession.findUniqueOrThrow({ where: { id: session.id } })
            ).toMatchObject({
              activeStaffProfileId: null,
              endedAt: expect.any(Date),
              lastActivityAt: session.lastActivityAt,
            });
          if (rollback) throw new Error('Rollback synthetic access edit');
        });
      await expect(verifyChange(true)).rejects.toThrow('Rollback synthetic access edit');
      await verifyChange(false);
    }
  );

  it.each(['PIN reset', 'deactivation', 'linked account deactivation'] as const)(
    'rejects an in-flight handover when %s finishes before binding',
    async (change) => {
      const { secret } = await enroll('credential-race-' + change);
      const { token, sessionId } = await establish(secret);
      const { issueOperatorCredential, rotateOperatorCredential } =
        await import('./credential-lifecycle');
      const incoming = await deps.withTenantDb(orgId, async (tx) => {
        const user =
          change === 'linked account deactivation' ? await createLinkedAccount(tx) : null;
        const staff = await tx.restaurantStaffProfile.create({
          data: { displayName: 'Incoming operator', primaryBranchId: branchId, userId: user?.id },
        });
        await tx.restaurantStaffCapabilityGrant.create({
          data: { staffProfileId: staff.id, branchId, capability: 'pos:operate' },
        });
        const credential = await issueOperatorCredential(tx, {
          staffProfileId: staff.id,
          type: 'PIN',
          secret: '392815',
        });
        return { staff, credential };
      });
      expect(
        (
          await call(deps.routes.unlock, {
            secret,
            session: token,
            body: { staffProfileId: STAFF.A.id, type: 'PIN', secret: STAFF.A.pin },
          })
        ).status
      ).toBe(200);
      const binding = () =>
        deps.withTenantDb(orgId, (tx) =>
          tx.restaurantTerminalSession.findUniqueOrThrow({ where: { id: sessionId } })
        );
      const before = await binding();
      let handover: ReturnType<typeof call> | undefined;
      await deps.withTenantDb(orgId, async (tx) => {
        if (change === 'PIN reset')
          await rotateOperatorCredential(tx, {
            credentialId: incoming.credential.id,
            secret: '283951',
          });
        else if (change === 'linked account deactivation')
          await tx.user.update({
            where: { id: incoming.staff.userId! },
            data: { status: 'INACTIVE' },
          });
        else
          await tx.restaurantStaffProfile.update({
            where: { id: incoming.staff.id },
            data: { status: 'SUSPENDED' },
          });
        handover = call(deps.routes.switchOperator, {
          secret,
          session: token,
          body: { staffProfileId: incoming.staff.id, type: 'PIN', secret: '392815' },
        });
        // Wait for the real request to reach the rows held by this transaction.
        const deadline = Date.now() + 5000;
        for (;;) {
          const [state] = await tx.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS (
          SELECT FROM pg_stat_activity a WHERE pg_backend_pid() = ANY(pg_blocking_pids(a.pid))
        ) AS waiting`;
          if (state.waiting) break;
          if (Date.now() > deadline) throw new Error('Handover did not reach the binding check');
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
      });
      expect((await handover!).status).toBe(401);
      expect(await binding()).toMatchObject({
        activeStaffProfileId: STAFF.A.id,
        endedAt: null,
        lastActivityAt: before.lastActivityAt,
      });
    },
    12000
  );

  it('ends only the linked operator’s sessions on SCIM deactivation and permits a fresh unlock after reactivation', async () => {
    const directoryToken = 'scim_' + randomBytes(24).toString('hex');
    await deps.withPlatformDb(async (tx) => {
      const module = await ensurePlatformModule(tx, 'scim', { name: 'SCIM', category: 'Identity' });
      await tx.organizationModule.create({ data: { organizationId: orgId, moduleId: module.id } });
    });
    const { issueOperatorCredential } = await import('./credential-lifecycle');
    const fixture = await deps.withTenantDb(orgId, async (tx) => {
      await tx.organizationScimToken.create({
        data: {
          organizationId: orgId,
          name: 'Local directory',
          prefix: directoryToken.slice(0, 12),
          tokenHash: createHash('sha256').update(directoryToken).digest('hex'),
        },
      });
      const user = await createLinkedAccount(tx);
      const staff = await tx.restaurantStaffProfile.create({
        data: { primaryBranchId: branchId, userId: user.id, displayName: 'Directory cashier' },
      });
      await tx.restaurantStaffCapabilityGrant.create({
        data: { staffProfileId: staff.id, branchId, capability: 'pos:operate' },
      });
      await issueOperatorCredential(tx, {
        staffProfileId: staff.id,
        type: 'PIN',
        secret: '673914',
      });
      return { user, staff };
    });
    const device = await enroll('directory cashier');
    const otherDevice = await enroll('unrelated cashier');
    const original = await establish(device.secret);
    const other = await establish(otherDevice.secret);
    const unlock = (token: string) =>
      call(deps.routes.unlock, {
        secret: device.secret,
        session: token,
        body: { staffProfileId: fixture.staff.id, type: 'PIN', secret: '673914' },
      });
    expect((await unlock(original.token)).status).toBe(200);
    expect(
      (
        await call(deps.routes.unlock, {
          secret: otherDevice.secret,
          session: other.token,
          body: { staffProfileId: STAFF.A.id, type: 'PIN', secret: STAFF.A.pin },
        })
      ).status
    ).toBe(200);
    const read = (id: string) =>
      deps.withTenantDb(orgId, (tx) =>
        tx.restaurantTerminalSession.findUniqueOrThrow({ where: { id } })
      );
    const before = await read(original.sessionId);
    const otherBefore = await read(other.sessionId);
    const { PATCH } = await import('@/app/api/scim/v2/Users/[id]/route');
    const setActive = (active: boolean) =>
      PATCH(
        new Request('https://tenant.test/api/scim/v2/Users/' + fixture.user.id, {
          method: 'PATCH',
          headers: {
            authorization: 'Bearer ' + directoryToken,
            'content-type': 'application/scim+json',
          },
          body: JSON.stringify({
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [{ op: 'replace', path: 'active', value: active }],
          }),
        }),
        { params: Promise.resolve({ id: fixture.user.id }) }
      );
    expect((await setActive(true)).status).toBe(200);
    expect(await read(original.sessionId)).toEqual(before);
    expect((await setActive(false)).status).toBe(200);
    const ended = await read(original.sessionId);
    expect(ended).toMatchObject({
      endedAt: expect.any(Date),
      activeStaffProfileId: null,
      lastActivityAt: before.lastActivityAt,
    });
    expect(await read(other.sessionId)).toEqual(otherBefore);
    const fresh = await establish(device.secret);
    expect((await unlock(fresh.token)).status).toBe(401);
    expect((await setActive(true)).status).toBe(200);
    expect(await read(original.sessionId)).toEqual(ended);
    expect((await unlock(fresh.token)).status).toBe(200);
  });

  it('records a manager co-authorization and refuses a self-approval (C7)', async () => {
    const { deviceId, secret } = await enroll('coauth');
    const { token, sessionId } = await establish(secret);
    await call(deps.routes.unlock, {
      secret,
      session: token,
      body: { staffProfileId: STAFF.A.id, type: 'PIN', secret: STAFF.A.pin },
    });

    const approved = await call(deps.routes.coAuthorize, {
      secret,
      session: token,
      body: {
        approvingStaffProfileId: STAFF.M.id,
        type: 'PIN',
        secret: STAFF.M.pin,
        capability: 'orders:void',
        reason: 'guest complaint',
        targetType: 'Order',
        targetId: `ord_${suffix}`,
      },
    });
    expect(approved.status).toBe(201);

    // Scope the lookup to THIS run's session (a globally-unique id) so a reused
    // throwaway database cannot surface a prior run's row.
    const record = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantCoAuthorization.findFirst({ where: { terminalSessionId: sessionId } })
    );
    expect(record).toMatchObject({
      actingStaffProfileId: STAFF.A.id, // acting operator, unchanged by approval (C6)
      approvingStaffProfileId: STAFF.M.id,
      capability: 'orders:void',
      deviceId,
      terminalSessionId: sessionId,
    });

    // A self-approval (approver == acting operator) is refused with 400.
    const selfApprove = await call(deps.routes.coAuthorize, {
      secret,
      session: token,
      body: {
        approvingStaffProfileId: STAFF.A.id,
        type: 'PIN',
        secret: STAFF.A.pin,
        capability: 'orders:void',
        targetType: 'Order',
        targetId: `ord_${suffix}`,
        reason: 'self',
      },
    });
    expect(selfApprove.status).toBe(400);
  });

  it('refuses unapproved operations, unavailable orders and staff without approval rights before recording evidence', async () => {
    const { secret } = await enroll('approval-scope');
    const { token, sessionId } = await establish(secret);
    expect(
      (
        await call(deps.routes.unlock, {
          secret,
          session: token,
          body: { staffProfileId: STAFF.A.id, type: 'PIN', secret: STAFF.A.pin },
        })
      ).status
    ).toBe(200);
    const body = {
      approvingStaffProfileId: STAFF.M.id,
      type: 'PIN',
      secret: STAFF.M.pin,
      capability: 'orders:void',
      targetType: 'Order',
      targetId: `ord_${suffix}`,
      reason: 'Duplicate order',
    };
    const foreignBranch = `branch_other_${suffix}`;
    const other = await deps.withTenantDb(orgId, async (tx) => {
      const { device } = await deps.enrollDevice(tx, {
        branchId: foreignBranch,
        name: 'Other branch order',
      });
      return tx.restaurantOrder.create({
        data: {
          branchId: foreignBranch,
          deviceId: device.id,
          staffProfileId: OTHER_BRANCH_STAFF.id,
          orderNumber: 1,
          businessDate: new Date(),
          channel: 'TAKEAWAY',
          status: 'OPEN',
        },
      });
    });
    for (const [patch, status] of [
      [{ approvingStaffProfileId: STAFF.L.id, secret: STAFF.L.pin }, 403],
      [{ targetId: 'absent' }, 404],
      [{ targetId: other.id }, 404],
      [{ capability: 'unrecognized' }, 400],
      [{ targetType: 'Other' }, 400],
    ] as const) {
      expect(
        (
          await call(deps.routes.coAuthorize, {
            secret,
            session: token,
            body: { ...body, ...patch },
          })
        ).status
      ).toBe(status);
    }
    await deps.flushAuditWrites();
    await deps.withTenantDb(orgId, async (tx) => {
      expect(
        await tx.restaurantCoAuthorization.count({ where: { terminalSessionId: sessionId } })
      ).toBe(0);
      expect(
        await tx.auditLog.count({
          where: {
            action: 'restaurant.terminal.co-authorize',
            metadata: { path: ['terminalSessionId'], equals: sessionId },
          },
        })
      ).toBe(0);
    });
  });

  it('rejects a revoked device mid-session and refuses replay of its session token (C5)', async () => {
    const { deviceId, secret } = await enroll('revoke');
    const { token } = await establish(secret);
    await call(deps.routes.unlock, {
      secret,
      session: token,
      body: { staffProfileId: STAFF.A.id, type: 'PIN', secret: STAFF.A.pin },
    });

    // Revoke the device MID-SESSION (back-office action).
    await deps.withTenantDb(orgId, (tx) => deps.revokeDevice(tx, deviceId, new Date()));

    // Replaying the still-"valid" session token is rejected on the next call,
    // because the transport re-reads the device FRESH every time (no trust cache).
    const replay = await call(deps.routes.heartbeat, { secret, session: token });
    expect(replay.status).toBe(403);

    // Even establishing a new session on the revoked device is refused.
    const reEstablish = await call(deps.routes.establish, { secret });
    expect(reEstablish.status).toBe(403);
  });

  it('rejects replay of an ended session (C5)', async () => {
    const { secret } = await enroll('ended');
    const { token, sessionId } = await establish(secret);
    await deps.withTenantDb(orgId, (tx) => deps.endSession(tx, sessionId, new Date()));

    const replay = await call(deps.routes.heartbeat, { secret, session: token });
    expect(replay.status).toBe(401);
  });

  it('locks an operator credential after five failed unlocks and honours the durable lock (C4)', async () => {
    const { secret } = await enroll('lockout');
    const { token } = await establish(secret);

    for (let attempt = 0; attempt < 5; attempt++) {
      const wrong = await call(deps.routes.unlock, {
        secret,
        session: token,
        body: { staffProfileId: STAFF.L.id, type: 'PIN', secret: '000000' },
      });
      expect(wrong.status).toBe(401);
    }

    // The sixth attempt — even with the CORRECT pin — is locked out (423).
    const locked = await call(deps.routes.unlock, {
      secret,
      session: token,
      body: { staffProfileId: STAFF.L.id, type: 'PIN', secret: STAFF.L.pin },
    });
    expect(locked.status).toBe(423);

    // The lock is durable on the credential row (C4), not a per-instance cache.
    const credential = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantOperatorCredential.findFirst({ where: { staffProfileId: STAFF.L.id } })
    );
    expect(credential!.lockedUntil).toBeInstanceOf(Date);
  });

  it('writes one attributable RESTAURANT_OPERATOR audit row per sensitive mutation (C6/C7)', async () => {
    const { deviceId, secret } = await enroll('audit');
    const { token, sessionId } = await establish(secret);

    // Drive the four sensitive mutations that must each leave one attributable
    // audit row: unlock (A), switch (A -> B), co-authorize (acting B + approver M),
    // lock (B). Each returns success only after the mutation committed.
    const unlocked = await call(deps.routes.unlock, {
      secret,
      session: token,
      body: { staffProfileId: STAFF.A.id, type: 'PIN', secret: STAFF.A.pin },
    });
    expect(unlocked.status).toBe(200);
    const switched = await call(deps.routes.switchOperator, {
      secret,
      session: token,
      body: { staffProfileId: STAFF.B.id, type: 'PIN', secret: STAFF.B.pin },
    });
    expect(switched.status).toBe(200);
    const approved = await call(deps.routes.coAuthorize, {
      secret,
      session: token,
      body: {
        approvingStaffProfileId: STAFF.M.id,
        type: 'PIN',
        secret: STAFF.M.pin,
        capability: 'orders:void',
        reason: 'audit attribution',
        targetType: 'Order',
        targetId: `ord_audit_${suffix}`,
      },
    });
    expect(approved.status).toBe(201);
    const locked = await call(deps.routes.lock, { secret, session: token });
    expect(locked.status).toBe(200);

    // The audit writes are fire-and-forget; under Vitest they are tracked, not
    // swallowed, so this await surfaces any failure (the original P2003 FK
    // violation would reject HERE instead of vanishing) and guarantees the rows
    // are committed before we read them back.
    await deps.flushAuditWrites();

    const rows = await deps.withTenantDb(orgId, (tx) =>
      tx.auditLog.findMany({
        where: { organizationId: orgId, actorType: 'RESTAURANT_OPERATOR' },
        orderBy: { createdAt: 'asc' },
      })
    );
    // Scope to THIS run's session (a globally-unique id pinned in metadata) so a
    // reused throwaway database cannot surface a prior run's rows.
    const mine = rows.filter(
      (r) => (r.metadata as { terminalSessionId?: string } | null)?.terminalSessionId === sessionId
    );
    const byAction = new Map(mine.map((r) => [r.action, r]));

    // Exactly one durable, attributable row per sensitive mutation.
    expect([...byAction.keys()].sort()).toEqual([
      'restaurant.terminal.co-authorize',
      'restaurant.terminal.lock',
      'restaurant.terminal.switch',
      'restaurant.terminal.unlock',
    ]);
    expect(mine).toHaveLength(4);

    // Every operator row attributes to a staff profile, NEVER a User, and pins the
    // exact device it was taken on.
    for (const r of mine) {
      expect(r.actorStaffProfileId).toBeTruthy();
      expect(r.actorId).toBeNull();
      expect((r.metadata as { deviceId?: string }).deviceId).toBe(deviceId);
    }

    // The acting operator on each row is the one bound at the time of the action.
    expect(byAction.get('restaurant.terminal.unlock')!.actorStaffProfileId).toBe(STAFF.A.id);
    expect(byAction.get('restaurant.terminal.switch')!.actorStaffProfileId).toBe(STAFF.B.id);
    expect(byAction.get('restaurant.terminal.co-authorize')!.actorStaffProfileId).toBe(STAFF.B.id);
    expect(byAction.get('restaurant.terminal.lock')!.actorStaffProfileId).toBe(STAFF.B.id);

    // Co-authorization ADDS the approving manager (C6 — approval never replaces
    // the actor); the approver is pinned in metadata, not the actor column.
    expect(
      (
        byAction.get('restaurant.terminal.co-authorize')!.metadata as {
          approvingStaffProfileId?: string;
        }
      ).approvingStaffProfileId
    ).toBe(STAFF.M.id);
  });
  it('requires a fresh sole-owner PIN and persists self-approval audit evidence', async () => {
    const { deviceId, secret } = await enroll('sole-owner');
    const { token, sessionId } = await establish(secret);
    const active = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantStaffProfile.findMany({ where: { status: 'ACTIVE' }, select: { id: true } })
    );
    const ownerRoleId = `sole_owner_role_${suffix}`;
    try {
      await deps.withTenantDb(orgId, async (tx) => {
        await tx.restaurantStaffProfile.updateMany({
          where: { id: { not: STAFF.A.id }, status: 'ACTIVE' },
          data: { status: 'SUSPENDED' },
        });
        await tx.restaurantJobRole.create({
          data: {
            id: ownerRoleId,
            key: 'owner',
            name: 'Owner',
            capabilities: { create: { capability: 'coauth:approve' } },
          },
        });
        await tx.restaurantStaffJobRole.create({
          data: { staffProfileId: STAFF.A.id, jobRoleId: ownerRoleId, branchId },
        });
      });
      expect(
        (
          await call(deps.routes.unlock, {
            secret,
            session: token,
            body: { staffProfileId: STAFF.A.id, type: 'PIN', secret: STAFF.A.pin },
          })
        ).status
      ).toBe(200);
      const approval = {
        approvingStaffProfileId: STAFF.A.id,
        type: 'PIN',
        capability: 'orders:void',
        reason: 'Owner corrected duplicate',
        targetType: 'Order',
        targetId: `sole_owner_order_${suffix}`,
      };
      expect(
        (
          await call(deps.routes.coAuthorize, {
            secret,
            session: token,
            body: { ...approval, secret: '000000' },
          })
        ).status
      ).toBe(401);
      expect(
        await deps.withTenantDb(orgId, (tx) =>
          tx.restaurantCoAuthorization.count({ where: { terminalSessionId: sessionId } })
        )
      ).toBe(0);
      expect(
        (
          await call(deps.routes.coAuthorize, {
            secret,
            session: token,
            body: { ...approval, secret: STAFF.A.pin },
          })
        ).status
      ).toBe(201);
      const record = await deps.withTenantDb(orgId, (tx) =>
        tx.restaurantCoAuthorization.findFirst({ where: { terminalSessionId: sessionId } })
      );
      expect(record).toMatchObject({
        actingStaffProfileId: STAFF.A.id,
        approvingStaffProfileId: STAFF.A.id,
        deviceId,
        terminalSessionId: sessionId,
        reason: 'Owner corrected duplicate [Owner PIN reauthentication]',
      });
      await deps.flushAuditWrites();
      const audits = await deps.withTenantDb(orgId, (tx) =>
        tx.auditLog.findMany({
          where: { action: 'restaurant.terminal.co-authorize', actorStaffProfileId: STAFF.A.id },
        })
      );
      const audit = audits.find(
        (row) =>
          (row.metadata as { terminalSessionId?: string } | null)?.terminalSessionId === sessionId
      );
      expect(audit?.metadata).toMatchObject({
        approvalMode: 'OWNER_PIN_REAUTHENTICATION',
        approvingStaffProfileId: STAFF.A.id,
        deviceId,
        terminalSessionId: sessionId,
      });
    } finally {
      await deps.withTenantDb(orgId, async (tx) => {
        await tx.restaurantJobRole.deleteMany({ where: { id: ownerRoleId } });
        await tx.restaurantStaffProfile.updateMany({
          where: { id: { in: active.map((staff) => staff.id) } },
          data: { status: 'ACTIVE' },
        });
      });
    }
  });
});
