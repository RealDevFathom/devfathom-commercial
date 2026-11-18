import { randomUUID } from 'node:crypto';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { DUE_SOON_DAYS } from '@/lib/pharmacy/accounts/ap-payables-drafts';
import type { pharmacyApInvoicesRouter } from '@/server/routers/pharmacy-ap-invoices';
import { DecideCreditSetOffForms, RequestCreditSetOffForm } from './ap-entry-forms';

type Caller = ReturnType<typeof pharmacyApInvoicesRouter.createCaller>;
export type PayablesDrafts = Awaited<ReturnType<Caller['payablesDrafts']>>;
export type PendingSetOffs = Awaited<ReturnType<Caller['creditSetOffs']>>['setOffs'];

export function minor(value: number): string {
  const negative = value < 0;
  const absolute = Math.abs(value);
  return `${negative ? '-' : ''}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

const th = 'p-3 text-left';
const thNum = 'p-3 text-right';
const row = 'border-t border-border-subtle hover:bg-muted/40';

/**
 * DEV-694: per-distributor due-bill reminders from the same aging rows the page
 * shows (no second ageing). Read-only; nothing here sends a message.
 */
export function DueBillReminders({ drafts }: { drafts: PayablesDrafts }) {
  return (
    <SectionCard title="Due-bill reminders" titleLevel={2}>
      <p className="text-sm text-text-muted">
        Bills already overdue, and bills falling due within {DUE_SOON_DAYS} days, grouped by payee.
        {drafts.viewComplete ? '' : ' The aging read was capped, so this list may be partial.'}
      </p>
      {drafts.reminders.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">
          No bill is overdue or due within {DUE_SOON_DAYS} days.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="mt-3 w-full min-w-max text-sm tabular-nums">
            <thead className="font-mono text-xs uppercase">
              <tr>
                <th scope="col" className={th}>
                  Payee
                </th>
                <th scope="col" className={th}>
                  Status
                </th>
                <th scope="col" className={thNum}>
                  Overdue
                </th>
                <th scope="col" className={thNum}>
                  Due within {DUE_SOON_DAYS} days
                </th>
                <th scope="col" className={th}>
                  Oldest due
                </th>
              </tr>
            </thead>
            <tbody>
              {drafts.reminders.map((reminder) => (
                <tr key={`${reminder.payeeKey}|${reminder.currency}`} className={row}>
                  <th scope="row" className="p-3 text-left font-medium">
                    {reminder.payeeName}
                  </th>
                  <td className="p-3">
                    <StatusPill
                      status={reminder.overdueCount ? 'OVERDUE' : 'DUE_SOON'}
                      tone={reminder.overdueCount ? 'warning' : 'neutral'}
                      label={reminder.overdueCount ? 'Overdue' : 'Due soon'}
                    />
                  </td>
                  <td className="p-3 text-right font-mono">
                    {reminder.currency} {minor(reminder.overdueMinor)} ({reminder.overdueCount})
                  </td>
                  <td className="p-3 text-right font-mono">
                    {reminder.currency} {minor(reminder.dueSoonMinor)} ({reminder.dueSoonCount})
                  </td>
                  <td className="p-3">{reminder.oldestDueDate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

/** DEV-694: an oldest-due-first payment DRAFT for one payee and budget. Nothing is paid here. */
export function PaymentDraft({
  drafts,
  branchId,
  asOf,
  payees,
  payee,
  currency,
  budget,
}: {
  drafts: PayablesDrafts;
  branchId: string;
  asOf: string;
  payees: readonly string[];
  payee?: string;
  currency: string;
  budget?: string;
}) {
  const draft = drafts.paymentDraft;
  return (
    <SectionCard title="Payment draft" titleLevel={2}>
      <form method="get" className="grid gap-4 md:grid-cols-[2fr_6rem_1fr_auto] md:items-end">
        <input type="hidden" name="branch" value={branchId} />
        <input type="hidden" name="asOf" value={asOf} />
        <label className="grid min-w-0 gap-2 text-sm">
          Payee
          <select
            name="payee"
            defaultValue={payee}
            required
            className="min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {payees.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid min-w-0 gap-2 text-sm">
          Currency
          <select
            name="currency"
            defaultValue={currency}
            className="min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="PKR">PKR</option>
            <option value="USD">USD</option>
          </select>
        </label>
        <label className="grid min-w-0 gap-2 text-sm">
          Budget
          <Input
            className="min-h-11 text-right font-mono tabular-nums"
            name="budget"
            inputMode="decimal"
            defaultValue={budget}
            required
            placeholder="0.00"
          />
        </label>
        <Button type="submit" variant="outline" className="min-h-11">
          Draft payments
        </Button>
      </form>
      <p className="mt-3 text-sm text-text-muted">
        Spends the budget on this payee&apos;s open bills, oldest due first. It is a draft: record
        each payment above to post it.
      </p>
      {draft ? (
        draft.lines.length === 0 ? (
          <p className="mt-3 text-sm text-text-muted">This payee has no open bill to pay.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="mt-3 w-full min-w-max text-sm tabular-nums">
              <thead className="font-mono text-xs uppercase">
                <tr>
                  <th scope="col" className={th}>
                    Bill
                  </th>
                  <th scope="col" className={th}>
                    Due date
                  </th>
                  <th scope="col" className={thNum}>
                    Outstanding
                  </th>
                  <th scope="col" className={thNum}>
                    Pay
                  </th>
                </tr>
              </thead>
              <tbody>
                {draft.lines.map((line) => (
                  <tr key={line.invoiceId} className={row}>
                    <th scope="row" className="p-3 text-left font-medium">
                      {line.reference}
                    </th>
                    <td className="p-3">{line.dueDate}</td>
                    <td className="p-3 text-right font-mono">
                      {line.currency} {minor(line.outstandingMinor)}
                    </td>
                    <td className="p-3 text-right font-mono font-semibold">
                      {minor(line.payMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p role="status" className="mt-3 text-sm text-text-muted">
              {draft.currency} {minor(draft.allocatedMinor)} of {minor(draft.budgetMinor)} drafted;{' '}
              {minor(draft.remainingBudgetMinor)} left over.
            </p>
          </div>
        )
      ) : null}
    </SectionCard>
  );
}

/**
 * DEV-694: the credit-note set-off. A suggestion from the server, the request
 * form where staff choose the bill, and the requests waiting for a manager.
 * Only an approval reduces the payable; the router enforces every rule.
 */
export function CreditSetOff({
  drafts,
  pending,
  branchId,
  bills,
}: {
  drafts: PayablesDrafts;
  pending: PendingSetOffs;
  branchId: string;
  bills: ReadonlyArray<{
    invoiceId: string;
    reference: string;
    payeeName: string;
    supplierInvoiceRef: string;
    outstandingMinor: number;
  }>;
}) {
  const suggestion = drafts.setOffDraft;
  const credits = drafts.openCredits.map((credit) => ({
    creditId: credit.creditId,
    reference: credit.reference,
    supplierName: credit.supplierName,
    remaining: minor(credit.remainingMinor),
  }));
  return (
    <>
      <SectionCard title="Set off supplier credit notes" titleLevel={2}>
        <p className="text-sm text-text-muted">
          Credit notes are in PKR. Choose the bill a credit note pays down; the bill is reduced only
          after a manager or owner approves the request with their own PIN.
        </p>
        {suggestion.lines.length ? (
          <div className="overflow-x-auto">
            <table className="mt-3 w-full min-w-max text-sm tabular-nums">
              <caption className="p-3 text-left text-sm text-text-muted">
                Suggested, oldest credit against oldest due bill. Nothing is applied from here.
              </caption>
              <thead className="font-mono text-xs uppercase">
                <tr>
                  <th scope="col" className={th}>
                    Credit note
                  </th>
                  <th scope="col" className={th}>
                    Bill
                  </th>
                  <th scope="col" className={th}>
                    Due date
                  </th>
                  <th scope="col" className={thNum}>
                    Set off (PKR)
                  </th>
                </tr>
              </thead>
              <tbody>
                {suggestion.lines.map((line) => (
                  <tr key={`${line.creditId}|${line.invoiceId}`} className={row}>
                    <th scope="row" className="p-3 text-left font-medium">
                      {line.creditReference}
                    </th>
                    <td className="p-3">{line.invoiceReference}</td>
                    <td className="p-3">{line.dueDate}</td>
                    <td className="p-3 text-right font-mono">{minor(line.setOffMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {suggestion.unmatchedCreditMinor > 0 ? (
          <p className="mt-3 text-sm text-text-muted">
            PKR {minor(suggestion.unmatchedCreditMinor)} of credit has no open bill from the same
            payee.
          </p>
        ) : null}
        <div className="mt-4">
          {credits.length && bills.length ? (
            <RequestCreditSetOffForm
              branchId={branchId}
              initialKey={`ap-set-off:${randomUUID()}`}
              credits={credits}
              bills={bills.map((bill) => ({
                invoiceId: bill.invoiceId,
                reference: bill.reference,
                payeeName: bill.payeeName,
                supplierInvoiceRef: bill.supplierInvoiceRef,
                outstanding: minor(bill.outstandingMinor),
              }))}
            />
          ) : (
            <p className="text-sm text-text-muted">
              {credits.length
                ? 'There is no open PKR bill on this day to set a credit note off against.'
                : 'No supplier credit note has anything left to set off.'}
            </p>
          )}
        </div>
      </SectionCard>
      <SectionCard title="Set-offs awaiting approval" titleLevel={2}>
        {pending.length === 0 ? (
          <p className="text-sm text-text-muted">No set-off is waiting for approval.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {pending.map((setOff) => {
              const label = `${setOff.credit.reference} against ${setOff.invoice.reference}`;
              return (
                <li key={setOff.id} className="grid gap-3 py-4">
                  <p className="text-sm">
                    <span className="font-medium">{label}</span>{' '}
                    <span className="font-mono tabular-nums">
                      {setOff.currency} {minor(setOff.amountMinor)}
                    </span>{' '}
                    <span className="text-text-muted">
                      · {setOff.credit.supplier.name} · bill {setOff.invoice.supplierInvoiceRef}
                      {setOff.note ? ` · ${setOff.note}` : ''}
                    </span>
                  </p>
                  <DecideCreditSetOffForms
                    branchId={branchId}
                    setOffId={setOff.id}
                    label={label}
                    initialApproveKey={`ap-set-off-ok:${randomUUID()}`}
                    initialRejectKey={`ap-set-off-no:${randomUUID()}`}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </>
  );
}
