import { signOut } from 'next-auth/react';

/**
 * Sign out of BOTH authentication and organization-selection state.
 *
 * On the shared host a half-finished login leaves a pending intent cookie. If
 * signing out only dropped the Auth.js session, the next person at the browser
 * could resume a workspace selection someone else's password unlocked. The
 * intent is invalidated server-side and its cookie cleared first, then the
 * session ends.
 *
 * The DELETE is best-effort: it 404s on a tenant host (where no intent exists),
 * and a network failure must never leave the user stuck signed in.
 */
export async function signOutEverything(redirectTo = '/login') {
  try {
    await fetch('/api/login', { method: 'DELETE', credentials: 'include' });
  } catch {
    // Ignore — the intent is single-use and expires in five minutes regardless.
  }
  // Auth.js v5 names the post-sign-out destination `redirectTo`. Using the old
  // v4 `callbackUrl` option can fall back to the current tenant page instead of
  // the tenant login after the CSRF-protected sign-out POST completes.
  await signOut({ redirectTo });
}
