'use client';

import { useSession } from 'next-auth/react';
import { useEntitlements } from '@/components/entitlements-provider';
import { trpc } from '@/lib/trpc';
import { accountRoleView, type AccountRoleView } from '@/lib/team/account-role';

/**
 * The signed-in member's own role and department, as the header and the
 * Settings account card both show it. Reads the caller's own profile (account
 * self-service, no module licence needed) for the assigned organization role.
 */
export function useAccountRole(): AccountRoleView & { ready: boolean } {
  const { data: session } = useSession();
  const { vertical } = useEntitlements();
  const userId = session?.user?.id ?? '';
  const profile = trpc.team.getById.useQuery({ id: userId }, { enabled: Boolean(userId) });
  const view = accountRoleView({
    vertical,
    role: session?.user?.role,
    department: session?.user?.department,
    organizationRole: profile.data?.organizationRole ?? null,
  });
  return { ...view, ready: Boolean(session?.user) && !profile.isLoading };
}
