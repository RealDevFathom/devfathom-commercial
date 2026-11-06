'use client';

import { createContext, useContext } from 'react';

/** Null means Studio's existing module navigation remains in place. */
export const CounterNavigationContext = createContext<(() => void) | null>(null);

export function useCounterNavigation() {
  return useContext(CounterNavigationContext);
}
