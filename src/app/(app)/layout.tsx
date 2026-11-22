import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import {
  signInRedirectPath,
  workspaceRedirectForApprovalAuthenticator,
  workspaceRedirectForPasswordChange,
} from '@/lib/auth/session-state';
import { AppShell } from '@/components/layout/app-shell';
import { TenantSessionBoundary } from '@/components/tenant-session-boundary';
import {
  resolveTenantActor,
  resolveTenantSessionDenial,
  resolveTenantMismatchLoginPath,
} from '@/lib/tenancy/tenant-actor';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { resolveOrganizationEntitlements } from '@/lib/entitlements';
import { assertWorkspaceIdentity } from '@/lib/tenant-brand';
import { DemoToolbar } from '@/lib/demo/toolbar';

export async function generateMetadata(): Promise<Metadata> {
  const actor = await resolveTenantActor();
  return actor?.organization.isDemo
    ? { robots: { index: false, follow: false, nocache: true } }
    : {};
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // SEC-03 / AUTH-02: a single server-side auth guard for every /(app) page. The
  // edge proxy only checks cookie PRESENCE, so a stale/forged session cookie would
  // otherwise slip through and render a broken shell; verifying the session here
  // (auth() validates the JWT) sends it to a clean /login redirect instead, and
  // pages no longer each have to remember to call auth() themselves.
  // AUTH-01 / AUTH-03 / #16: a revoked session (its tokenVersion was bumped on
  // password change / lay-off / sign-out-everywhere), a deactivated account, a
  // suspended workspace, or a session whose state could not be verified is no
  // longer an actor at all — `resolveTenantActor` applies the SAME verdict the
  // tRPC guard applies, so the page and the API can never disagree about one
  // session. The reason travels to the login page so the user is told the
  // accurate remedy instead of "contact an administrator" for a dead session.
  const actor = await resolveTenantActor();
  if (!actor?.session.user?.id) {
    const correctHostLogin = await resolveTenantMismatchLoginPath();
    if (correctHostLogin) redirect(correctHostLogin);
    const denial = await resolveTenantSessionDenial();
    redirect(denial ? signInRedirectPath(denial) : '/login');
  }
  const passwordChange = workspaceRedirectForPasswordChange(actor.session.user.mustChangePassword);
  if (passwordChange) redirect(passwordChange);
  // DEV-961: a member who can approve must set up their approval authenticator first.
  const authenticatorSetup = workspaceRedirectForApprovalAuthenticator(
    actor.session.user.approvalAuthenticatorSetupRequired
  );
  if (authenticatorSetup) redirect(authenticatorSetup);
  const { entitlements, brand, pharmacyPlaceholder, pharmacyOnboarding } = await withTenantDb(
    actor.organization.id,
    async (db) => {
      const [entitlementSnapshot, organization, placeholderProfile] = await Promise.all([
        resolveOrganizationEntitlements(actor.organization.id, db),
        db.organization.findUnique({
          where: { id: actor.organization.id },
          select: {
            id: true,
            displayName: true,
            status: true,
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
        db.branchRegulatoryProfile.findFirst({
          where: { organizationId: actor.organization.id, isPlaceholder: true, effectiveTo: null },
          select: { id: true },
        }),
      ]);
      return {
        entitlements: { ...entitlementSnapshot, timeZone: actor.organization.timezone },
        brand: {
          // WHA-276: the chrome is only allowed to display an identity it can
          // attribute to a tenant, so the brand carries the organization it was
          // resolved for. `resolveTenantActor` has already proven this equals the
          // session's organizationId (host and session must agree, and the shared
          // host resolves by the session's own id).
          organizationId: actor.organization.id,
          displayName: organization?.displayName ?? actor.organization.displayName,
          logoUrl: organization?.brand?.logoUrl ?? null,
          markUrl: organization?.brand?.markUrl ?? null,
          faviconUrl: organization?.brand?.faviconUrl ?? null,
          primaryColor: organization?.brand?.primaryColor ?? null,
          accentColor: organization?.brand?.accentColor ?? null,
        },
        pharmacyPlaceholder: Boolean(placeholderProfile),
        pharmacyOnboarding: organization?.status === 'ONBOARDING',
      };
    }
  );
  assertWorkspaceIdentity(actor.session.user.organizationId, brand.organizationId);
  return (
    <TenantSessionBoundary
      session={actor.session}
      entitlements={entitlements}
      realtimeEnabled={Boolean(process.env.ABLY_API_KEY)}
    >
      <AppShell
        brand={brand}
        pharmacyPlaceholder={pharmacyPlaceholder}
        pharmacyOnboarding={pharmacyOnboarding}
      >
        {actor.organization.isDemo ? (
          <DemoToolbar seatName={actor.organization.displayName} />
        ) : null}
        {children}
      </AppShell>
    </TenantSessionBoundary>
  );
}
