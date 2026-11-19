import { signOut } from 'next-auth/react';

import { clearCounterShell } from '@/lib/pharmacy/counter-shell';

/** Loaded only when signing out, so the counter store never weighs on other pages. */
async function clearOfflineCounterDrafts(): Promise<void> {
  try {
    const [{ discardCounterDrafts }, { readCounterEnrolmentMirror }, { createCounterIndexedDbDriver }] =
      await Promise.all([
        import('@/lib/pharmacy/counter-offline-session'),
        import('@/lib/pharmacy/counter-device-store'),
        import('@/lib/pharmacy/counter-offline-runtime'),
      ]);
    const enrolment = readCounterEnrolmentMirror();
    if (enrolment) await discardCounterDrafts(enrolment, createCounterIndexedDbDriver());
  } catch {
    // Never keeps anyone signed in.
  }
}

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
  // DEV-957 phase 2: and an offline bill they were building is not left for the next
  // person. Queued sales stay: that money was taken and must still be sent.
  const draftsCleared = clearOfflineCounterDrafts();
  try {
    await fetch('/api/login', { method: 'DELETE', credentials: 'include' });
  } catch {
    // Ignore — the intent is single-use and expires in five minutes regardless.
  }
  await shellCleared;
  await draftsCleared;
  await signOut({ callbackUrl });
}
