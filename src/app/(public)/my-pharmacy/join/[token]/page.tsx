import { headers } from 'next/headers';

import { SectionCard } from '@/components/ui/section-card';
import { PORTAL_LINK_PATTERN } from '@/lib/pharmacy/customer-portal';
import {
  portalSyntheticSender,
  portalWhatsAppReady,
  reportPortalFailure,
} from '@/lib/pharmacy/portal-delivery';
import { portalSignInMessages } from '@/lib/pharmacy/portal-sign-in-messages';
import {
  resolveOrganizationForRequest,
  requestHost,
  isTenantLifecycleAccessible,
} from '@/lib/tenancy/host';

import { PortalSignInForm } from './sign-in-form';

export const dynamic = 'force-dynamic';

async function joinMessage(request: Request, token: string) {
  try {
    const organization = await resolveOrganizationForRequest(request);
    if (
      !organization ||
      !isTenantLifecycleAccessible(organization.status) ||
      !PORTAL_LINK_PATTERN.test(token)
    )
      return portalSignInMessages.invalidLink;
    if (
      !portalWhatsAppReady(organization.id) &&
      !portalSyntheticSender(organization, requestHost(request))
    )
      return portalSignInMessages.setup;
    return null;
  } catch {
    reportPortalFailure('UNEXPECTED');
    return portalSignInMessages.unexpected;
  }
}

export default async function MyPharmacyJoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const requestHeaders = await headers();
  const request = new Request('http://local', { headers: requestHeaders });
  const message = await joinMessage(request, token);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface-page px-4 py-10 text-text-body">
      <SectionCard className="w-full max-w-lg rounded-xl p-6 sm:p-8">
        <p className="font-mono text-xs tracking-[0.16em] text-text-muted uppercase">My pharmacy</p>
        <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-text-strong sm:text-4xl">
          Sign in to your pharmacy
        </h1>
        {message ? (
          <p role="status" className="mt-3 leading-7 text-text-muted">
            {message}
          </p>
        ) : (
          <>
            <p className="mt-3 mb-7 leading-7 text-text-muted">
              Request a six-digit code for the phone number the pharmacy has on file for you.
            </p>
            <PortalSignInForm token={token} />
          </>
        )}
      </SectionCard>
    </main>
  );
}
