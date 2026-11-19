import { randomUUID } from 'node:crypto';
import Link from 'next/link';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  AP_REVERSAL_MAX_PAGE,
  AP_REVERSAL_PAGE_ROWS,
} from '@/lib/pharmacy/accounts/ap-invoices-schema';
import { formatWorkspaceDateTime } from '@/lib/timezone';
import type { pharmacyApInvoicesRouter } from '@/server/routers/pharmacy-ap-invoices';
import { ReversalNoticeArea, ReverseApEntryForm } from './ap-entry-forms';
import { minor } from './payables-panels';
import type { ReversalSearchField, ReversalSearchQuery } from './query';

type Caller = ReturnType<typeof pharmacyApInvoicesRouter.createCaller>;
export type ReversibleInvoices = Awaited<ReturnType<Caller['reversalSearch']>>['invoices'];
export type ReversalAccess = Awaited<ReturnType<Caller['reversalAccess']>>;

const AGING_PATH = '/pharmacy/accounts/ap-aging';

/** The aging request the reversal search keeps when it searches or turns a page. */
export type AgingContext = { branchId: string; asOf: string; payeeFilter?: string };

function pageHref(context: AgingContext, search: ReversalSearchQuery, page: number) {
  const params = new URLSearchParams({ branch: context.branchId, asOf: context.asOf });
  if (context.payeeFilter) params.set('payeeFilter', context.payeeFilter);
  const names: Record<ReversalSearchField, string> = {
    payee: 'rvPayee',
    reference: 'rvRef',
    amount: 'rvAmount',
    from: 'rvFrom',
    to: 'rvTo',
  };
  for (const [field, name] of Object.entries(names) as [ReversalSearchField, string][])
    if (search.values[field]) params.set(name, search.values[field]);
  if (page > 1) params.set('rvPage', String(page));
  return `${AGING_PATH}?${params.toString()}#reverse`;
}

/**
 * DEV-103: find an older invoice or payment to reverse. A GET form, so a search is a link that
 * can be reloaded or shared; it keeps the aging request above it.
 */
function ReversalSearchForm({
  context,
  search,
  zone,
}: {
  context: AgingContext;
  search: ReversalSearchQuery;
  zone: string;
}) {
  const fields: {
    field: ReversalSearchField;
    name: string;
    label: string;
    type?: 'date';
    inputMode?: 'decimal';
    maxLength?: number;
  }[] = [
    { field: 'payee', name: 'rvPayee', label: 'Supplier (payee)', maxLength: 160 },
    { field: 'reference', name: 'rvRef', label: 'Reference or supplier invoice', maxLength: 80 },
    { field: 'amount', name: 'rvAmount', label: 'Amount', inputMode: 'decimal', maxLength: 20 },
    { field: 'from', name: 'rvFrom', label: `From (${zone} day)`, type: 'date' },
    { field: 'to', name: 'rvTo', label: `To (${zone} day)`, type: 'date' },
  ];
  const filtered = Object.values(search.values).some(Boolean);
  return (
    <form
      method="get"
      action={`${AGING_PATH}#reverse`}
      role="search"
      aria-label="Find an invoice or payment to reverse"
      className="mt-4 grid items-start gap-4 rounded-[var(--radius-sm)] border border-border-subtle bg-surface-sunken p-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      <input type="hidden" name="branch" value={context.branchId} />
      <input type="hidden" name="asOf" value={context.asOf} />
      {context.payeeFilter ? (
        <input type="hidden" name="payeeFilter" value={context.payeeFilter} />
      ) : null}
      {fields.map(({ field, name, label, type, inputMode, maxLength }) => {
        const error = search.errors[field];
        const errorId = `reversal-search-${field}-error`;
        return (
          <label key={field} className="grid gap-2 text-sm">
            {label}
            <Input
              className="min-h-11"
              name={name}
              type={type ?? 'text'}
              inputMode={inputMode}
              maxLength={maxLength}
              defaultValue={search.values[field]}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
            />
            {error ? (
              <span id={errorId} className="text-sm text-destructive">
                {error}
              </span>
            ) : null}
          </label>
        );
      })}
      <div className="flex flex-wrap items-center gap-3 self-end sm:col-span-2 lg:col-span-1">
        <Button type="submit" className="min-h-11">
          Search
        </Button>
        {filtered ? (
          <Link
            href={pageHref(
              context,
              { ...search, values: { payee: '', reference: '', amount: '', from: '', to: '' } },
              1
            )}
            className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
          >
            Clear
          </Link>
        ) : null}
      </div>
    </form>
  );
}

function Pager({
  context,
  search,
  hasOlder,
}: {
  context: AgingContext;
  search: ReversalSearchQuery;
  hasOlder: boolean;
}) {
  if (search.page <= 1 && !hasOlder) return null;
  return (
    <nav aria-label="Reversal search pages" className="mt-3 flex flex-wrap items-center gap-3">
      {search.page > 1 ? (
        <Link
          href={pageHref(context, search, search.page - 1)}
          className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
        >
          Newer invoices
        </Link>
      ) : null}
      <span className="font-mono text-xs text-text-muted uppercase">Page {search.page}</span>
      {hasOlder && search.page >= AP_REVERSAL_MAX_PAGE ? (
        // The search serves no deeper page; a link would land back on page 1.
        <span className="text-sm text-text-muted">
          Older invoices are past page {AP_REVERSAL_MAX_PAGE}. Narrow the search to reach them.
        </span>
      ) : hasOlder ? (
        <Link
          href={pageHref(context, search, search.page + 1)}
          className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
        >
          Older invoices
        </Link>
      ) : null}
    </nav>
  );
}

/**
 * DEV-103: the reversal screen. Posted supplier expense invoices on the branch that match the
 * search, newest first, a page at a time, with their payments still in force. A payment is reversed on its own; an invoice only once
 * nothing settles it. Each reversal needs a manager or owner PIN and a reason, and someone else
 * must approve an entry you recorded unless nobody else can. The router enforces all of it; this
 * only decides which form or plain line to show.
 */
export function ReversalPanel({
  branchId,
  invoices,
  access,
  timeZone,
  context,
  search,
  hasOlder,
  zone,
}: {
  branchId: string;
  invoices: ReversibleInvoices;
  access: ReversalAccess;
  timeZone: string | null | undefined;
  context: AgingContext;
  search: ReversalSearchQuery;
  hasOlder: boolean;
  zone: string;
}) {
  const filtered = Object.values(search.values).some(Boolean);
  const ownEntryLine = (createdBy: string) =>
    createdBy === access.actorId && access.otherApprover
      ? `You recorded this, so ${access.otherApprover.name ?? 'another manager or owner'} or another manager or owner must reverse it.`
      : null;
  return (
    <SectionCard id="reverse" title="Reverse an invoice or payment" titleLevel={2}>
      <p className="text-sm text-text-muted">
        A reversal never edits or deletes the original: it posts a mirror entry dated now and keeps
        both on record. A reversed payment makes the invoice owe that amount again. An invoice can
        be reversed only after every payment and approved credit set-off against it is reversed. It
        needs a manager or owner PIN and a reason, and a closed accounting period refuses it.
      </p>
      {access.mayReverse ? (
        <ReversalSearchForm context={context} search={search} zone={zone} />
      ) : null}
      <ReversalNoticeArea>
        {!access.mayReverse ? (
          <p role="status" className="mt-3 text-sm text-text-muted">
            Only a manager or owner can reverse a supplier expense invoice or payment.
          </p>
        ) : !search.search ? (
          <p role="alert" className="mt-3 text-sm text-text-muted">
            Fix the search above. Nothing was searched.
          </p>
        ) : invoices.length === 0 ? (
          <>
            <p className="mt-3 text-sm text-text-muted">
              {filtered
                ? search.page > 1
                  ? 'No more posted supplier expense invoices match this search.'
                  : 'No posted supplier expense invoice on this branch matches this search. Change or clear the search.'
                : search.page > 1
                  ? 'No more posted supplier expense invoices on this branch.'
                  : 'No posted supplier expense invoice on this branch to reverse.'}
            </p>
            <Pager context={context} search={search} hasOlder={false} />
          </>
        ) : (
          <>
            <p role="status" className="mt-3 text-sm text-text-muted">
              {filtered ? 'Matching posted invoices' : 'Posted invoices'}, newest invoice date
              first, {AP_REVERSAL_PAGE_ROWS} a page. A payment matches by its own amount or day.
            </p>
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
            <Pager context={context} search={search} hasOlder={hasOlder} />
          </>
        )}
      </ReversalNoticeArea>
    </SectionCard>
  );
}
