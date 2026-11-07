import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { AuthShell } from '@/components/auth/auth-shell';
import { LoginForm } from './login-form';
import { loginVertical, verticalCopy, workspaceEyebrow } from './vertical';
import { SharedLoginForm } from './shared-login-form';
import { headers } from 'next/headers';
import { resolveOrganizationByHost, TENANT_HOST_HEADER } from '@/lib/tenancy/host';
import { isSharedHost } from '@/lib/tenancy/host-routing';
import { isUnknownTenantHost } from '@/lib/tenancy/unknown-tenant-host';
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
  const requestedCallback = safeCallbackUrl(
    typeof searchParams.callbackUrl === 'string' ? searchParams.callbackUrl : null
  );
  const callbackUrl =
    requestedCallback === '/dashboard' && !searchParams.callbackUrl
      ? '/dashboard?landing=1'
      : requestedCallback;
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
  // A mistyped workspace subdomain gets the branded 404, never a sign-in form
  // (or an error) for a workspace that does not exist.
  if (!shared && !organization && (await isUnknownTenantHost(host, async () => organization))) {
    notFound();
  }
  const vertical = loginVertical(searchParams.vertical, host, organization?.vertical);
  const copy = verticalCopy[vertical];
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
    <AuthShell vertical={vertical}>
      <div className="min-w-0">
        {/* Mobile logo */}
        {/* The shared form owns its heading because the heading changes with
                the step — "Welcome back" would be wrong on the selection screen.
                Either way the page renders exactly one <h1>. */}
        {shared ? null : (
          <div className="mb-8">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-accent-brand">
              {workspaceEyebrow(vertical)}
            </p>
            <h1 className="mt-3 font-display text-[clamp(2rem,4vw,2.7rem)] font-semibold tracking-[-0.05em] text-foreground">
              Welcome back
            </h1>
            <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
              {copy.signIn}
            </p>
          </div>
        )}

        {notice ? (
          <p
            role="status"
            className="mb-5 border-s-2 border-accent-brand bg-muted px-4 py-3 text-sm leading-5 text-text-muted"
          >
            {notice}
          </p>
        ) : null}

        {shared ? (
          <SharedLoginForm
            callbackUrl={callbackUrl}
            initialError={initialError}
            vertical={vertical}
          />
        ) : (
          <LoginForm
            vertical={vertical}
            connections={identity.connections}
            ssoEnforced={identity.enforced}
            callbackUrl={callbackUrl}
            initialError={initialError}
          />
        )}
      </div>

      {vertical === 'restaurant' && (
        <div className="mt-7 rounded-[var(--radius-md)] border border-border-subtle bg-surface-card p-5 text-sm">
          <p className="font-semibold">On a till or kitchen screen?</p>
          <p className="mt-2 text-xs leading-5 text-text-muted">
            Enrolled devices unlock with a staff PIN. Servers and cooks don’t need an email to sign
            in there.
          </p>
          <a className="studio-auth-link mt-4 block" href="/login/till">
            Unlock a till with your PIN →
          </a>
        </div>
      )}
      <div className="mt-8 border-t border-border-subtle pt-6 text-sm">
        <p className="text-text-muted">{copy.opening}</p>
        <a
          className="studio-auth-link mt-2 inline-block"
          href={`/login/register${vertical === 'default' ? '' : `?vertical=${vertical}`}`}
        >
          {copy.setup} →
        </a>
      </div>
      <p className="mt-6 text-xs leading-6 text-muted-foreground">
        {vertical === 'pharmacy'
          ? 'Pharmacist or counter staff? Your account comes by invite. Need access? Contact your workspace admin.'
          : vertical === 'restaurant'
            ? 'Managers get their accounts by invite. Need access? Contact your workspace admin.'
            : 'Need access? Contact your workspace admin.'}
      </p>
    </AuthShell>
  );
}
