import { signOut } from 'next-auth/react';

import { clearCounterReadinessOkay } from '@/lib/pharmacy/counter-readiness-okay';
import { clearCounterShell } from '@/lib/pharmacy/counter-shell';

/**
 * Sign out of BOTH authentication and organization-selection state.
 *
 * On the shared host a half-finished login leaves a pending intent cookie. If
 * signing out only dropped the Auth.js session, the next person at the browser
 * could resume a workspace selection someone else's password unlocked. The
 * intent is invalidated server-side and its cookie cleared first, then the
 * session ends.
 *
 * The DELETE is best-effort: it is a no-op on hosts where no intent can exist,
 * and a network failure must never leave the user stuck signed in.
 */
export async function signOutEverything(callbackUrl = '/login') {
  // DEV-957: the offline counter page is stored for the person signed in now;
  // the next person at this computer must never be shown it. Never throws.
  const shellCleared = clearCounterShell();
  // DEV-970: the next person (or the next sign-in) sees the counter's sale checks in full.
  clearCounterReadinessOkay();
  try {
    await fetch('/api/login', { method: 'DELETE', credentials: 'include' });
  } catch {
    // Ignore — the intent is single-use and expires in five minutes regardless.
  }
  await shellCleared;
  await signOut({ callbackUrl });
}
