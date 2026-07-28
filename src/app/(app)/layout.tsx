import { redirect } from 'next/navigation';
import { ACTIVE_STATUSES } from '@/lib/abac';
import { AppShell } from '@/components/layout/app-shell';
import { TenantSessionBoundary } from '@/components/tenant-session-boundary';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { resolveOrganizationEntitlements } from '@/lib/entitlements';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // SEC-03 / AUTH-02: a single server-side auth guard for every /(app) page. The
  // edge proxy only checks cookie PRESENCE, so a stale/forged session cookie would
  // otherwise slip through and render a broken shell; verifying the session here
  // (auth() validates the JWT) sends it to a clean /login redirect instead, and
  // pages no longer each have to remember to call auth() themselves.
  const actor = await resolveTenantActor();
  if (!actor?.session.user?.id) redirect('/login');
  // AUTH-01 / AUTH-03: a deactivated, deleted, or session-REVOKED token (its
  // tokenVersion was bumped on password change / lay-off / sign-out-everywhere)
  // is no longer allowed to render the app — send it to a clean re-login. Lenient
  // on a missing status to avoid locking out older valid tokens (mirrors ABAC).
  if (actor.session.user.status && !ACTIVE_STATUSES.has(actor.session.user.status)) {
    redirect('/login');
  }
  const { entitlements, brand } = await withTenantDb(actor.organization.id, async (db) => {
    const [entitlementSnapshot, organization] = await Promise.all([
      resolveOrganizationEntitlements(actor.organization.id, db),
      db.organization.findUnique({
        where: { id: actor.organization.id },
        select: {
          displayName: true,
          brand: {
            select: {
              logoUrl: true,
              markUrl: true,
              faviconUrl: true,
              primaryColor: true,
              accentColor: true,
            },
          },
        },
      }),
    ]);
    return {
      entitlements: entitlementSnapshot,
      brand: {
        displayName: organization?.displayName ?? actor.organization.displayName,
        logoUrl: organization?.brand?.logoUrl ?? null,
        markUrl: organization?.brand?.markUrl ?? null,
        faviconUrl: organization?.brand?.faviconUrl ?? null,
        primaryColor: organization?.brand?.primaryColor ?? '#465A4B',
        accentColor: organization?.brand?.accentColor ?? '#B14E32',
      },
    };
  });
  return (
    <TenantSessionBoundary
      session={actor.session}
      entitlements={entitlements}
      realtimeEnabled={Boolean(process.env.ABLY_API_KEY)}
    >
      <AppShell brand={brand}>{children}</AppShell>
    </TenantSessionBoundary>
  );
}
