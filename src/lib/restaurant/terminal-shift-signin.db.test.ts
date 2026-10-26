/**
 * Completion wave (WHA-229) — shift-aware operator sign-in, against a REAL
 * PostgreSQL, driving the actual `/unlock` and `/switch` route handlers exactly
 * as an HTTP request would.
 *
 * Only a database can establish the boundary this lane owns: that a branch which
 * opted into `shiftSignInEnforced` refuses a GENUINE credential with a distinct
 * 403 and a named reason when the operator holds no active shift, admits the
 * same operator once a shift covers the moment, and that a branch which did NOT
 * opt in keeps its M2 behaviour untouched. The denial is deliberately NOT the
 * generic 401 — see `terminal-auth.ts`.
 *
 * Its own organization, branches and devices, so nothing here perturbs the M2
 * transport suite next door. Requires TEST_DATABASE_URL (a migrated, throwaway
 * database, never DATABASE_URL); without it the suite reports itself skipped
 * rather than passing vacuously.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePlatformModule, seedDepartments } from '@/lib/test-support/departments';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha229_${suffix}`;
/** The branch that rosters: sign-in requires an active shift here. */
const rosteredBranchId = `branch_rostered_${suffix}`;
/** The branch that does not roster: unchanged M2 behaviour. */
const openBranchId = `branch_open_${suffix}`;

const ROSTERED = { id: `staff_rostered_${suffix}`, pin: '111111' };
const UNROSTERED = { id: `staff_unrostered_${suffix}`, pin: '222222' };
const OPEN = { id: `staff_open_${suffix}`, pin: '333333' };

/** A fixed window well clear of "now", so the clock never decides the verdict. */
const SHIFT_START = new Date('2026-08-20T09:00:00.000Z');
const SHIFT_END = new Date('2026-08-20T17:00:00.000Z');
const DURING_SHIFT = new Date('2026-08-20T12:00:00.000Z');

type RouteModule = { POST: (request: Request) => Promise<Response> };

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  enrollDevice: (typeof import('@/lib/restaurant/devices'))['enrollDevice'];
  authenticateOperator: (typeof import('@/lib/restaurant/terminal-auth'))['authenticateOperator'];
  routes: { establish: RouteModule; unlock: RouteModule };
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

async function enroll(branchId: string, name: string): Promise<string> {
  const { secret } = await deps.withTenantDb(orgId, (tx) =>
    deps.enrollDevice(tx, { branchId, name })
  );
  return secret;
}

async function establish(secret: string): Promise<string> {
  const res = await call(deps.routes.establish, { secret });
  expect(res.status).toBe(201);
  return res.json.sessionToken as string;
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, devices, credentials, terminalAuth, establishR, unlockR] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/restaurant/devices'),
    import('@/lib/restaurant/operator-credentials'),
    import('@/lib/restaurant/terminal-auth'),
    import('@/app/api/restaurant/terminal/establish/route'),
    import('@/app/api/restaurant/terminal/unlock/route'),
  ]);

  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    enrollDevice: devices.enrollDevice,
    authenticateOperator: terminalAuth.authenticateOperator,
    routes: { establish: establishR, unlock: unlockR },
  };

  await deps.withPlatformDb(async (tx) => {
    await tx.organization.create({
      data: {
        id: orgId,
        slug: `wha229-${suffix}`,
        legalName: 'Roster Test Co',
        displayName: 'Roster Test',
        status: 'ACTIVE',
      },
    });
    await seedDepartments(tx, [orgId], ['LEADERSHIP']);
    // WHA-192 gates the terminal transport on `restaurant-pos`: without the
    // entitlement rows every establish/unlock answers 403 before the handler.
    const posModule = await ensurePlatformModule(tx, 'restaurant-pos', {
      name: 'POS',
      category: 'Operations',
    });
    await tx.organizationModule.create({
      data: { organizationId: orgId, moduleId: posModule.id },
    });
  });

  await deps.withTenantDb(orgId, async (tx) => {
    await tx.restaurantBranch.create({
      data: { id: rosteredBranchId, name: 'Rostered', shiftSignInEnforced: true },
    });
    await tx.restaurantBranch.create({ data: { id: openBranchId, name: 'Open' } });

    for (const [staff, branchId] of [
      [ROSTERED, rosteredBranchId],
      [UNROSTERED, rosteredBranchId],
      [OPEN, openBranchId],
    ] as const) {
      await tx.restaurantStaffProfile.create({
        data: {
          id: staff.id,
          displayName: staff.id,
          status: 'ACTIVE',
          primaryBranchId: branchId,
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

    await tx.restaurantShift.create({
      data: {
        branchId: rosteredBranchId,
        staffProfileId: ROSTERED.id,
        businessDate: new Date('2026-08-20T00:00:00.000Z'),
        startAt: SHIFT_START,
        endAt: SHIFT_END,
        role: 'Cashier',
      },
    });
  });
});

describeIfDatabase('shift-aware operator sign-in (real DB)', () => {
  it('serializes concurrent back-office waiver credential failures before lockout', async () => {
    await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantOperatorCredential.updateMany({
        where: { staffProfileId: OPEN.id, type: 'PIN', deviceId: null },
        data: { failedAttempts: 0, lockedUntil: null },
      })
    );

    const attempt = (secret: string) =>
      deps.withTenantDb(orgId, (tx) =>
        deps.authenticateOperator(tx, {
          staffProfileId: OPEN.id,
          type: 'PIN',
          secret,
          now: DURING_SHIFT,
        })
      );

    const failures = await Promise.all(Array.from({ length: 4 }, () => attempt('000000')));
    expect(failures).toEqual(Array.from({ length: 4 }, () => ({ ok: false, reason: 'INVALID' })));

    const afterFour = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantOperatorCredential.findFirstOrThrow({
        where: { staffProfileId: OPEN.id, type: 'PIN', deviceId: null },
        select: { failedAttempts: true, lockedUntil: true },
      })
    );
    expect(afterFour).toEqual({ failedAttempts: 4, lockedUntil: null });

    expect(await attempt('000000')).toEqual({ ok: false, reason: 'INVALID' });
    const afterLockout = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantOperatorCredential.findFirstOrThrow({
        where: { staffProfileId: OPEN.id, type: 'PIN', deviceId: null },
        select: { failedAttempts: true, lockedUntil: true },
      })
    );
    expect(afterLockout.failedAttempts).toBe(0);
    expect(afterLockout.lockedUntil?.getTime()).toBeGreaterThan(DURING_SHIFT.getTime());
    await expect(attempt(OPEN.pin)).resolves.toMatchObject({ ok: false, reason: 'LOCKED' });
  });

  it('refuses a genuine credential with 403 and a named reason when nothing is rostered', async () => {
    const secret = await enroll(rosteredBranchId, 'no-shift');
    const token = await establish(secret);

    const denied = await call(deps.routes.unlock, {
      secret,
      session: token,
      body: { staffProfileId: UNROSTERED.id, type: 'PIN', secret: UNROSTERED.pin },
    });
    expect(denied.status).toBe(403);
    expect(denied.json).toMatchObject({
      reason: 'NO_SHIFT',
      nextShiftStartsAt: null,
    });
    expect(String(denied.json.error)).not.toMatch(/invalid/i);
  });

  it('names the next start when the shift has not begun, and ENDED once it is over', async () => {
    const beforeShift = await deps.withTenantDb(orgId, (tx) =>
      deps.authenticateOperator(tx, {
        staffProfileId: ROSTERED.id,
        branchId: rosteredBranchId,
        type: 'PIN',
        secret: ROSTERED.pin,
        now: new Date('2026-08-19T09:00:00.000Z'),
      })
    );
    expect(beforeShift).toEqual({
      ok: false,
      reason: 'NO_ACTIVE_SHIFT',
      shiftReason: 'NOT_STARTED',
      nextShiftStartsAt: SHIFT_START,
    });

    const afterShift = await deps.withTenantDb(orgId, (tx) =>
      deps.authenticateOperator(tx, {
        staffProfileId: ROSTERED.id,
        branchId: rosteredBranchId,
        type: 'PIN',
        secret: ROSTERED.pin,
        now: new Date('2026-08-21T09:00:00.000Z'),
      })
    );
    expect(afterShift).toEqual({
      ok: false,
      reason: 'NO_ACTIVE_SHIFT',
      shiftReason: 'ENDED',
      nextShiftStartsAt: null,
    });
  });

  it('admits the rostered operator inside the shift, and refuses a wrong PIN as INVALID', async () => {
    const admitted = await deps.withTenantDb(orgId, (tx) =>
      deps.authenticateOperator(tx, {
        staffProfileId: ROSTERED.id,
        branchId: rosteredBranchId,
        type: 'PIN',
        secret: ROSTERED.pin,
        now: DURING_SHIFT,
      })
    );
    expect(admitted).toMatchObject({ ok: true, staffProfileId: ROSTERED.id });

    // A wrong secret must still fail as INVALID — the roster never turns a bad
    // credential into an operational-sounding message.
    const wrong = await deps.withTenantDb(orgId, (tx) =>
      deps.authenticateOperator(tx, {
        staffProfileId: ROSTERED.id,
        branchId: rosteredBranchId,
        type: 'PIN',
        secret: '000000',
        now: DURING_SHIFT,
      })
    );
    expect(wrong).toEqual({ ok: false, reason: 'INVALID' });
  });

  it('stops granting sign-in once the shift is cancelled', async () => {
    await deps.withTenantDb(orgId, async (tx) => {
      const shifts = await import('@/lib/restaurant/shifts');
      const live = await tx.restaurantShift.findFirst({
        where: { staffProfileId: ROSTERED.id, status: 'SCHEDULED' },
        select: { id: true },
      });
      expect(live).not.toBeNull();
      await shifts.cancelShift(tx, live!.id, { now: DURING_SHIFT, reason: 'Called in sick' });

      expect(
        await deps.authenticateOperator(tx, {
          staffProfileId: ROSTERED.id,
          branchId: rosteredBranchId,
          type: 'PIN',
          secret: ROSTERED.pin,
          now: DURING_SHIFT,
        })
      ).toEqual({
        ok: false,
        reason: 'NO_ACTIVE_SHIFT',
        shiftReason: 'NO_SHIFT',
        nextShiftStartsAt: null,
      });
    });
  });

  it('leaves a branch that does not roster on its unchanged M2 sign-in path', async () => {
    const secret = await enroll(openBranchId, 'open-branch');
    const token = await establish(secret);

    const unlocked = await call(deps.routes.unlock, {
      secret,
      session: token,
      body: { staffProfileId: OPEN.id, type: 'PIN', secret: OPEN.pin },
    });
    expect(unlocked.status).toBe(200);
    expect((unlocked.json.session as { activeStaffProfileId: string }).activeStaffProfileId).toBe(
      OPEN.id
    );
  });
});
