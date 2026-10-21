import 'server-only';

import { redirect } from 'next/navigation';
import { requirePlatformSession, type PlatformIdentity } from '@/lib/platform/auth';
import {
  canReadPlatformRoute,
  platformSafeFallback,
  type PlatformReadHref,
} from '@/lib/platform/read-policy';
import { PlatformSecurityError } from '@/lib/platform/security';

export async function requirePlatformRead(href: PlatformReadHref): Promise<PlatformIdentity> {
  let identity: PlatformIdentity;
  try {
    identity = await requirePlatformSession();
  } catch (error) {
    if (error instanceof PlatformSecurityError && error.status === 401) {
      redirect('/platform/login');
    }
    throw error;
  }
  if (canReadPlatformRoute(identity.role, href)) return identity;

  const fallback = platformSafeFallback(identity.role);
  if (fallback && fallback !== href) redirect(fallback);
  throw new PlatformSecurityError('You do not have permission to view the platform console.', 403);
}
