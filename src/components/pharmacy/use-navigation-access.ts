'use client';

import { useSession } from 'next-auth/react';
import { useEntitlements } from '@/components/entitlements-provider';
import { evaluateSessionUser } from '@/lib/auth/session-state';
import { trpc } from '@/lib/trpc';

const NO_CAPABILITIES: readonly string[] = [];

/**
 * DEV-240: the pharmacy rail's capability read, keyed by the signed-in member
 * and the tenant. A switch of user or workspace asks again instead of reusing
 * another identity's answer, and the server refuses a key that is not the
 * caller's own. Only an answer for the current member and tenant is used; a
 * failed read grants nothing.
 */
export function usePharmacyNavigationAccess(scopeEnabled: boolean) {
  const { data: session } = useSession();
  const entitlements = useEntitlements();
  const user = session?.user;
  const organizationId = entitlements.organizationId;
  const enabled = Boolean(
    scopeEnabled &&
    user?.id &&
    organizationId &&
    user.organizationId === organizationId &&
    evaluateSessionUser(user).ok
  );
  const query = trpc.pharmacyAccess.navigation.useQuery(
    { userId: user?.id ?? '', organizationId: organizationId ?? '' },
    {
      enabled,
      // A transient failure must not leave the rail without entries the member
      // holds; only an authorization refusal is final.
      retry: (failures, error) => failures < 2 && error.data?.code !== 'FORBIDDEN',
      staleTime: 0,
    }
  );
  const current = Boolean(
    enabled &&
    !query.isError &&
    query.data?.userId === user?.id &&
    query.data?.organizationId === organizationId
  );
  return {
    query,
    capabilities: current && query.data ? query.data.capabilities : NO_CAPABILITIES,
  };
}
