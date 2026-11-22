import { clientIp, rateLimit } from '@/lib/rate-limit';
import { SSO_START_LIMITS } from '@/lib/sso-limits';
import { identityConnectionForOrganization } from '@/lib/sso';
import { requestHost, requireOrganizationForRequest } from '@/lib/tenancy/host';

async function checkGate(key: string, limit: number) {
  const gate = await rateLimit(`sso:start:${key}`, limit, SSO_START_LIMITS.windowMs);
  if (!gate.ok)
    return Response.json(
      { error: 'Too many sign-in attempts.' },
      {
        status: 429,
        headers: { 'Retry-After': String(gate.retryAfter) },
      }
    );
}

export async function admitSsoStart(
  request: Request,
  connectionId: string,
  protocol: 'OIDC' | 'SAML'
) {
  const sourceLimit = await checkGate(`ip:${clientIp(request)}`, SSO_START_LIMITS.source);
  if (sourceLimit) return sourceLimit;
  for (const [key, limit] of [
    ['overall', SSO_START_LIMITS.platform],
    [`host:${requestHost(request)}`, SSO_START_LIMITS.host],
    [`connection:${connectionId}`, SSO_START_LIMITS.connection],
  ] as const) {
    const blocked = await checkGate(key, limit);
    if (blocked) return blocked;
  }
  // Verified host aliases share the authoritative business bucket as soon as
  // host routing provides its ID, before entitlements or connections are read.
  const organization = await requireOrganizationForRequest(request);
  const blocked = await checkGate(`organization:${organization.id}`, SSO_START_LIMITS.business);
  if (blocked) return blocked;
  return identityConnectionForOrganization(organization.id, connectionId, protocol);
}
