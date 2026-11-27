import { passwordResetRequestInput } from '@/lib/auth/anonymous-inputs';
import { enqueuePasswordReset } from '@/lib/auth/password-reset-request';
import { readBoundedJson } from '@/lib/http/read-bounded-body';
import { rateLimit } from '@/lib/rate-limit';
import { requestHost } from '@/lib/tenancy/host';
import { parseCookie } from '@/lib/platform/security';
import { SUPPORT_SESSION_COOKIE } from '@/lib/tenancy/support-session';
import {
  isSupportSessionActor,
  SUPPORT_SESSION_REFUSED_MESSAGE,
} from '@/lib/tenancy/support-session-rule';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { ipFromHeaders } from '@/server/audit';
import { recordSupportSessionRefusal } from '@/server/support-session-refusal';

/** Byte-identical for every outcome, so it can never probe for accounts. */
const NEUTRAL = { ok: true };

export async function POST(request: Request) {
  // DEV-1053: a platform support session may not start a password reset. A request that
  // carries a live support session is refused before the body is read, and recorded with
  // the operator's identity. Only a request with the support cookie is looked up at all, so
  // a visitor without one is served exactly as before; a stale cookie, or a member the
  // resolver turns away for its own reasons, is a visitor too.
  if (parseCookie(request.headers.get('cookie'), SUPPORT_SESSION_COOKIE)) {
    const actor = await resolveTenantActor({ request }).catch(() => null);
    if (actor && isSupportSessionActor(actor)) {
      await recordSupportSessionRefusal({
        actor: {
          organizationId: actor.organization.id,
          user: actor.session.user,
          support: actor.support,
          session: actor.session,
        },
        source: 'REST_API',
        category: 'AUTH',
        action: 'passwordReset.request',
        request,
      });
      return Response.json({ ok: false, error: SUPPORT_SESSION_REFUSED_MESSAGE }, { status: 403 });
    }
  }

  const ip = ipFromHeaders(request.headers) ?? 'unknown';

  let email: string;
  try {
    const body = await readBoundedJson(request, 4 * 1024);
    if (body.tooLarge) return Response.json(NEUTRAL, { status: 413 });
    email = passwordResetRequestInput.parse(body.value).email;
  } catch {
    return Response.json(NEUTRAL);
  }

  // Throttle per IP (broad) and per address so the endpoint cannot be used to
  // flood inboxes or probe. Both hit and miss paths are throttled identically,
  // and a throttled request returns the same body as a delivered one.
  const ipGate = await rateLimit(`pwreset:ip:${ip}`, 10, 15 * 60_000);
  const emailGate = await rateLimit(`pwreset:email:${email}`, 5, 15 * 60_000);
  if (!ipGate.ok || !emailGate.ok) return Response.json(NEUTRAL);

  await enqueuePasswordReset(email, { host: requestHost(request) }, ip);
  return Response.json(NEUTRAL);
}
