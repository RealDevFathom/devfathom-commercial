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
    // WHA-276: the tenant-identity invariant is enforced by comparing the live
    // session's organizationId against the organization the chrome is showing,
    // so the client has to be allowed to notice that the cookie changed. With
    // refetching disabled a tab left open on organization A never re-reads
    // /api/auth/session, so it would keep rendering A's identity over B's data
    // indefinitely. Focus is the exact moment the user returns to a stale tab.
    <SessionProvider session={session} refetchOnWindowFocus>
      <EntitlementsProvider value={entitlements}>
        <RealtimeProvider enabled={realtimeEnabled}>{children}</RealtimeProvider>
      </EntitlementsProvider>
    </SessionProvider>
  );
}
