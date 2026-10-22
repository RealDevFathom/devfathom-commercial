import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { HydrationBoundary } from '@tanstack/react-query';
import { createSSRHelpers } from '@/lib/trpc-server';
import { DashboardContent } from './dashboard-content';
import { RestaurantDashboardContent } from './restaurant-dashboard-content';
import { PharmacyDashboardContent } from './pharmacy-dashboard-content';
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

export default async function DashboardPage() {
  const ssr = await createSSRHelpers();
  const helpers = ssr?.helpers;
  const restaurant = ssr?.entitlements.vertical === 'RESTAURANT';
  const pharmacy = ssr?.entitlements.vertical === 'PHARMACY';
  const hospitality = ssr?.entitlements.vertical === 'HOSPITALITY';
  const firstRunVertical =
    ssr?.entitlements.vertical === 'RESTAURANT' || ssr?.entitlements.vertical === 'PHARMACY'
      ? ssr.entitlements.vertical
      : null;
  const organizationId = ssr?.organization?.id;
  const user = ssr?.session?.user;
  const access =
    organizationId && firstRunVertical && user
      ? await withTenantDb(organizationId, async (db) => {
          const subject = subjectFromSession(user);
          const hasAdminAccess = await can(subject, 'admin:access', undefined, { db });
          const takeOrders =
            restaurant && !hasAdminAccess
              ? await can(subject, 'orders:take', undefined, { db })
              : false;

          return {
            checklist: hasAdminAccess
              ? await loadSetupChecklist(db, organizationId, firstRunVertical)
              : null,
            takeOrders,
          };
        })
      : { checklist: null, takeOrders: false };

  // Restaurant operators who can actually take orders land at the POS. Every
  // decision goes through the central ABAC evaluator, so role/override DENYs
  // win and a kitchen, inventory, or finance persona stays on the useful
  // restaurant dashboard instead of being classified by its coarse User.role.
  // Administrators retain the management dashboard even when their role also
  // carries the broad order-taking grant.
  if (access.takeOrders) redirect('/pos');

  const checklist = access.checklist;

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
