import { NextResponse } from 'next/server';

import { demoSeatFromOrganizationId, isDemoEnabled } from '@/lib/demo/config';
import { demoPersonaForUser } from '@/lib/demo/personas';
import {
  DEMO_TERMINAL_SESSION_COOKIE,
  demoTerminalCookieOptions,
  prepareDemoDeviceSession,
} from '@/lib/demo/device-session';
import { isDemoMutationOrigin } from '@/lib/demo/isolation';
import { DEMO_RESET_TRANSACTION_TIMEOUT_MS } from '@/lib/demo/jobs';
import { resetDemoSeatInTransaction } from '@/lib/demo/reset';
import { TERMINAL_DEVICE_COOKIE } from '@/lib/restaurant/terminal-auth';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';

const RESET_COOLDOWN_MS = 10 * 60_000;

type DemoResetLock = {
  id: string;
  isDemo: boolean;
  lastDemoResetAt: Date | null;
  now: Date;
};

function json(body: unknown, status = 200, retryAfter?: number) {
  return NextResponse.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}),
    },
  });
}

export async function POST(request: Request) {
  if (!isDemoEnabled()) return json({ error: 'Not found.' }, 404);
  if (!isDemoMutationOrigin(request)) return json({ error: 'Not allowed.' }, 403);

  const actor = await resolveTenantActor({ request });
  if (!actor || !actor.organization.isDemo || actor.support) {
    return json({ error: 'Not found.' }, 404);
  }
  const seat = demoSeatFromOrganizationId(actor.organization.id);
  const persona = seat ? demoPersonaForUser(seat, actor.session.user) : null;
  if (
    !seat ||
    actor.session.user.organizationId !== actor.organization.id ||
    (persona !== 'manager' && persona !== 'owner')
  ) {
    return json({ error: 'Not found.' }, 404);
  }
  const cookieOptions = demoTerminalCookieOptions(actor.session.user.demoAccessExpiresAt);
  if (!cookieOptions) return json({ error: 'Demo access has expired.' }, 401);

  const result = await withTenantDb(
    actor.organization.id,
    async (db) => {
      const [organization] = await db.$queryRaw<DemoResetLock[]>`
        SELECT id,
               "isDemo" AS "isDemo",
               "lastDemoResetAt" AS "lastDemoResetAt",
               (clock_timestamp() AT TIME ZONE 'UTC') AS "now"
          FROM organizations
         WHERE id = ${actor.organization.id}
         FOR UPDATE
      `;
      if (!organization?.isDemo) return { kind: 'missing' as const };

      if (organization.lastDemoResetAt) {
        const remaining =
          RESET_COOLDOWN_MS - (organization.now.getTime() - organization.lastDemoResetAt.getTime());
        if (remaining > 0) {
          return { kind: 'cooldown' as const, retryAfter: Math.ceil(remaining / 1000) };
        }
      }

      const summary = await resetDemoSeatInTransaction(db, {
        organizationId: actor.organization.id,
        now: organization.now,
      });
      const runtime = await prepareDemoDeviceSession(
        db,
        actor.session.user,
        'POS',
        organization.now
      );
      if (!runtime) throw new Error('Demo terminal runtime was not rebuilt.');
      return {
        kind: 'ready' as const,
        resetAt: organization.now,
        summary,
        runtime,
      };
    },
    { maxWait: 30_000, timeout: DEMO_RESET_TRANSACTION_TIMEOUT_MS }
  );

  if (result.kind === 'missing') return json({ error: 'Not found.' }, 404);
  if (result.kind === 'cooldown') {
    return json(
      { error: 'This demo seat was reset recently.', retryAfter: result.retryAfter },
      429,
      result.retryAfter
    );
  }

  const { deviceSecret } = result.runtime;
  const response = json({
    resetAt: result.resetAt.toISOString(),
    summary: result.summary,
  });
  response.cookies.set(TERMINAL_DEVICE_COOKIE, deviceSecret, cookieOptions);
  response.cookies.set(DEMO_TERMINAL_SESSION_COOKIE, result.runtime.sessionToken, {
    ...cookieOptions,
    path: '/demo/restaurants/device-session',
  });
  return response;
}
