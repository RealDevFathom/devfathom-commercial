import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { SectionCard } from '@/components/ui/section-card';
import { resolveEnrollmentLink } from '@/lib/restaurant/wallet/enrollment';
import { requestHost, resolveOrganizationByHost } from '@/lib/tenancy/host';
import { isSharedHost } from '@/lib/tenancy/host-routing';

import { EnrollmentForm } from './enrollment-form';

export default async function WalletJoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const requestHeaders = await headers();
  const host = requestHost(new Request('http://local', { headers: requestHeaders }));
  if (isSharedHost(host)) notFound();
  const organization = await resolveOrganizationByHost(host);
  const link = organization ? await resolveEnrollmentLink(organization.id, token) : null;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface-page px-4 py-10 text-text-body">
      <SectionCard className="w-full max-w-lg rounded-xl p-6 sm:p-8">
        <p className="font-mono text-xs tracking-[0.16em] text-text-muted uppercase">
          Wallet enrollment
        </p>
        {link ? (
          <>
            <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-text-strong sm:text-4xl">
              Join {link.programDisplayName}
            </h1>
            <p className="mt-3 mb-7 leading-7 text-text-muted">
              Enroll at {link.branchName}. Verify your {link.phoneJoin?'phone':'email'} to request your wallet card.
            </p>
            <EnrollmentForm token={token} phoneJoin={link.phoneJoin} pharmacy={!!link.pharmacyBranchId} />
          </>
        ) : (
          <div role="status">
            <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-text-strong">
              This link is no longer active
            </h1>
            <p className="mt-3 leading-7 text-text-muted">
              Ask the business for its current wallet enrollment QR.
            </p>
          </div>
        )}
      </SectionCard>
    </main>
  );
}
