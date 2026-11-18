import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { HydrationBoundary } from '@tanstack/react-query';
import { createSSRHelpers } from '@/lib/trpc-server';
import { DashboardContent } from './dashboard-content';
import { RestaurantDashboardContent } from './restaurant-dashboard-content';
import { PharmacyDashboardContent } from './pharmacy-dashboard-content';
import { PharmacyStaffHome } from './pharmacy-staff-home';
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
import { canOpenPharmacyCommandCentre, loadPharmacyStaffHome } from '@/lib/pharmacy/staff-home';
import { readPharmacyApprovalStatus } from '@/lib/pharmacy/onboarding';
import { PharmacyApprovalNotice } from '@/components/pharmacy/approval-notice';
import {
  showsPharmacyApprovalNotice,
  type PharmacyApprovalStatus,
} from '@/lib/pharmacy/approval-status';

export const metadata: Metadata = {
  title: 'Dashboard',
};

/**
 * DEV-905: a pharmacy waiting for (or just given) DevFathom approval sees a notice above
 * its home. Without one, the home is returned as it is.
 */
function withPharmacyApprovalNotice(
  home: React.ReactElement,
  approval: PharmacyApprovalStatus | null,
  canFinishOnboarding: boolean
): React.ReactElement {
  if (!showsPharmacyApprovalNotice(approval, new Date())) return home;
  return (
    <div className="min-w-0 space-y-6">
      <PharmacyApprovalNotice approval={approval} canFinishOnboarding={canFinishOnboarding} />
      {home}
    </div>
  );
}

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

  const organizationId = ssr?.organization?.id;
  const user = ssr?.session?.user;
  // Only fresh sign-ins choose an operational landing. Read effective grants
  // through the tenant-scoped ABAC engine (including role/override DENYs), and
  // mirror the POS page's module gate so a grant cannot land on a disabled POS.
  // Everyone else keeps the restaurant overview and its quick-access links.
  if (signInLanding && restaurant && organizationId && user) {
    const target = await withTenantDb(organizationId, async (db) => {
      const subject = subjectFromSession(user);
      if (await can(subject, 'admin:access', undefined, { db })) return '/restaurant';
      if (
        ssr.entitlements.enabledModules.includes('restaurant-pos') &&
        (await can(subject, 'orders:take', undefined, { db }))
      )
        return '/pos';
      return null;
    });
    if (target) redirect(target);
  }

  const firstRunVertical =
    ssr?.entitlements.vertical === 'RESTAURANT' || ssr?.entitlements.vertical === 'PHARMACY'
      ? ssr.entitlements.vertical
      : null;
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
  // DEV-602: should DEV-20's staff home below be unavailable, a member who holds no
  // operational-reports grant (the cashier template) still gets a pharmacy home, never the
  // owner title and layout editor. The administrator keeps the command centre, as in DEV-20,
  // and unknown access (a failed read) keeps the server-gated command centre.
  const reportAccess = pharmacyCapabilities
    ? user?.role === 'ADMIN' || pharmacyCapabilities.includes('reports:operational')
    : undefined;

  // DEV-20: after DEV-95's pharmacist home, only the owner/administrator or a manager who holds
  // the operational-reports grant gets the Owner command centre. Every other pharmacy member
  // lands on their own staff home, decided here on the server from their grants, never from a
  // client-side flag. Like DEV-95, an unavailable access read falls back to the command centre,
  // whose own report reads stay server-gated.
  const pharmacyStaffHome =
    pharmacy && organizationId && user && !pharmacist
      ? await withTenantDb(organizationId, async (db) =>
          (await canOpenPharmacyCommandCentre(db, user))
            ? null
            : loadPharmacyStaffHome(
                db,
                organizationId,
                user,
                ssr?.entitlements.enabledModules ?? []
              )
        ).catch((error: unknown) => {
          console.error('[dashboard] pharmacy staff home unavailable', {
            error: error instanceof Error ? error.name : 'Error',
          });
          return null;
        })
      : null;

  // DEV-905: whether DevFathom has approved this pharmacy, read on every load so the
  // notice changes the moment a super admin approves it, with no sign-out. Additive: a
  // failed read hides the notice and leaves the rest of the dashboard as it was.
  const pharmacyApproval =
    pharmacy && organizationId && user
      ? await withTenantDb(organizationId, (db) =>
          readPharmacyApprovalStatus(db, organizationId)
        ).catch((error: unknown) => {
          console.error('[dashboard] pharmacy approval status unavailable', {
            error: error instanceof Error ? error.name : 'Error',
          });
          return null;
        })
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
        withPharmacyApprovalNotice(
          pharmacist ? (
            <PharmacistHome tools={pharmacist.tools} />
          ) : pharmacyStaffHome ? (
            <PharmacyStaffHome home={pharmacyStaffHome} />
          ) : (
            <PharmacyDashboardContent role={ssr.session?.user?.role} reportAccess={reportAccess} />
          ),
          pharmacyApproval,
          checklist !== null
        )
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
