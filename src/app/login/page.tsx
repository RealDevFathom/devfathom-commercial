import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { Logo } from '@/components/brand/logo';
import { LoginForm } from './login-form';
import { LoginHero } from './login-hero';
import { SharedLoginForm } from './shared-login-form';
import { headers } from 'next/headers';
import { resolveOrganizationByHost, TENANT_HOST_HEADER } from '@/lib/tenancy/host';
import { isSharedHost } from '@/lib/tenancy/host-routing';
import { safeCallbackUrl } from '@/lib/auth/callback-url';
import { LOGIN_ERROR_PARAM, loginErrorKey } from './login-errors';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { resolveOrganizationEntitlements } from '@/lib/entitlements';
import {
  ACCOUNT_INACTIVE_MESSAGE,
  SESSION_ENDED_MESSAGE,
  WORKSPACE_UNAVAILABLE_MESSAGE,
} from '@/lib/auth/session-state';

export const metadata: Metadata = {
  title: 'Sign in',
};

/**
 * #16: a session that ended must say so. The old guard redirected here silently
 * after telling the user their *account* was inactive — the wrong condition and
 * the wrong remedy. `signInRedirectPath` carries the accurate reason instead.
 */
const SIGN_OUT_NOTICES: Record<string, string> = {
  'session-ended': SESSION_ENDED_MESSAGE,
  'account-inactive': ACCOUNT_INACTIVE_MESSAGE,
  'workspace-unavailable': WORKSPACE_UNAVAILABLE_MESSAGE,
};

type LoginPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage(props: LoginPageProps) {
  // Use the workspace guard so expired sessions and host mismatches can sign in.
  const actor = await resolveTenantActor();
  if (actor?.session.user?.id) redirect('/dashboard');

  const searchParams = await props.searchParams;
  const reason = searchParams.reason;
  const notice = typeof reason === 'string' ? SIGN_OUT_NOTICES[reason] : undefined;
  // D15: the callback URL is validated on the SERVER before it reaches any
  // client component, so no consumer ever holds the caller's raw string.
  const callbackUrl = safeCallbackUrl(
    typeof searchParams.callbackUrl === 'string' ? searchParams.callbackUrl : null
  );
  // WHA-1623: a closed set of keys from /login/submit, never free text.
  const initialError = loginErrorKey(searchParams[LOGIN_ERROR_PARAM]);
  const requestHeaders = await headers();
  const host =
    requestHeaders.get(TENANT_HOST_HEADER) ??
    requestHeaders.get('x-forwarded-host') ??
    requestHeaders.get('host');
  // The shared host has no organization, so there is no per-tenant SSO to offer
  // and no slug in the URL. Credentials are proven first; workspaces come after.
  const shared = isSharedHost(host);
  const organization = shared ? null : await resolveOrganizationByHost(host);
  const identity = organization
    ? await withTenantDb(organization.id, async (db) => {
        const entitlements = await resolveOrganizationEntitlements(organization.id, db);
        if (!entitlements.enabledModules.includes('identity')) {
          return { connections: [], enforced: false };
        }
        const connections = await db.organizationIdentityConnection.findMany({
          where: { status: 'ACTIVE' },
          orderBy: { createdAt: 'asc' },
          select: { id: true, name: true, protocol: true, enforceSso: true },
        });
        return {
          connections,
          enforced: connections.some((connection) => connection.enforceSso),
        };
      })
    : { connections: [], enforced: false };

  return (
    <div className="min-h-dvh bg-background text-foreground lg:grid lg:grid-cols-[minmax(0,1.08fr)_minmax(26rem,0.92fr)]">
      {/* Blueprint field panel — desktop only */}
      <LoginHero />

      {/* Sign-in sheet */}
      <div className="relative flex min-h-dvh items-center justify-center px-5 py-10 sm:px-10">
        <div className="w-full max-w-[25rem] animate-slide-up">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <Logo variant="auto" size="md" textClassName="text-foreground" />
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted">
              Fieldbook / access
            </span>
          </div>

          <div className="border-l-2 border-primary pl-5 sm:pl-6">
            {/* Mobile logo */}
            {/* The shared form owns its heading because the heading changes with
                the step — "Welcome back" would be wrong on the selection screen.
                Either way the page renders exactly one <h1>. */}
            {shared ? null : (
              <div className="mb-8">
                <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-accent-brand">
                  Secure workspace access
                </p>
                <h1 className="mt-3 font-display text-[clamp(2rem,4vw,2.7rem)] font-semibold tracking-[-0.05em] text-foreground">
                  Welcome back
                </h1>
                <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
                  Sign in to pick up the work your team is moving forward.
                </p>
              </div>
            )}

            {notice ? (
              <p
                role="status"
                className="mb-5 border-l-2 border-accent-brand bg-muted px-4 py-3 text-sm leading-5 text-text-muted"
              >
                {notice}
              </p>
            ) : null}

            {shared ? (
              <SharedLoginForm callbackUrl={callbackUrl} initialError={initialError} />
            ) : (
              <LoginForm
                connections={identity.connections}
                ssoEnforced={identity.enforced}
                callbackUrl={callbackUrl}
                initialError={initialError}
              />
            )}
          </div>

          <p className="mt-8 text-xs text-muted-foreground">
            Need access? Contact your workspace admin.
          </p>
        </div>
      </div>
    </div>
  );
}
