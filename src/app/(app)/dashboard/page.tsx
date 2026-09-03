import type { Metadata } from 'next';
import { HydrationBoundary } from '@tanstack/react-query';
import { createSSRHelpers } from '@/lib/trpc-server';
import { DashboardContent } from './dashboard-content';
import { RestaurantDashboardContent } from './restaurant-dashboard-content';
import { FirstRunChecklist } from '@/components/onboarding/first-run-checklist';
import { loadSetupChecklist } from '@/lib/onboarding/setup-evaluator';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

export const metadata: Metadata = {
  title: 'Dashboard',
};

export default async function DashboardPage() {
  const ssr = await createSSRHelpers();
  const helpers = ssr?.helpers;
  const restaurant = ssr?.entitlements.vertical === 'RESTAURANT';
  const firstRunVertical =
    ssr?.entitlements.vertical === 'RESTAURANT' || ssr?.entitlements.vertical === 'PHARMACY'
      ? ssr.entitlements.vertical
      : null;
  const organizationId = ssr?.organization?.id;
  const checklist =
    organizationId && firstRunVertical && ssr?.session?.user?.role === 'ADMIN'
      ? await withTenantDb(organizationId, (db) =>
          loadSetupChecklist(db, organizationId, firstRunVertical)
        )
      : null;

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
  if (helpers && !restaurant) {
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

  return (
    <HydrationBoundary state={helpers?.dehydrate()}>
      {restaurant ? (
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
