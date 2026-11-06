import { signOut } from 'next-auth/react';

import { clearAllDayCloseDrafts } from '@/components/pharmacy/counter/day-close-draft-storage';

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
  // Drafts of in-progress day closes are this user's; never leave them in the tab.
  clearAllDayCloseDrafts();
  try {
    await fetch('/api/login', { method: 'DELETE', credentials: 'include' });
  } catch {
    // Ignore — the intent is single-use and expires in five minutes regardless.
  }
  await signOut({ callbackUrl });
}
