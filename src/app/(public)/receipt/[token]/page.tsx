import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { SectionCard } from '@/components/ui/section-card';
import { openHostedReceipt } from '@/lib/pharmacy/hosted-receipt-service';
import {
  isTenantLifecycleAccessible,
  requestHost,
  resolveOrganizationByHost,
} from '@/lib/tenancy/host';
import { isSharedHost } from '@/lib/tenancy/host-routing';

import { ReceiptCodeForm } from './receipt-code-form';

export const dynamic = 'force-dynamic';

/** DEV-16: a private receipt link is never indexed or followed. */
export const metadata: Metadata = {
  title: 'Receipt',
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false },
  },
  referrer: 'no-referrer',
};

export default async function HostedReceiptPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const requestHeaders = await headers();
  const host = requestHost(new Request('http://local', { headers: requestHeaders }));
  if (isSharedHost(host)) notFound();
  const organization = await resolveOrganizationByHost(host);
  const access =
    organization &&
    organization.vertical === 'PHARMACY' &&
    isTenantLifecycleAccessible(organization.status)
      ? await openHostedReceipt(organization.id, token)
      : null;

  return (
    <main className="flex min-h-dvh items-start justify-center bg-surface-page px-4 py-10 text-text-body sm:items-center">
      <SectionCard className="w-full max-w-xl rounded-xl p-6 sm:p-8">
        <p className="font-mono text-xs tracking-[0.16em] text-text-muted uppercase">Receipt</p>
        {access ? (
          <>
            <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-text-strong">
              Receipt {access.summary.receiptNumber}
            </h1>
            <p className="mt-3 mb-6 leading-7 text-text-muted">
              Item details are protected. We will send a one-time code to the WhatsApp number on
              file{access.phoneLast4 ? ` ending ${access.phoneLast4}` : ''}.
            </p>
            <ReceiptCodeForm token={token} summary={access.summary} />
          </>
        ) : (
          <div role="status">
            <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-text-strong">
              This receipt link is no longer active
            </h1>
            <p className="mt-3 leading-7 text-text-muted">
              Receipt links expire. Ask the pharmacy to send your receipt again.
            </p>
          </div>
        )}
      </SectionCard>
    </main>
  );
}
