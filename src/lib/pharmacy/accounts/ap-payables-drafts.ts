/**
 * DEV-694: due-bill reminders, an oldest-first payment draft and a credit-note
 * set-off draft, all derived from the DEV-103 native AP ageing view.
 *
 * No second ageing is built: every figure is computed from `ApAgingRow`s. The
 * output is a read-only DRAFT; nothing here writes. A person confirms and
 * posts payments/set-offs through the existing AP and supplier-credit commands.
 * Staff-facing only; no medicine, price or customer data is involved.
 */
import type { ApAgingRow, ApAgingView } from './ap-aging';
import { normalizePayeeKey } from './ap-invoices';

export const DUE_SOON_DAYS = 7;
/** Supplier credits carry no currency; they are PKR-denominated (schema default). */
export const SUPPLIER_CREDIT_CURRENCY = 'PKR';
export const SUPPLIER_CREDIT_MAX_ROWS = 5_000;

export type DueBillReminder = {
  payeeKey: string;
  payeeName: string;
  currency: string;
  overdueMinor: number;
  overdueCount: number;
  dueSoonMinor: number;
  dueSoonCount: number;
  oldestDueDate: string | null;
  maxDaysPastDue: number;
};

/** Per-distributor reminders: overdue bills and bills due within the window. */
export function computeDueBillReminders(
  view: ApAgingView,
  dueSoonDays: number = DUE_SOON_DAYS
): DueBillReminder[] {
  const byKey = new Map<string, DueBillReminder>();
  for (const row of view.rows) {
    const overdue = row.daysPastDue > 0;
    const dueSoon = !overdue && row.daysPastDue >= -dueSoonDays;
    if (!overdue && !dueSoon) continue;
    const key = `${normalizePayeeKey(row.payeeName)}|${row.currency}`;
    const entry =
      byKey.get(key) ??
      ({
        payeeKey: normalizePayeeKey(row.payeeName),
        payeeName: row.payeeName,
        currency: row.currency,
        overdueMinor: 0,
        overdueCount: 0,
        dueSoonMinor: 0,
        dueSoonCount: 0,
        oldestDueDate: null,
        maxDaysPastDue: 0,
      } satisfies DueBillReminder);
    if (overdue) {
      entry.overdueMinor += row.outstandingMinor;
      entry.overdueCount += 1;
    } else {
      entry.dueSoonMinor += row.outstandingMinor;
      entry.dueSoonCount += 1;
    }
    if (entry.oldestDueDate === null || row.dueDate < entry.oldestDueDate) {
      entry.oldestDueDate = row.dueDate;
    }
    entry.maxDaysPastDue = Math.max(entry.maxDaysPastDue, row.daysPastDue);
    byKey.set(key, entry);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      b.overdueMinor - a.overdueMinor ||
      a.payeeName.localeCompare(b.payeeName) ||
      a.currency.localeCompare(b.currency)
  );
}

export type PaymentDraftLine = {
  invoiceId: string;
  reference: string;
  dueDate: string;
  currency: string;
  outstandingMinor: number;
  payMinor: number;
};

export type PaymentDraft = {
  payeeKey: string;
  currency: string;
  budgetMinor: number;
  allocatedMinor: number;
  remainingBudgetMinor: number;
  lines: PaymentDraftLine[];
};

/**
 * Oldest-due-first allocation of a budget to one distributor's open bills.
 * The last funded bill may be part-paid; amounts never exceed the outstanding.
 */
export function buildPaymentDraft(
  view: ApAgingView,
  input: { payeeName: string; currency: string; budgetMinor: number }
): PaymentDraft {
  const payeeKey = normalizePayeeKey(input.payeeName);
  const budgetMinor = Math.max(0, Math.trunc(input.budgetMinor));
  let remaining = budgetMinor;
  const lines: PaymentDraftLine[] = [];
  const open = view.rows
    .filter((r) => normalizePayeeKey(r.payeeName) === payeeKey && r.currency === input.currency)
    .sort(
      (a, b) =>
        a.dueDate.localeCompare(b.dueDate) ||
        a.reference.localeCompare(b.reference) ||
        a.invoiceId.localeCompare(b.invoiceId)
    );
  for (const row of open) {
    if (remaining <= 0) break;
    const payMinor = Math.min(remaining, row.outstandingMinor);
    lines.push({
      invoiceId: row.invoiceId,
      reference: row.reference,
      dueDate: row.dueDate,
      currency: row.currency,
      outstandingMinor: row.outstandingMinor,
      payMinor,
    });
    remaining -= payMinor;
  }
  return {
    payeeKey,
    currency: input.currency,
    budgetMinor,
    allocatedMinor: budgetMinor - remaining,
    remainingBudgetMinor: remaining,
    lines,
  };
}

export type OpenSupplierCredit = {
  creditId: string;
  reference: string;
  supplierName: string;
  receivedAt: Date;
  amountMinor: number;
  allocatedMinor: number;
};

export type SetOffDraftLine = {
  creditId: string;
  creditReference: string;
  invoiceId: string;
  invoiceReference: string;
  dueDate: string;
  setOffMinor: number;
};

export type SetOffDraft = {
  lines: SetOffDraftLine[];
  totalSetOffMinor: number;
  unmatchedCreditMinor: number;
};

/**
 * Sets each distributor's unallocated credit notes (oldest first) against its
 * open bills (oldest due first), matching on the normalized name. Supplier
 * credits carry no currency; they are only applied to the branch's default
 * (given) currency so a credit is never set off across currencies.
 */
export function buildSetOffDraft(
  view: ApAgingView,
  credits: readonly OpenSupplierCredit[],
  currency: string
): SetOffDraft {
  const billsLeft = new Map<string, number>();
  for (const r of view.rows)
    if (r.currency === currency) billsLeft.set(r.invoiceId, r.outstandingMinor);
  const lines: SetOffDraftLine[] = [];
  let unmatchedCreditMinor = 0;
  const orderedCredits = [...credits].sort(
    (a, b) =>
      a.receivedAt.getTime() - b.receivedAt.getTime() ||
      a.reference.localeCompare(b.reference) ||
      a.creditId.localeCompare(b.creditId)
  );
  for (const credit of orderedCredits) {
    let available = credit.amountMinor - credit.allocatedMinor;
    if (available <= 0) continue;
    const key = normalizePayeeKey(credit.supplierName);
    const bills: ApAgingRow[] = view.rows
      .filter((r) => r.currency === currency && normalizePayeeKey(r.payeeName) === key)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.invoiceId.localeCompare(b.invoiceId));
    for (const bill of bills) {
      if (available <= 0) break;
      const left = billsLeft.get(bill.invoiceId) ?? 0;
      if (left <= 0) continue;
      const setOffMinor = Math.min(available, left);
      lines.push({
        creditId: credit.creditId,
        creditReference: credit.reference,
        invoiceId: bill.invoiceId,
        invoiceReference: bill.reference,
        dueDate: bill.dueDate,
        setOffMinor,
      });
      billsLeft.set(bill.invoiceId, left - setOffMinor);
      available -= setOffMinor;
    }
    unmatchedCreditMinor += available;
  }
  return {
    lines,
    totalSetOffMinor: lines.reduce((s, l) => s + l.setOffMinor, 0),
    unmatchedCreditMinor,
  };
}
