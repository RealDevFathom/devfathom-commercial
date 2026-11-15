'use client';

import { useSyncExternalStore } from 'react';

function subscribeConnection(changed: () => void) {
  window.addEventListener('online', changed);
  window.addEventListener('offline', changed);
  return () => {
    window.removeEventListener('online', changed);
    window.removeEventListener('offline', changed);
  };
}

/**
 * The browser's own connection signal. React Query pauses requests on the same
 * signal and resumes them when it returns, so the counter can say so instead of
 * leaving the cashier on a bare "Taking payment…". Server render assumes online.
 */
export function useBrowserOnline(): boolean {
  return useSyncExternalStore(
    subscribeConnection,
    () => navigator.onLine,
    () => true
  );
}
