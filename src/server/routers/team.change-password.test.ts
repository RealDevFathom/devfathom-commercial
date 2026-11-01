/**
 * `team.changePassword` hardening (follow-ups to #164).
 *
 * Two properties this suite pins:
 *
 *  1. The mutation shares the SAME per-account and per-IP budgets as login
 *     (`login:acct:` / `login:ip:`), so an attacker cannot switch to the
 *     authenticated change-password endpoint to dodge the login lockout — and a
 *     burst of wrong-current-password attempts feeds that same lockout. A
 *     successful change refunds only its own account budget.
 *  2. BOTH the failed and the successful attempt leave an audit trail: the tRPC
 *     audit middleware records every call with the annotated AUTH detail and the
 *     real outcome (FAILURE vs SUCCESS).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  recordTrpcAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements')>('@/lib/entitlements');
  return { ...actual, resolveOrganizationEntitlements: vi.fn() };
});
// Keep the real annotateAudit (it mutates ctx.audit.detail) but stub the DB write.
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: mocks.recordTrpcAudit, ipFromHeaders: vi.fn(() => null) };
});
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(), sendEmail: vi.fn(), templates: {} }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));

import { hash } from 'bcryptjs';
import { clearRateLimit, rateLimit } from '@/lib/rate-limit';
import { router, type TRPCContext } from '../trpc';
import { teamRouter } from './team';

const app = router({ team: teamRouter });

const CURRENT = 'CurrentPw9';
const NEXT = 'BrandNewPw9';
let CURRENT_HASH: string;

beforeAll(async () => {
  CURRENT_HASH = await hash(CURRENT, 10);
});

/** A fresh identity per test keeps the process-wide memory buckets isolated. */
function identity() {
  const suffix = randomUUID().slice(0, 8);
  return {
    id: `user_${suffix}`,
    email: `member_${suffix}@acme.test`,
    ip: `203.0.113.${(parseInt(suffix, 16) % 254) + 1}`,
  };
}

function caller(who: ReturnType<typeof identity>) {
  const detail: Record<string, unknown> = {};
  const ctx = {
    db: { user: { findUnique: mocks.findUnique, update: mocks.update } },
    entitlements: {
      organizationId: 'org_1',
      enabledModules: [],
      modules: [],
      activeSeats: 1,
      seatLimit: 50,
    },
    session: {
      expires: 'later',
      user: {
        id: who.id,
        email: who.email,
        role: 'EMPLOYEE',
        status: 'ACTIVE',
        organizationId: 'org_1',
      },
    },
    organization: { id: 'org_1', isDemo: false },
    support: null,
    requestMeta: { ip: who.ip, userAgent: null },
    audit: { detail },
  } as unknown as TRPCContext;
  return { call: app.createCaller(ctx).team, detail };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue({ password: CURRENT_HASH });
  mocks.update.mockResolvedValue({ id: 'ignored' });
});

describe('team.changePassword rate limiting', () => {
  it('rejects a wrong current password and records a FAILURE audit event', async () => {
    const who = identity();
    const { call, detail } = caller(who);

    await expect(
      call.changePassword({ currentPassword: 'WrongPw99', newPassword: NEXT })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // The middleware recorded the attempt as a failure, with the AUTH annotation.
    const lastCall = mocks.recordTrpcAudit.mock.calls.at(-1)?.[0];
    expect(lastCall?.outcome).toBe('FAILURE');
    expect(detail).toMatchObject({
      category: 'AUTH',
      action: 'team.changePassword',
      description: 'Password change attempted',
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('records SUCCESS, refunds its account budget, and preserves shared IP failures', async () => {
    const who = identity();
    const { call, detail } = caller(who);
    const ipKey = `login:ip:${who.ip}`;
    await clearRateLimit(ipKey);
    for (let i = 0; i < 7; i += 1) await rateLimit(ipKey, 30, 5 * 60_000);
    await rateLimit(`login:acct:${who.email}`, 10, 5 * 60_000);

    await expect(
      call.changePassword({ currentPassword: CURRENT, newPassword: NEXT })
    ).resolves.toEqual({ success: true });

    const lastCall = mocks.recordTrpcAudit.mock.calls.at(-1)?.[0];
    expect(lastCall?.outcome).toBe('SUCCESS');
    expect(detail).toMatchObject({
      action: 'team.changePassword',
      description: 'Password changed successfully',
    });
    expect(mocks.update).toHaveBeenCalledTimes(1);

    // Only this account is refunded. Other users' failures at the IP survive.
    const acct = await rateLimit(`login:acct:${who.email}`, 10, 5 * 60_000);
    expect(acct).toMatchObject({ ok: true, remaining: 9 });
    const ip = await rateLimit(ipKey, 30, 5 * 60_000);
    expect(ip).toMatchObject({ ok: true, remaining: 21 });
    await clearRateLimit(ipKey);
  });

  it('shares the login lockout budget: an exhausted login:acct blocks the change', async () => {
    const who = identity();
    const { call } = caller(who);

    // Burn the per-account login budget the way repeated failed logins would.
    for (let i = 0; i < 10; i += 1) await rateLimit(`login:acct:${who.email}`, 10, 5 * 60_000);

    await expect(
      call.changePassword({ currentPassword: CURRENT, newPassword: NEXT })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it('feeds the login lockout counter: repeated failed changes lock out login', async () => {
    const who = identity();
    const { call } = caller(who);

    // Ten wrong-password changes consume the shared per-account budget.
    for (let i = 0; i < 10; i += 1) {
      await expect(
        call.changePassword({ currentPassword: 'WrongPw99', newPassword: NEXT })
      ).rejects.toMatchObject({ code: expect.stringMatching(/BAD_REQUEST|TOO_MANY_REQUESTS/) });
    }

    // Login now sees the account budget already spent — the next login attempt
    // is locked out even though it never reached /api/login before.
    const acct = await rateLimit(`login:acct:${who.email}`, 10, 5 * 60_000);
    expect(acct.ok).toBe(false);

    await clearRateLimit(`login:acct:${who.email}`);
  });
});
