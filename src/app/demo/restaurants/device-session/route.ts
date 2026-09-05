import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  DEMO_TERMINAL_SESSION_COOKIE,
  demoTerminalCookieOptions,
  prepareDemoDeviceSession,
} from '@/lib/demo/device-session';
import { isDemoEnabled } from '@/lib/demo/config';
import { isDemoMutationOrigin } from '@/lib/demo/isolation';
import { parseCookie } from '@/lib/platform/security';
import { TERMINAL_DEVICE_COOKIE } from '@/lib/restaurant/terminal-auth';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';

const inputSchema = z.object({ kind: z.enum(['POS', 'KDS']).default('POS') }).strict();

export async function POST(request: Request) {
  if (!isDemoEnabled()) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  if (!isDemoMutationOrigin(request)) {
    return NextResponse.json({ error: 'Not allowed.' }, { status: 403 });
  }
  const actor = await resolveTenantActor({ request });
  if (!actor || !actor.organization.isDemo || actor.support) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }
  const now = new Date();
  const cookieOptions = demoTerminalCookieOptions(actor.session.user.demoAccessExpiresAt, now);
  if (!cookieOptions) {
    return NextResponse.json({ error: 'Demo access has expired.' }, { status: 401 });
  }

  const raw = await request.text();
  if (Buffer.byteLength(raw) > 256) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  let parsed: ReturnType<typeof inputSchema.safeParse>;
  try {
    parsed = inputSchema.safeParse(raw ? JSON.parse(raw) : {});
  } catch {
    parsed = inputSchema.safeParse(null);
  }
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });

  const cookieHeader = request.headers.get('cookie');
  const prepared = await withTenantDb(actor.organization.id, (db) =>
    prepareDemoDeviceSession(db, actor.session.user, parsed.data.kind, now, {
      deviceSecret: parseCookie(cookieHeader, TERMINAL_DEVICE_COOKIE),
      sessionToken: parseCookie(cookieHeader, DEMO_TERMINAL_SESSION_COOKIE),
    })
  );
  if (!prepared) {
    return NextResponse.json({ error: 'Demo terminal is not ready.' }, { status: 409 });
  }

  const { deviceSecret, ...body } = prepared;
  const response = NextResponse.json(
    { ready: true, ...body },
    {
      headers: {
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    }
  );
  response.cookies.set(TERMINAL_DEVICE_COOKIE, deviceSecret, cookieOptions);
  response.cookies.set(DEMO_TERMINAL_SESSION_COOKIE, body.sessionToken, {
    ...cookieOptions,
    path: '/demo/restaurants/device-session',
  });
  return response;
}
