import type { Metadata } from 'next';
import { Logo } from '@/components/brand/logo';
import { LoginForm } from './login-form';
import { LoginHero } from './login-hero';
import { headers } from 'next/headers';
import { resolveOrganizationByHost, TENANT_HOST_HEADER } from '@/lib/tenancy/host';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { resolveOrganizationEntitlements } from '@/lib/entitlements';

export const metadata: Metadata = {
  title: 'Sign in',
};

export default async function LoginPage() {
  const requestHeaders = await headers();
  const organization = await resolveOrganizationByHost(
    requestHeaders.get(TENANT_HOST_HEADER) ??
      requestHeaders.get('x-forwarded-host') ??
      requestHeaders.get('host')
  );
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
            <div className="mb-8">
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-accent-brand">
                Secure workspace access
              </p>
              <h2 className="mt-3 font-display text-[clamp(2rem,4vw,2.7rem)] font-semibold tracking-[-0.05em] text-foreground">
                Welcome back
              </h2>
              <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
                Sign in to pick up the work your team is moving forward.
              </p>
            </div>

            <LoginForm connections={identity.connections} ssoEnforced={identity.enforced} />
          </div>

          <p className="mt-8 text-xs text-muted-foreground">
            Need access? Contact your workspace admin.
          </p>
        </div>
      </div>
    </div>
  );
}
