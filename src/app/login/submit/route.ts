import { NextRequest } from 'next/server';
import { handlers } from '@/lib/auth';
import { POST as checkSharedCredentials } from '@/app/api/login/route';
import { safeCallbackUrl } from '@/lib/auth/callback-url';
import { discardLoginIntent, LOGIN_INTENT_COOKIE } from '@/lib/auth/login-intent';
import { publicRequestOrigin } from '@/lib/http-origin';
import { requestHost } from '@/lib/tenancy/host';
import { isSharedHost } from '@/lib/tenancy/host-routing';
import { LOGIN_ERROR_PARAM, type LoginErrorKey } from '../login-errors';

/**
 * WHA-1623 — the no-JavaScript path of `/login`.
 *
 * The sign-in forms post here natively when they are submitted before React has
 * attached its handler (a slow counter tablet, a loaded CI machine). Before
 * this existed the native POST went back to the page itself, which answered 200
 * with a blank form: the person had typed a correct password and was silently
 * not signed in.
 *
 * Nothing here is a second implementation of sign-in. It replays exactly the
 * requests the hydrated form makes — `/api/login` on the shared host, then the
 * Auth.js credentials callback with a CSRF token — through the same handlers,
 * so rate limiting, uniform failures, the intent cookie and the WHA-1570 budget
 * refund behave identically. The only difference is the transport: a 303 to
 * the callback URL on success, and a 303 back to `/login` with a fixed error
 * key on failure.
 */

const FORM_CONTENT_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data'];

/** Headers that describe the original body and must not leak onto a new one. */
const BODY_HEADERS = ['content-length', 'content-type', 'transfer-encoding'];

function isSameOriginFormPost(request: Request): boolean {
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
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
  return FORM_CONTENT_TYPES.some((type) => contentType.startsWith(type));
}

function formString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/** `Set-Cookie` values reduced to the `name=value` pairs a later request sends. */
function cookiePairs(setCookies: string[]): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const header of setCookies) {
    const pair = header.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator > 0) pairs.set(pair.slice(0, separator).trim(), pair.slice(separator + 1));
  }
  return pairs;
}

function withCookies(cookieHeader: string | null, added: Map<string, string>): string {
  const merged = new Map<string, string>();
  for (const part of (cookieHeader ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0)
      merged.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  for (const [name, value] of added) merged.set(name, value);
  return [...merged].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** The original request's headers — host, forwarding, cookies, client IP — minus its body. */
function forwardedHeaders(request: Request, cookies: Map<string, string> = new Map()): Headers {
  const headers = new Headers(request.headers);
  for (const name of BODY_HEADERS) headers.delete(name);
  const cookie = withCookies(request.headers.get('cookie'), cookies);
  if (cookie) headers.set('cookie', cookie);
  else headers.delete('cookie');
  return headers;
}

function seeOther(location: string, setCookies: string[] = []): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const cookie of setCookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

function backToLogin(error: LoginErrorKey, callbackUrl: string): Response {
  const params = new URLSearchParams({ [LOGIN_ERROR_PARAM]: error });
  if (callbackUrl !== safeCallbackUrl(null)) params.set('callbackUrl', callbackUrl);
  return seeOther(`/login?${params}`);
}

/** The Auth.js error code, mapped exactly as the hydrated forms map it. */
function credentialsErrorKey(code: string | null): LoginErrorKey {
  switch (code) {
    case '2fa_required':
      return '2fa-required';
    case '2fa_invalid':
      return '2fa-invalid';
    case 'sso_required':
      return 'sso-required';
    case 'suspended':
      return 'suspended';
    case 'rate_limited':
      return 'rate-limited';
    default:
      return 'invalid';
  }
}

type CallbackResult =
  { ok: true; setCookies: string[] } | { ok: false; code: string | null; setCookies: string[] };

/**
 * What `signIn(provider, { redirect: false })` from `next-auth/react` does:
 * fetch a CSRF token, then post the credentials to the provider's callback.
 */
async function authCallback(
  request: Request,
  origin: string,
  provider: 'credentials' | 'login-intent',
  fields: Record<string, string>,
  extraCookies: Map<string, string> = new Map()
): Promise<CallbackResult> {
  const csrfResponse = await handlers.GET(
    new NextRequest(`${origin}/api/auth/csrf`, {
      method: 'GET',
      headers: forwardedHeaders(request, extraCookies),
    })
  );
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken?: string };
  const csrfCookies = csrfResponse.headers.getSetCookie();
  if (!csrfToken) return { ok: false, code: null, setCookies: [] };

  const cookies = new Map([...extraCookies, ...cookiePairs(csrfCookies)]);
  const headers = forwardedHeaders(request, cookies);
  headers.set('content-type', 'application/x-www-form-urlencoded');
  headers.set('x-auth-return-redirect', '1');

  const response = await handlers.POST(
    new NextRequest(`${origin}/api/auth/callback/${provider}`, {
      method: 'POST',
      headers,
      body: new URLSearchParams({ ...fields, csrfToken, callbackUrl: `${origin}/login` }),
    })
  );
  const setCookies = [...csrfCookies, ...response.headers.getSetCookie()];
  const { url } = (await response.json().catch(() => ({}))) as { url?: string };
  if (!response.ok || !url) return { ok: false, code: null, setCookies };

  const params = new URL(url, origin).searchParams;
  if (params.has('error')) return { ok: false, code: params.get('code'), setCookies };
  return { ok: true, setCookies };
}

async function sharedHostSignIn(
  request: Request,
  origin: string,
  form: FormData,
  callbackUrl: string
): Promise<Response> {
  const headers = forwardedHeaders(request);
  headers.set('content-type', 'application/json');
  const check = await checkSharedCredentials(
    new Request(`${origin}/api/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email: formString(form, 'email'),
        password: formString(form, 'password'),
        callbackUrl,
      }),
    })
  );
  if (check.status === 429) return backToLogin('rate-limited', callbackUrl);

  const body = (await check.json().catch(() => ({}))) as {
    outcome?: string;
    organizations?: Array<{ id: string; ssoEnforced: boolean }>;
  };
  if (!check.ok || body.outcome === 'failed') return backToLogin('invalid', callbackUrl);

  const intentToken = cookiePairs(check.headers.getSetCookie()).get(LOGIN_INTENT_COOKIE) ?? '';
  const only = (body.organizations ?? []).filter((organization) => !organization.ssoEnforced);

  // Exactly one password-eligible workspace: the hydrated form continues
  // straight through, so this does too. A chooser, an SSO-only account or a
  // second factor needs the interactive form, so the unused intent is retired
  // rather than left in the table.
  if (body.outcome !== 'single' || only.length !== 1 || !intentToken) {
    await discardLoginIntent(intentToken);
    return backToLogin('continue', callbackUrl);
  }

  const result = await authCallback(
    request,
    origin,
    'login-intent',
    { organizationId: only[0].id, totp: '' },
    new Map([[LOGIN_INTENT_COOKIE, intentToken]])
  );
  if (!result.ok) {
    await discardLoginIntent(intentToken);
    const key = credentialsErrorKey(result.code);
    return backToLogin(
      key === 'suspended' || key === 'sso-required' ? key : 'continue',
      callbackUrl
    );
  }
  return seeOther(callbackUrl, result.setCookies);
}

export async function POST(request: Request) {
  // Login CSRF: a cross-site page must not be able to sign a browser into an
  // account of the attacker's choosing.
  if (!isSameOriginFormPost(request)) {
    return new Response('Not allowed.', { status: 403 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return backToLogin('invalid', safeCallbackUrl(null));
  }
  // D15: validated on the server, exactly as the page validates it.
  const callbackUrl = safeCallbackUrl(formString(form, 'callbackUrl') || null);
  const origin = publicRequestOrigin(request);

  try {
    if (isSharedHost(requestHost(request))) {
      return await sharedHostSignIn(request, origin, form, callbackUrl);
    }
    const result = await authCallback(request, origin, 'credentials', {
      email: formString(form, 'email'),
      password: formString(form, 'password'),
      totp: formString(form, 'totp'),
    });
    if (!result.ok) return backToLogin(credentialsErrorKey(result.code), callbackUrl);
    return seeOther(callbackUrl, result.setCookies);
  } catch (error) {
    // The name only: nothing from the submitted form may reach the log.
    console.error(
      '[login/submit] native sign-in failed:',
      error instanceof Error ? error.name : 'unknown'
    );
    return backToLogin('unavailable', callbackUrl);
  }
}
