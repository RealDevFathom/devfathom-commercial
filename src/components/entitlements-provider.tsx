'use client';

import { createContext, useContext } from 'react';
import type { EntitlementView } from '@/lib/module-catalog';

const EntitlementsContext = createContext<EntitlementView | null>(null);

export function EntitlementsProvider({
  value,
  children,
}: {
  value: EntitlementView;
  children: React.ReactNode;
}) {
  return <EntitlementsContext.Provider value={value}>{children}</EntitlementsContext.Provider>;
}

export function useEntitlements(): EntitlementView {
  const entitlements = useContext(EntitlementsContext);
  if (!entitlements) throw new Error('EntitlementsProvider is missing.');
  return entitlements;
}

/** The verified tenant's clock, including for screens mounted outside the workspace shell. */
export function useWorkspaceTimeZone() {
  return useContext(EntitlementsContext)?.timeZone ?? 'UTC';
}
