import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

/**
 * WHA-1623 — false in the server HTML and during hydration, true once React
 * owns the form. The sign-in forms publish it as `data-hydrated`, which is what
 * the browser suites wait on before typing: a submit that lands earlier is the
 * native POST to `/login/submit`, not the client handler under test.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
}
