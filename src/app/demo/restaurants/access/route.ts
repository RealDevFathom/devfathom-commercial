import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  DEMO_ACCESS_COOKIE,
  createDemoAccessGrant,
  demoAccessCodeMatches,
  demoAccessCookieOptions,
  readDemoAccessGrant,
  resolveDemoSeat,
} from '@/lib/demo/access';
import { isDemoEnabled } from '@/lib/demo/config';
import { DEMO_PERSONA_KEYS, DEMO_PERSONAS } from '@/lib/demo/personas';
import {
  LOGIN_INTENT_COOKIE,
  createLoginIntent,
  loginIntentCookieOptions,
} from '@/lib/auth/login-intent';
import { rateLimit } from '@/lib/rate-limit';
import { readBoundedJson } from '@/lib/http/read-bounded-body';
import {
  PlatformSecurityError,
  assertPlatformMutationOrigin,
  parseCookie,
} from '@/lib/platform/security';
import { isSharedHost, requestHost } from '@/lib/tenancy/host';
import { ipFromHeaders } from '@/server/audit';

const MAX_BODY_BYTES = 1024;
const PRIVATE_HEADERS = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' };
const inputSchema = z
  .object({
    code: z.string().max(256).optional(),
    seat: z.number().int().min(1).max(25),
    persona: z.enum(DEMO_PERSONA_KEYS).default('manager'),
  })
  .strict();

function json(body: unknown, status = 200, headers?: HeadersInit) {
  return NextResponse.json(body, { status, headers: { ...PRIVATE_HEADERS, ...headers } });
}

export async function POST(request: Request) {
  const host = requestHost(request);
  if (!isDemoEnabled() || !isSharedHost(host)) return json({ error: 'Not found.' }, 404);
  try {
    assertPlatformMutationOrigin(request);
  } catch (error) {
    const status = error instanceof PlatformSecurityError ? error.status : 403;
    return json({ error: 'Not allowed.' }, status);
  }

  const body = await readBoundedJson(request, MAX_BODY_BYTES).catch(() => null);
  if (body?.tooLarge) return json({ error: 'Invalid request.' }, 413);
  const parsed = inputSchema.safeParse(body?.value);
  if (!parsed.success) return json({ error: 'Invalid request.' }, 400);
  const seat = await resolveDemoSeat(parsed.data.seat, parsed.data.persona);
  if (!seat) return json({ error: 'Demo seat is not ready.' }, 409);

  const rawGrant = parseCookie(request.headers.get('cookie'), DEMO_ACCESS_COOKIE);
  const existing = readDemoAccessGrant(rawGrant, host);
  const grantMatches =
    existing?.organizationId === seat.organizationId && existing.seat === seat.seat;
  const reuseGrant = !parsed.data.code && grantMatches;
  if (!reuseGrant) {
    const gate = await rateLimit(
      `demo:access:${ipFromHeaders(request.headers) ?? 'unknown'}`,
      10,
      15 * 60_000
    );
    if (!gate.ok) {
      return json({ error: 'Too many attempts.', retryAfter: gate.retryAfter }, 429, {
        'retry-after': String(gate.retryAfter),
      });
    }
    if (!parsed.data.code || !demoAccessCodeMatches(parsed.data.code)) {
      return json({ error: 'Invalid access code.' }, 401);
    }
  }

  let grant: ReturnType<typeof createDemoAccessGrant>;
  if (reuseGrant) {
    grant = { value: rawGrant!, expiresAt: new Date(existing!.expiresAt) };
  } else {
    try {
      grant = createDemoAccessGrant({
        organizationId: seat.organizationId,
        seat: seat.seat,
        host,
      });
    } catch {
      return json({ error: 'Demo access is unavailable.' }, 503);
    }
  }
  const intent = await createLoginIntent({
    email: seat.email,
    host,
    candidates: [
      {
        organizationId: seat.organizationId,
        userId: seat.userId,
        demoAccessExpiresAt: grant.expiresAt.getTime(),
      },
    ],
    ip: ipFromHeaders(request.headers),
    userAgent: request.headers.get('user-agent'),
  });
  const { callbackUrl, deviceKind } = DEMO_PERSONAS[seat.persona];
  const response = json({
    organizationId: seat.organizationId,
    persona: seat.persona,
    callbackUrl,
    deviceKind,
  });
  response.cookies.set(DEMO_ACCESS_COOKIE, grant.value, demoAccessCookieOptions(grant.expiresAt));
  response.cookies.set(
    LOGIN_INTENT_COOKIE,
    intent.token,
    loginIntentCookieOptions(intent.expiresAt)
  );
  return response;
}
