'use client';

import { createContext, useContext, type MouseEvent } from 'react';

import type { TenantBrand } from '@/lib/tenant-brand';

/**
 * DEV-977: what the application shell lends a route that draws its own top bar.
 *
 * On such a route the shell renders neither the workspace top bar nor the module
 * navigation row. The route's own bar shows the workspace identity from `brand` and
 * opens the shell's navigation drawer (the same menus as the workspace bar) with
 * `openNavigation`, so every destination the workspace bar offered stays reachable.
 */
export type ShellChrome = {
  brand: TenantBrand;
  openNavigation: (event: MouseEvent<HTMLButtonElement>) => void;
};

const ShellChromeContext = createContext<ShellChrome | null>(null);

export const ShellChromeProvider = ShellChromeContext.Provider;

/** Null outside the shell, or on a route that keeps the workspace bar. */
export function useShellChrome(): ShellChrome | null {
  return useContext(ShellChromeContext);
}

/**
 * Routes whose page draws its own top bar and action row in place of the workspace
 * top section. The pharmacy counter is used all day at one till: its own bar carries
 * the branch, drawer and connection state the cashier needs instead.
 */
export function routeOwnsChrome(pathname: string): boolean {
  return pathname === '/pharmacy/counter';
}
