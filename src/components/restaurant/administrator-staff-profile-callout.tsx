'use client';

import { useState, useSyncExternalStore } from 'react';
import { Loader2, UserRoundPlus, X } from 'lucide-react';
import { useSession } from 'next-auth/react';
import { toast } from 'sonner';

import { useEntitlements } from '@/components/entitlements-provider';
import { Button } from '@/components/ui/button';
import { isModuleGranted } from '@/lib/module-catalog';
import { trpc } from '@/lib/trpc';

function subscribeToDismissal(onChange: () => void) {
  window.addEventListener('storage', onChange);
  return () => window.removeEventListener('storage', onChange);
}

/**
 * WHA-1181 — organizations activated before administrators were provisioned a
 * `RestaurantStaffProfile` leave their administrator in a workspace whose nav
 * renders while every restaurant call answers 403.
 *
 * This is deliberately a call to action and not a 403 banner: the denial is a
 * missing one-time setup step, so the shell offers the step rather than
 * narrating the error. It renders only for an administrator of a workspace that
 * is actually granted restaurant operations, only once the query has confirmed
 * the profile is absent, and it disappears the moment the profile exists — so a
 * healthy workspace never sees it, and a repaired one stops seeing it without a
 * reload.
 *
 * The relevance test is the `restaurant-core` module grant read through the
 * module catalog, not the organization's vertical: §2.3 keeps vertical branching
 * inside the catalog and the platform command layer, and a module grant is the
 * more precise question anyway — it is exactly what decides whether the denied
 * surfaces are reachable at all.
 */
export function AdministratorStaffProfileCallout() {
  const { data: session } = useSession();
  const entitlements = useEntitlements();
  const utils = trpc.useUtils();
  const dismissalKey = session?.user?.id
    ? `devfathom:staff-profile-dismissed:${session.user.organizationId}:${session.user.id}`
    : null;
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const persistedDismissal = useSyncExternalStore(
    subscribeToDismissal,
    () => {
      try {
        return dismissalKey ? window.localStorage.getItem(dismissalKey) === '1' : false;
      } catch {
        return false;
      }
    },
    () => true
  );

  const isRestaurantAdministrator =
    isModuleGranted('restaurant-core', entitlements.enabledModules) &&
    session?.user?.role === 'ADMIN';

  // Gated rather than filtered: a non-administrator (and every agency user)
  // never issues the request at all.
  const { data } = trpc.restaurantStaff.mySelfProfile.useQuery(undefined, {
    enabled: isRestaurantAdministrator,
  });

  const provision = trpc.restaurantStaff.provisionMyProfile.useMutation({
    onSuccess: async () => {
      toast.success('Your staff profile is ready.');
      // Both the callout's own check and every restaurant query that was being
      // denied are now stale — invalidating the root refetches them together.
      await utils.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  // Loading and error both render nothing. A shell-level strip that flashes on
  // every navigation, or that reports its own failure, would be more noise than
  // the quiet 403 state it exists to replace.
  if (
    !isRestaurantAdministrator ||
    !data ||
    data.hasProfile ||
    persistedDismissal ||
    (dismissalKey && dismissedFor === dismissalKey)
  )
    return null;

  return (
    <div
      data-slot="administrator-staff-profile-callout"
      className="flex flex-col gap-2 border-b border-border-default bg-surface-sunken px-4 py-2 text-xs text-text-body sm:flex-row sm:items-center sm:justify-between"
    >
      <span className="flex items-start gap-2 sm:items-center">
        <UserRoundPlus aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 sm:mt-0" />
        <span>
          <span className="font-semibold text-text-strong">Set up your staff profile</span> —
          restaurant operations, notifications and the terminal need one before they can show you
          anything.
        </span>
      </span>
      <div className="flex shrink-0 items-center gap-2 self-start sm:self-auto">
        <Button
          type="button"
          disabled={provision.isPending}
          aria-busy={provision.isPending}
          onClick={() => provision.mutate()}
        >
          {provision.isPending ? (
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 motion-safe:animate-spin" />
          ) : null}
          {provision.isPending ? 'Setting up…' : 'Set up now'}
        </Button>
        {dismissalKey && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Dismiss staff profile reminder"
            onClick={() => {
              setDismissedFor(dismissalKey);
              try {
                window.localStorage.setItem(dismissalKey, '1');
              } catch {
                // Storage may be blocked; dismissal still lasts for this mounted workspace.
              }
            }}
          >
            <X aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}
