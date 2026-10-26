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
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePlatformModule } from '@/lib/test-support/departments';

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

describeIfDatabase('terminal transport end-to-end (real DB)', () => {
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
        canComp: boolean;
        canApprove: boolean;
      }[];
    };

    expect(response.status).toBe(200);
    expect(body.operators.map((operator) => operator.staffProfileId).sort()).toEqual(
      Object.values(STAFF)
        .map((staff) => staff.id)
        .sort()
    );
    expect(body.operators.every((operator) => Object.keys(operator).length === 5)).toBe(true);
    expect(body.operators.every((operator) => operator.canComp === false)).toBe(true);
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
        reason: 'self',
      },
    });
    expect(selfApprove.status).toBe(400);
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
});
