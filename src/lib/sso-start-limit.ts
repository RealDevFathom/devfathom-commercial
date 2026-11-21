import { clientIp, rateLimit } from '@/lib/rate-limit';
import { identityConnectionForOrganization } from '@/lib/sso';
import { requestHost, requireOrganizationForRequest } from '@/lib/tenancy/host';

async function checkGate(key: string, limit: number) {
  const gate = await rateLimit(`sso:start:${key}`, limit, 60_000);
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
  // Both protocols use the same buckets. Charge overall first to bound the
  // number of distinct attacker-supplied keys admitted to the shared store.
  for (const [key, limit] of [
    ['overall', 600],
    [`ip:${clientIp(request)}`, 60],
    [`host:${requestHost(request)}`, 180],
    [`connection:${connectionId}`, 120],
  ] as const) {
    const blocked = await checkGate(key, limit);
    if (blocked) return blocked;
  }
  // Verified host aliases share the authoritative business bucket as soon as
  // host routing provides its ID, before entitlements or connections are read.
  const organization = await requireOrganizationForRequest(request);
  const blocked = await checkGate(`organization:${organization.id}`, 180);
  if (blocked) return blocked;
  return identityConnectionForOrganization(organization.id, connectionId, protocol);
}
