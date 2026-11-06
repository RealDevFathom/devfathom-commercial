'use client';

import { createContext, useContext, type Dispatch, type SetStateAction } from 'react';

export type CounterMobileChrome = {
  branchName: string | null;
  connectionLabel: string;
  moreOpen: boolean;
  openMore: ((trigger: HTMLElement) => void) | null;
};

export const CounterMobileChromeContext = createContext<Dispatch<
  SetStateAction<CounterMobileChrome | null>
> | null>(null);

export function useCounterMobileChrome() {
  return useContext(CounterMobileChromeContext);
}
