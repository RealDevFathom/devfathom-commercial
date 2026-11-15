'use client';

import { useSession } from 'next-auth/react';
import { useEntitlements } from '@/components/entitlements-provider';
import { evaluateSessionUser } from '@/lib/auth/session-state';
import { isModuleGranted } from '@/lib/module-catalog';
import { trpc } from '@/lib/trpc';

/** The rail and day-close screen consume only a current, tenant-bound server decision. */
export function usePharmacyNavigationAccess() {
  const { data: session } = useSession();
  const entitlements = useEntitlements();
  const user = session?.user;
  const enabled = Boolean(
    user?.id &&
    user.organizationId === entitlements.organizationId &&
    evaluateSessionUser(user).ok &&
    entitlements.vertical === 'PHARMACY' &&
    isModuleGranted('pharmacy-core', entitlements.enabledModules)
  );
  const query = trpc.pharmacyAccess.navigation.useQuery(
    { userId: user?.id ?? '', organizationId: entitlements.organizationId ?? '' },
    {
      enabled,
      retry: (failures, error) => failures < 2 && error.data?.code !== 'FORBIDDEN',
      staleTime: 0,
      refetchOnMount: 'always',
      // A focus refresh must not unmount a day-close form with unsaved counts.
      refetchOnWindowFocus: false,
    }
  );
  const current =
    enabled &&
    !query.isError &&
    !query.isFetching &&
    query.data?.userId === user?.id &&
    query.data?.organizationId === entitlements.organizationId;
  return { ...query, data: current ? query.data : undefined };
}
