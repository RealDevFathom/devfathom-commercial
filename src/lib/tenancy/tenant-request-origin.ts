import { trustedRequestOrigin } from '@/lib/http-origin';
import { requestHost } from './host';

/** Non-browser clients can omit Origin. Browser requests must match both the
 * public origin (including its port) and the tenant selected for routing. */
export function matchesTenantRequestOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  try {
    const expected = trustedRequestOrigin(request);
    return origin.toLowerCase() === expected && new URL(expected).hostname === requestHost(request);
  } catch {
    return false;
  }
}
