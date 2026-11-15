import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { HydrationBoundary } from '@tanstack/react-query';
import { createSSRHelpers } from '@/lib/trpc-server';
import { DashboardContent } from './dashboard-content';
import { RestaurantDashboardContent } from './restaurant-dashboard-content';
import { PharmacyDashboardContent } from './pharmacy-dashboard-content';
import {
  PHARMACIST_LANDING_CAPABILITIES,
  PharmacistHome,
  pharmacistLanding,
} from './pharmacist-home';
import { HotelDashboardContent } from './hotel-dashboard-content';
import { FirstRunChecklist } from '@/components/onboarding/first-run-checklist';
import { loadSetupChecklist } from '@/lib/onboarding/setup-evaluator';
import { loadHotelLanding } from '@/lib/hotel/landing';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { can, subjectFromSession } from '@/lib/abac';
import { hotelPropertyRouter } from '@/server/routers/hotel-property';

export const metadata: Metadata = {
  title: 'Dashboard',
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<{ landing?: string | string[] }>;
}) {
  const signInLanding = (await searchParams)?.landing === '1';
  const ssr = await createSSRHelpers();
  const helpers = ssr?.helpers;
  const restaurant = ssr?.entitlements.vertical === 'RESTAURANT';
  const pharmacy = ssr?.entitlements.vertical === 'PHARMACY';
  const hospitality = ssr?.entitlements.vertical === 'HOSPITALITY';

  // Apply role-based routing only to a fresh sign-in. Explicit dashboard visits
  // must retain the management overview, saved preferences and first-run checklist.
  if (signInLanding && restaurant && ssr?.session?.user) {
    redirect(ssr.session.user.role === 'ADMIN' ? '/restaurant' : '/pos');
  }

  const firstRunVertical =
    ssr?.entitlements.vertical === 'RESTAURANT' || ssr?.entitlements.vertical === 'PHARMACY'
      ? ssr.entitlements.vertical
      : null;
  const organizationId = ssr?.organization?.id;
  const user = ssr?.session?.user;
  const checklist =
    organizationId && firstRunVertical && user
      ? await withTenantDb(organizationId, async (db) =>
          (await can(subjectFromSession(user), 'admin:access', undefined, { db }))
            ? loadSetupChecklist(db, organizationId, firstRunVertical)
            : null
        )
      : null;

  // DEV-95: the owner command centre reads only `reports:operational` data.
  // Ask the ABAC engine the report procedures use, server-side, for just the
  // capabilities this decision needs. A pharmacist without report access lands
  // on their own queue after sign-in and sees a pharmacist home on an explicit
  // visit, never a command centre whose branch read the server refuses.
  const pharmacyCapabilities =
    pharmacy && organizationId && user
      ? await withTenantDb(organizationId, async (db) => {
          const subject = subjectFromSession(user);
          const held = await Promise.all(
            PHARMACIST_LANDING_CAPABILITIES.map(async (action) =>
              (await can(subject, action, undefined, { db })) ? action : null
            )
          );
          return held.filter((action) => action !== null);
        }).catch((error: unknown) => {
          // Fall back to the command centre, whose own report reads stay
          // server-gated: a member without reports:operational sees its
          // Restricted state there, never an owner's figures.
          console.error('[dashboard] pharmacy access read unavailable', {
            error: error instanceof Error ? error.name : 'Error',
          });
          return null;
        })
      : null;
  const pharmacist = pharmacyCapabilities
    ? pharmacistLanding(pharmacyCapabilities, ssr?.entitlements.enabledModules)
    : null;
  if (signInLanding && pharmacist?.home) redirect(pharmacist.home);

  // Prefetch above-the-fold data on the server so it arrives hydrated. The
  // client QueryClient has staleTime 60s, so hydrated data is "fresh" and the
  // `useQuery` calls in DashboardContent serve it from cache on mount instead
  // of firing a client round-trip (no skeleton flash).
  //
  // `dashboard.getRevenueChart` is intentionally NOT prefetched: it is the
  // heaviest query and admin-only, so we keep it off the TTFB path and let it
  // load client-side after paint (KPI cards stay the priority for LCP).
  //
  // `.prefetch()` never throws — react-query captures errors into the cache, so
  // an UNAUTHORIZED/FORBIDDEN result degrades gracefully to the client fetch.
  if (helpers && !restaurant && !pharmacy && !hospitality) {
    await Promise.all([
      helpers.dashboard.getStats.prefetch(),
      helpers.dashboard.getRecentActivity.prefetch(),
      helpers.dashboard.getUpcomingDeadlines.prefetch(),
      helpers.dashboard.getProjectCards.prefetch(),
      helpers.dashboard.getMyTasks.prefetch(),
      helpers.meetings.getUpcoming.prefetch(),
      helpers.team.getAll.prefetch(),
    ]);
  }

  // H1: a hospitality workspace lands on its property setup, read through the
  // hotel property router (same `hotel:property-admin` gate as the settings
  // pages) rather than the agency widgets.
  const hotelLanding =
    hospitality && ssr?.ctx
      ? await loadHotelLanding(hotelPropertyRouter.createCaller(ssr.ctx))
      : null;

  return (
    <HydrationBoundary state={helpers?.dehydrate()}>
      {hospitality && hotelLanding ? (
        <HotelDashboardContent
          landing={hotelLanding}
          organizationName={ssr.organization?.displayName ?? 'Your properties'}
          isAdmin={ssr.session?.user?.role === 'ADMIN'}
        />
      ) : pharmacy && pharmacist ? (
        <PharmacistHome tools={pharmacist.tools} />
      ) : pharmacy ? (
        <PharmacyDashboardContent role={ssr.session?.user?.role} />
      ) : restaurant ? (
        <RestaurantDashboardContent
          enabledModules={ssr.entitlements.enabledModules}
          checklist={checklist ?? undefined}
        />
      ) : (
        <>
          {checklist ? <FirstRunChecklist checklist={checklist} /> : null}
          <DashboardContent />
        </>
      )}
    </HydrationBoundary>
  );
}
