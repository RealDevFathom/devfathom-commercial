'use server';

import { signOut } from '@/lib/auth';

/**
 * End the tenant session through Auth.js' server API.
 *
 * Invoking this as a Server Action keeps sign-out a same-origin POST protected
 * by Next.js' Server Action origin checks; it must not be replaced with a link
 * to Auth.js' POST-only `/api/auth/signout` endpoint.
 */
export async function tenantSignOut() {
  await signOut({ redirectTo: '/login' });
}
