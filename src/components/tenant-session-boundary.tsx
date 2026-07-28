'use client';

import type { Session } from 'next-auth';
import { SessionProvider } from 'next-auth/react';
import { RealtimeProvider } from '@/components/chat/realtime-provider';
import { EntitlementsProvider } from '@/components/entitlements-provider';
import type { EntitlementView } from '@/lib/module-catalog';

/**
 * Supplies the server-validated effective tenant session to every client hook.
 * This is also what lets an audited support session use the normal application
 * UI without manufacturing an Auth.js token.
 */
export function TenantSessionBoundary({
  session,
  entitlements,
  realtimeEnabled,
  children,
}: {
  session: Session;
  entitlements: EntitlementView;
  realtimeEnabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <SessionProvider session={session} refetchOnWindowFocus={false}>
      <EntitlementsProvider value={entitlements}>
        <RealtimeProvider enabled={realtimeEnabled}>{children}</RealtimeProvider>
      </EntitlementsProvider>
    </SessionProvider>
  );
}
