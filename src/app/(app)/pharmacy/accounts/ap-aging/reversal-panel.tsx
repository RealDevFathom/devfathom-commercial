import { randomUUID } from 'node:crypto';

import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { formatWorkspaceDateTime } from '@/lib/timezone';
import type { pharmacyApInvoicesRouter } from '@/server/routers/pharmacy-ap-invoices';
import { ReversalNoticeArea, ReverseApEntryForm } from './ap-entry-forms';
import { minor } from './payables-panels';

type Caller = ReturnType<typeof pharmacyApInvoicesRouter.createCaller>;
export type ReversibleInvoices = Awaited<ReturnType<Caller['list']>>['invoices'];
export type ReversalAccess = Awaited<ReturnType<Caller['reversalAccess']>>;

/** How many of the newest posted invoices the panel offers for reversal. */
export const REVERSAL_PANEL_ROWS = 50;

/**
 * DEV-103: the reversal screen. Every posted supplier expense invoice on the branch, newest
 * first, with its payments still in force. A payment is reversed on its own; an invoice only once
 * nothing settles it. Each reversal needs a manager or owner PIN and a reason, and someone else
 * must approve an entry you recorded unless nobody else can. The router enforces all of it; this
 * only decides which form or plain line to show.
 */
export function ReversalPanel({
  branchId,
  invoices,
  access,
  timeZone,
}: {
  branchId: string;
  invoices: ReversibleInvoices;
  access: ReversalAccess;
  timeZone: string | null | undefined;
}) {
  const ownEntryLine = (createdBy: string) =>
    createdBy === access.actorId && access.otherApprover
      ? `You recorded this, so ${access.otherApprover.name ?? 'another manager or owner'} or another manager or owner must reverse it.`
      : null;
  return (
    <SectionCard title="Reverse an invoice or payment" titleLevel={2}>
      <p className="text-sm text-text-muted">
        A reversal never edits or deletes the original: it posts a mirror entry dated now and keeps
        both on record. A reversed payment makes the invoice owe that amount again. An invoice can
        be reversed only after every payment and approved credit set-off against it is reversed. It
        needs a manager or owner PIN and a reason, and a closed accounting period refuses it.
      </p>
      <ReversalNoticeArea>
        {!access.mayReverse ? (
          <p role="status" className="mt-3 text-sm text-text-muted">
            Only a manager or owner can reverse a supplier expense invoice or payment.
          </p>
        ) : invoices.length === 0 ? (
          <p className="mt-3 text-sm text-text-muted">
            No posted supplier expense invoice on this branch to reverse.
          </p>
        ) : (
          <>
            {invoices.length >= REVERSAL_PANEL_ROWS ? (
              <p className="mt-3 text-sm text-text-muted">
                Showing the {REVERSAL_PANEL_ROWS} newest posted invoices.
              </p>
            ) : null}
            <ul className="mt-3 divide-y divide-border-subtle">
              {invoices.map((invoice) => {
                const active = invoice.settlements.filter((s) => s.status === 'ACTIVE');
                const invoiceOwn = ownEntryLine(invoice.createdByUserId);
                return (
                  <li key={invoice.id} className="grid gap-3 py-4">
                    <p className="text-sm">
                      <span className="font-medium">{invoice.reference}</span>{' '}
                      <span className="font-mono tabular-nums">
                        {invoice.currency} {minor(invoice.amountMinor)}
                      </span>{' '}
                      <span className="text-text-muted">
                        · {invoice.payeeName} · {invoice.supplierInvoiceRef} · dated{' '}
                        {invoice.invoiceDate.toISOString().slice(0, 10)}
                      </span>
                    </p>
                    {active.length ? (
                      <ul className="grid gap-3 rounded-[var(--radius-sm)] border border-border-subtle bg-surface-sunken p-3">
                        {active.map((payment) => {
                          const paymentOwn = ownEntryLine(payment.createdByUserId);
                          const label = `${minor(payment.amountMinor)} against ${invoice.reference}`;
                          return (
                            <li key={payment.id} className="grid gap-3">
                              <p className="flex flex-wrap items-center gap-2 text-sm">
                                <StatusPill status="ACTIVE" tone="neutral" label="Payment" />
                                <span className="font-mono tabular-nums">
                                  {invoice.currency} {minor(payment.amountMinor)}
                                </span>
                                <span className="text-text-muted">
                                  · paid {formatWorkspaceDateTime(payment.paidAt, timeZone)} from{' '}
                                  {payment.fundingAccount === 'CASH' ? 'cash' : 'bank'}
                                </span>
                              </p>
                              {paymentOwn ? (
                                <p className="text-sm text-text-muted">{paymentOwn}</p>
                              ) : (
                                <ReverseApEntryForm
                                  kind="payment"
                                  branchId={branchId}
                                  targetId={payment.id}
                                  label={label}
                                  initialKey={`ap-payment-rev:${randomUUID()}`}
                                />
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                    {active.length ? (
                      <p className="text-sm text-text-muted">
                        Reverse {active.length === 1 ? 'its payment' : 'its payments'} first to
                        reverse this invoice.
                      </p>
                    ) : invoiceOwn ? (
                      <p className="text-sm text-text-muted">{invoiceOwn}</p>
                    ) : (
                      <ReverseApEntryForm
                        kind="invoice"
                        branchId={branchId}
                        targetId={invoice.id}
                        label={invoice.reference}
                        initialKey={`ap-invoice-rev:${randomUUID()}`}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </ReversalNoticeArea>
    </SectionCard>
  );
}
