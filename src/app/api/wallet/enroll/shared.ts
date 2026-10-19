import { z } from 'zod';

import { clientIp } from '@/lib/rate-limit';
import {
  isTenantLifecycleAccessible,
  requestHost,
  resolveOrganizationForRequest,
} from '@/lib/tenancy/host';

export const tokenSchema = z.string().regex(/^wel_[0-9a-hjkmnp-tv-z]{26}$/);
export const RATE_LIMITED = { ok: false, message: 'Please wait before trying again.' } as const;
export const INVALID = {
  ok: false,
  message: 'This enrollment request could not be completed.',
} as const;

export async function enrollmentContext(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host.toLowerCase() !== requestHost(request)) return null;
  const organization = await resolveOrganizationForRequest(request);
  if (!organization || !isTenantLifecycleAccessible(organization.status)) return null;
  return { organization, ip: clientIp(request) };
}

export function limited(retryAfter: number) {
  return Response.json(RATE_LIMITED, {
    status: 429,
    headers: { 'Retry-After': String(Math.max(1, retryAfter)) },
  });
}
