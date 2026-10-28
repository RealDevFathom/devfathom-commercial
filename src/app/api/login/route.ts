import { z } from 'zod';
import { ipFromHeaders } from '@/server/audit';
import { rateLimit } from '@/lib/rate-limit';
import { emailSchema } from '@/lib/email-address';
import { publicRequestOrigin } from '@/lib/http-origin';
import { requestHost } from '@/lib/tenancy/host';
import { isSharedHost, tenantHostUrl } from '@/lib/tenancy/host-routing';
import { safeCallbackUrl } from '@/lib/auth/callback-url';
import {
  clearedLoginIntentCookieOptions,
  createLoginIntent,
  discardLoginIntent,
  LOGIN_INTENT_COOKIE,
  loginIntentCookieOptions,
} from '@/lib/auth/login-intent';
import { resolveSharedLogin } from '@/lib/auth/shared-login';
import { parseCookie } from '@/lib/platform/security';

/**
 * Shared-host credential check.
 *
 * The login URL carries no workspace slug and no `workspace=` parameter, so this
 * endpoint is where credentials are proven and — only then — the eligible
 * organizations are revealed. It never establishes a session: it hands back an
 * opaque, single-use, host-bound intent cookie, and the browser exchanges that
 * for a normal Auth.js session through the `login-intent` provider once a
 * workspace is chosen.
 *
 * Lives at /api/login rather than under /api/auth so it can never shadow or be
 * shadowed by the Auth.js catch-all route.
 */

const bodySchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(512),
  callbackUrl: z.string().max(2048).optional(),
});

/** Identical for every failure, so nothing about the address is observable. */
const UNIFORM_FAILURE = {
  outcome: 'failed' as const,
  message: 'Invalid email or password. Please try again.',
};

function json(body: unknown, init?: ResponseInit) {
  return Response.json(body, init);
}

function serializeCookie(
  name: string,
  value: string,
  options: { httpOnly: boolean; secure: boolean; sameSite: 'lax'; path: string } & (
    { expires: Date } | { maxAge: number }
  )
): string {
  const parts = [`${name}=${value}`, `Path=${options.path}`, `SameSite=Lax`];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if ('expires' in options) parts.push(`Expires=${options.expires.toUTCString()}`);
  else parts.push(`Max-Age=${options.maxAge}`);
  // Deliberately no Domain attribute — see loginIntentCookieOptions.
  return parts.join('; ');
}

function assertSameOrigin(request: Request): boolean {
  let expected: string;
  try {
    expected = publicRequestOrigin(request);
  } catch {
    return false;
  }
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    if (new URL(origin).origin.toLowerCase() !== expected) return false;
  } catch {
    return false;
  }
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  return (request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json');
}

export async function POST(request: Request) {
  const host = requestHost(request);
  // The slug-free flow exists only on the shared host. A tenant, dedicated or
  // admin host keeps its own login and must not gain a cross-tenant surface.
  if (!isSharedHost(host)) return json({ error: 'Not found.' }, { status: 404 });
  if (!assertSameOrigin(request)) return json({ error: 'Not allowed.' }, { status: 403 });

  const ip = ipFromHeaders(request.headers);
  const userAgent = request.headers.get('user-agent');

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    // Malformed input is reported exactly like a wrong password.
    return json(UNIFORM_FAILURE, { status: 401 });
  }

  // D18: the same limiter that guards the per-host provider, in front of
  // discovery. `login:acct` is keyed on the email and is therefore global across
  // organizations — that is deliberate here, since discovery is global too, but
  // it does mean a user in one organization can rate-limit a same-address user in
  // another. The counter is shared across instances.
  //
  // A correct password here is deliberately NOT a refund: the second factor is
  // proven only at workspace selection, so both budgets are cleared by the
  // `login-intent` provider in src/lib/auth.ts once that succeeds (WHA-1570).
  const ipGate = await rateLimit(`login:ip:${ip ?? 'unknown'}`, 30, 5 * 60_000);
  const accountGate = await rateLimit(`login:acct:${parsed.email}`, 10, 5 * 60_000);
  // Minting intents is limited separately so a valid credential cannot be used to
  // fill the intent table.
  const intentGate = await rateLimit(`login:intent:${ip ?? 'unknown'}`, 20, 5 * 60_000);
  const blocked = [ipGate, accountGate, intentGate].filter((gate) => !gate.ok);
  if (blocked.length > 0) {
    // The BODY stays byte-identical to the 401 — a limiter must not become an
    // enumeration oracle. The status and Retry-After describe the limiter, not
    // the address: these counters trip exactly the same way for an account that
    // does not exist, so neither one reveals more than the 429 already does.
    // They are what lets the client say "you have used your limit" instead of
    // "your password is wrong" (WHA-1208).
    const retryAfter = Math.max(1, ...blocked.map((gate) => gate.retryAfter));
    return json(UNIFORM_FAILURE, {
      status: 429,
      headers: { 'retry-after': String(retryAfter) },
    });
  }

  const resolution = await resolveSharedLogin({
    email: parsed.email,
    password: parsed.password,
    ip,
    userAgent,
  });

  if (resolution.outcome === 'failed') {
    return json(UNIFORM_FAILURE, { status: 401 });
  }

  const selectable = resolution.organizations.filter((organization) => !organization.ssoEnforced);

  // D12: every eligible organization the person belongs to is shown, including
  // the SSO-enforced ones — they must be able to see the workspace and reach it —
  // but only password-eligible ones carry an intent candidate, so there is no
  // password path into an enforced organization even if the client is bypassed.
  const responseOrganizations = resolution.organizations.map((organization) => ({
    id: organization.organizationId,
    slug: organization.slug,
    displayName: organization.displayName,
    ssoEnforced: organization.ssoEnforced,
    // D11: SSO begins on the organization's own host, because its redirect URI
    // and audience are registered there. Computed server-side — the browser
    // never needs to know the base domain.
    ssoUrl: organization.ssoEnforced ? tenantHostUrl(organization.slug) : null,
  }));

  const callbackUrl = safeCallbackUrl(parsed.callbackUrl ?? null);

  if (selectable.length === 0) {
    // Every workspace this person can enter requires SSO. Show the SSO-only
    // screen rather than a picker with nothing selectable.
    return json(
      { outcome: 'sso-only', organizations: responseOrganizations, callbackUrl },
      { headers: clearIntentCookie() }
    );
  }

  const { token, expiresAt } = await createLoginIntent({
    email: resolution.email,
    host,
    candidates: selectable.map((organization) => ({
      organizationId: organization.organizationId,
      userId: organization.userId,
      tokenVersion: organization.tokenVersion,
    })),
    ip,
    userAgent,
  });

  const headers = new Headers();
  headers.append(
    'set-cookie',
    serializeCookie(LOGIN_INTENT_COOKIE, token, loginIntentCookieOptions(expiresAt))
  );

  return json(
    {
      // One eligible organization continues straight through; more than one
      // renders the selection screen. The organization NEVER travels in the URL.
      outcome: selectable.length === 1 ? 'single' : 'select',
      organizations: responseOrganizations,
      callbackUrl,
    },
    { headers }
  );
}

/**
 * Sign-out clears organization-selection state as well as authentication, so a
 * half-finished login cannot be resumed by the next person at the browser.
 */
export async function DELETE(request: Request) {
  if (!isSharedHost(requestHost(request))) {
    return json({ error: 'Not found.' }, { status: 404 });
  }
  await discardLoginIntent(parseCookie(request.headers.get('cookie'), LOGIN_INTENT_COOKIE));
  return json({ ok: true }, { headers: clearIntentCookie() });
}

function clearIntentCookie(): Headers {
  const headers = new Headers();
  headers.append(
    'set-cookie',
    serializeCookie(LOGIN_INTENT_COOKIE, '', clearedLoginIntentCookieOptions())
  );
  return headers;
}
