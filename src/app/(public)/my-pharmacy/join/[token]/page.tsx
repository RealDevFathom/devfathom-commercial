import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { SectionCard } from '@/components/ui/section-card';
import { resolvePortalLink } from '@/lib/pharmacy/customer-portal';
import { requestHost, resolveOrganizationByHost } from '@/lib/tenancy/host';
import { isSharedHost } from '@/lib/tenancy/host-routing';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

import { PortalSignInForm } from './sign-in-form';

export const dynamic = 'force-dynamic';

export default async function MyPharmacyJoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const requestHeaders = await headers();
  const host = requestHost(new Request('http://local', { headers: requestHeaders }));
  if (isSharedHost(host)) notFound();
  const organization = await resolveOrganizationByHost(host);
  const link = organization
    ? await withTenantDb(organization.id, async (db) => {
        const found = await resolvePortalLink(db, organization.id, token);
        return found ? { branchName: found.branch.name } : null;
      })
    : null;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface-page px-4 py-10 text-text-body">
      <SectionCard className="w-full max-w-lg rounded-xl p-6 sm:p-8">
        <p className="font-mono text-xs tracking-[0.16em] text-text-muted uppercase">My pharmacy</p>
        {link ? (
          <>
            <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-text-strong sm:text-4xl">
              Sign in to {link.branchName}
            </h1>
            <p className="mt-3 mb-7 leading-7 text-text-muted">
              We will send a six-digit code to the phone number the pharmacy has on file for you.
            </p>
            <PortalSignInForm token={token} />
          </>
        ) : (
          <div role="status">
            <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-text-strong">
              This link is no longer active
            </h1>
            <p className="mt-3 leading-7 text-text-muted">
              Ask the pharmacy to send you a new link.
            </p>
          </div>
        )}
      </SectionCard>
    </main>
  );
}
