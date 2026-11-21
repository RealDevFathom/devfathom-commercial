'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { useState } from 'react';
import type { inferRouterOutputs } from '@trpc/server';

import { Button, buttonVariants } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';

type PortalRequest =
  inferRouterOutputs<AppRouter>['pharmacyOrdering']['portalQueue']['requests'][number];

const KIND_LABELS: Record<string, string> = {
  REFILL: 'Refill request',
  RX_ORDER: 'Prescription photo order',
  KHATA_PAYMENT: 'Raast khata payment',
};

const ERROR_MESSAGES: Record<string, string> = {
  PHONE_REQUIRED: 'Add a phone number to this customer’s patient record first.',
  CUSTOMER_NOT_FOUND: 'That customer is no longer active.',
  KIND_NOT_ALLOWED: 'Your role cannot decide this request.',
  INVALID_STATE: 'This request was already decided. Refresh the queue.',
  REQUEST_NOT_FOUND: 'This request was already decided. Refresh the queue.',
  DAY_CLOSED: 'Open the business day before recording a payment.',
  BUSINESS_DATE_NOT_CURRENT: 'Payments use today’s business date only. Refresh and try again.',
};

function money(minor: number, currency: string) {
  return new Intl.NumberFormat('en-PK', { style: 'currency', currency }).format(minor / 100);
}

/**
 * Staff side of the customer PWA (DEV-15 / #762): share a sign-in link with a
 * customer, and decide what customers send from the app. A prescription-photo
 * order or refill stays pending until a pharmacist verifies it.
 */
export function CustomerPortalPanel() {
  const utils = trpc.useUtils();
  const branchesQuery = trpc.pharmacyOrdering.branches.useQuery();
  const customersQuery = trpc.pharmacyOrdering.customers.useQuery(undefined, { retry: false });
  const [branchChoice, setBranchChoice] = useState('');
  const branchId = branchChoice || branchesQuery.data?.branches[0]?.id || '';
  const currency = branchesQuery.data?.currency ?? 'PKR';
  const queueQuery = trpc.pharmacyOrdering.portalQueue.useQuery(
    { branchId },
    { enabled: Boolean(branchId), retry: false }
  );
  const mint = trpc.pharmacyOrdering.portalLink.useMutation();
  const decide = trpc.pharmacyOrdering.portalDecide.useMutation();
  const confirm = trpc.pharmacyOrdering.portalConfirmPayment.useMutation();
  const [customerId, setCustomerId] = useState('');
  const [link, setLink] = useState('');
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; message: string } | null>(
    null
  );

  if (queueQuery.error?.data?.code === 'FORBIDDEN') return null;

  const fail = (error: { message: string }) =>
    setNotice({ tone: 'danger', message: ERROR_MESSAGES[error.message] ?? error.message });

  async function shareLink() {
    if (!branchId || !customerId) return;
    setNotice(null);
    try {
      const minted = await mint.mutateAsync({ branchId, customerId });
      setLink(new URL(minted.path, window.location.origin).toString());
    } catch (error) {
      fail(error as Error);
    }
  }

  async function act(request: PortalRequest, action: 'VERIFY' | 'REJECT' | 'CONFIRM') {
    setNotice(null);
    try {
      if (action === 'CONFIRM') {
        // The server books the payment on today's business date.
        const slip = await confirm.mutateAsync({ branchId, requestId: request.id });
        setNotice({ tone: 'success', message: `Payment recorded · ${slip.receiptReference}` });
      } else {
        await decide.mutateAsync({ branchId, requestId: request.id, decision: action });
        setNotice({
          tone: 'success',
          message: action === 'VERIFY' ? 'Request verified.' : 'Request rejected.',
        });
      }
      await utils.pharmacyOrdering.portalQueue.invalidate();
    } catch (error) {
      fail(error as Error);
    }
  }

  const queue = queueQuery.data;
  const busy = decide.isPending || confirm.isPending;
  // The shared text never names a medicine (WhatsApp policy): only the link.
  const whatsappHref = link
    ? `https://wa.me/?text=${encodeURIComponent(`Open your pharmacy account: ${link}`)}`
    : '';

  return (
    <SectionCard eyebrow="Customer app" title="Customer app requests">
      <div className="space-y-6">
        <p className="text-sm text-text-muted">
          Share a sign-in link, then verify prescription photos and refills, and confirm Raast khata
          payments.
        </p>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="portal-branch">Branch</Label>
            <StudioSelect
              id="portal-branch"
              value={branchId}
              onChange={(event) => setBranchChoice(event.target.value)}
              className="min-h-11 w-full rounded-sm border border-border bg-surface-raised px-3 text-sm text-text-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
            >
              {(branchesQuery.data?.branches ?? []).map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </StudioSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="portal-customer">Customer</Label>
            <StudioSelect
              id="portal-customer"
              value={customerId}
              onChange={(event) => {
                setCustomerId(event.target.value);
                setLink('');
              }}
              className="min-h-11 w-full rounded-sm border border-border bg-surface-raised px-3 text-sm text-text-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
            >
              <option value="">Choose a customer</option>
              {(customersQuery.data ?? []).map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.displayName}
                  {customer.phoneLast4 ? ` · ${customer.phoneLast4}` : ''}
                </option>
              ))}
            </StudioSelect>
          </div>
          <Button
            size="touch"
            onClick={shareLink}
            disabled={!customerId || !branchId || mint.isPending}
          >
            {mint.isPending ? 'Creating link…' : 'Create app link'}
          </Button>
        </div>

        {link ? (
          <div className="space-y-2 rounded-md border border-border-subtle bg-surface-sunken p-4">
            <p className="text-sm text-text-muted">
              The customer opens this link and signs in with a code sent to their phone.
            </p>
            <p className="font-mono text-xs break-all text-text-strong">{link}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void navigator.clipboard?.writeText(link)}
              >
                Copy link
              </Button>
              <a
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
                href={whatsappHref}
                target="_blank"
                rel="noreferrer"
              >
                Share on WhatsApp
              </a>
            </div>
          </div>
        ) : null}

        {notice ? (
          <p
            role={notice.tone === 'danger' ? 'alert' : 'status'}
            className={
              notice.tone === 'danger' ? 'text-sm text-destructive' : 'text-sm text-success'
            }
          >
            {notice.message}
          </p>
        ) : null}

        {queueQuery.isLoading ? (
          <p className="text-sm text-text-muted" role="status">
            Loading customer requests…
          </p>
        ) : queueQuery.error ? (
          <p className="text-sm text-destructive" role="alert">
            Customer requests could not be loaded. Refresh to try again.
          </p>
        ) : !queue?.requests.length ? (
          <p className="text-sm text-text-muted">No customer requests are waiting.</p>
        ) : (
          <ul className="divide-y divide-border-subtle" aria-label="Pending customer requests">
            {queue.requests.map((request) => {
              const clinical = request.kind === 'REFILL' || request.kind === 'RX_ORDER';
              return (
                <li key={request.id} className="flex flex-wrap items-start gap-3 py-4">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-text-strong">
                        {request.customer.displayName}
                      </span>
                      <StatusPill
                        status="pending"
                        label={clinical ? 'Needs pharmacist' : 'Check merchant account'}
                      />
                    </div>
                    <p className="text-sm text-text-body">
                      {KIND_LABELS[request.kind] ?? request.kind}
                      {request.refillSale ? ` · receipt ${request.refillSale.receiptNumber}` : ''}
                      {request.amountMinor != null
                        ? ` · ${money(request.amountMinor, currency)} · ref ${request.payerReference}`
                        : ''}
                    </p>
                    {request.note ? (
                      <p className="text-sm text-text-muted">“{request.note}”</p>
                    ) : null}
                    {request.prescriptionFileRef ? (
                      <a
                        className="text-sm text-primary underline-offset-4 hover:underline"
                        href={request.prescriptionFileRef}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View prescription photo
                      </a>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {clinical && queue.canVerifyPrescriptions ? (
                      <Button size="sm" disabled={busy} onClick={() => act(request, 'VERIFY')}>
                        Verify
                      </Button>
                    ) : null}
                    {!clinical && queue.canConfirmPayments ? (
                      <Button size="sm" disabled={busy} onClick={() => act(request, 'CONFIRM')}>
                        Confirm payment
                      </Button>
                    ) : null}
                    {(clinical && queue.canVerifyPrescriptions) ||
                    (!clinical && queue.canConfirmPayments) ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => act(request, 'REJECT')}
                      >
                        Reject
                      </Button>
                    ) : (
                      <span className="text-xs text-text-muted">
                        {clinical ? 'A pharmacist decides this.' : 'The counter confirms this.'}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </SectionCard>
  );
}
