'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * DEV-44: a shell notice the member has dismissed stays dismissed for that member
 * in that organization, on this browser, across pages and reloads. A `null` key
 * (the session is not known yet) is never dismissed. When storage is blocked the
 * dismissal still holds until the page is reloaded; it never throws.
 */
const listeners = new Set<() => void>();
const dismissedThisPage = new Set<string>();

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

function readDismissed(key: string | null) {
  if (!key) return false;
  if (dismissedThisPage.has(key)) return true;
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function dismissedNoticeKey(
  notice: string,
  organizationId: string | null | undefined,
  userId: string | null | undefined
) {
  return organizationId && userId
    ? `devfathom:notice-dismissed:${notice}:${organizationId}:${userId}`
    : null;
}

export function useDismissedNotice(key: string | null) {
  const dismissed = useSyncExternalStore(
    subscribe,
    () => readDismissed(key),
    // The server cannot see the member's choice, so it renders the notice.
    () => false
  );
  const dismiss = useCallback(() => {
    if (!key) return;
    dismissedThisPage.add(key);
    try {
      window.localStorage.setItem(key, '1');
    } catch {
      // Storage is blocked; the notice returns on the next page load.
    }
    for (const listener of listeners) listener();
  }, [key]);
  return [dismissed, dismiss] as const;
}
