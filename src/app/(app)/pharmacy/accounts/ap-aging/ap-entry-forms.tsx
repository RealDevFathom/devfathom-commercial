'use client';

import { startTransition, useActionState, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  payApInvoiceFromForm,
  recordApInvoiceFromForm,
  type ApEntryFormState,
} from './ap-entry-actions';

/** An invoice the aging view shows as open, offered as a payment target. */
export type PayableInvoice = {
  invoiceId: string;
  reference: string;
  payeeName: string;
  supplierInvoiceRef: string;
  currency: string;
  outstanding: string;
};

const initial: ApEntryFormState = { status: 'idle', message: '' };
const newKey = (prefix: string) =>
  `${prefix}:${
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }`;

const fieldClass = 'grid min-w-0 gap-2 text-sm';
const selectClass =
  'min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

/**
 * One command key per intended entry: a double submit replays the same entry
 * on the server; only a saved entry rotates the key for the next one. The
 * first key comes from the server render so hydration matches.
 */
function useEntryAction(
  submit: (previous: ApEntryFormState, form: FormData) => Promise<ApEntryFormState>,
  initialKey: string,
  prefix: string
) {
  const [key, setKey] = useState(initialKey);
  const [formKey, setFormKey] = useState(0);
  const [state, action, pending] = useActionState(
    async (previous: ApEntryFormState, form: FormData) => {
      const result = await submit(previous, form);
      if (result.status === 'saved') {
        setKey(newKey(prefix));
        setFormKey((value) => value + 1);
      }
      return result;
    },
    initial
  );
  // Submitting through a transition keeps every typed value after a refusal (a
  // plain form action would reset the form); a saved entry remounts the form.
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(() => action(form));
  };
  return { key, formKey, state, onSubmit, pending, invalid: state.status === 'error' };
}

function Status({ id, state }: { id: string; state: ApEntryFormState }) {
  const invalid = state.status === 'error';
  return (
    <p
      id={id}
      role={invalid ? 'alert' : undefined}
      aria-live="polite"
      className={`text-sm ${invalid ? 'text-destructive' : 'text-text-muted'}`}
    >
      {state.message}
    </p>
  );
}

export function RecordApInvoiceForm({
  branchId,
  initialKey,
  today,
}: {
  branchId: string;
  initialKey: string;
  today: string;
}) {
  const { key, formKey, state, onSubmit, pending, invalid } = useEntryAction(
    recordApInvoiceFromForm,
    initialKey,
    'ap-invoice'
  );
  const aria = { 'aria-invalid': invalid || undefined, 'aria-describedby': 'ap-record-status' };
  return (
    <form key={formKey} onSubmit={onSubmit} className="space-y-4" aria-label="Record invoice">
      <input type="hidden" name="branchId" value={branchId} />
      <input type="hidden" name="createKey" value={key} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <label className={fieldClass}>
          Payee
          <Input className="min-h-11" name="payeeName" maxLength={160} required {...aria} />
        </label>
        <label className={fieldClass}>
          Payee&apos;s invoice number
          <Input className="min-h-11" name="supplierInvoiceRef" maxLength={80} required {...aria} />
        </label>
        <label className={fieldClass}>
          Our reference
          <Input
            className="min-h-11"
            name="reference"
            maxLength={80}
            required
            placeholder="e.g. AP-0042"
            {...aria}
          />
        </label>
        <label className={fieldClass}>
          Invoice date
          <Input
            className="min-h-11"
            type="date"
            name="invoiceDate"
            defaultValue={today}
            required
            {...aria}
          />
        </label>
        <label className={fieldClass}>
          Due date
          <Input className="min-h-11" type="date" name="dueDate" required {...aria} />
        </label>
        <div className="grid grid-cols-[6rem_1fr] gap-3">
          <label className={fieldClass}>
            Currency
            <select name="currency" defaultValue="PKR" className={selectClass}>
              <option value="PKR">PKR</option>
              <option value="USD">USD</option>
            </select>
          </label>
          <label className={fieldClass}>
            Amount
            <Input
              className="min-h-11 text-right font-mono tabular-nums"
              name="amount"
              inputMode="decimal"
              required
              placeholder="0.00"
              {...aria}
            />
          </label>
        </div>
        <label className={`${fieldClass} md:col-span-2 xl:col-span-2`}>
          What it was for
          <Input className="min-h-11" name="description" maxLength={500} required {...aria} />
        </label>
        <label className={fieldClass}>
          Evidence reference
          <Input
            className="min-h-11"
            name="evidenceReference"
            maxLength={160}
            required
            placeholder="File, receipt or folder"
            {...aria}
          />
        </label>
      </div>
      <p className="text-sm text-text-muted">
        Recording posts the full amount as an operating expense owed to the payee. It cannot be
        edited afterwards; a mistake is corrected by reversing the invoice.
      </p>
      <Button type="submit" className="min-h-11" disabled={pending}>
        {pending ? 'Recording…' : 'Record invoice'}
      </Button>
      <Status id="ap-record-status" state={state} />
    </form>
  );
}

export function PayApInvoiceForm({
  branchId,
  initialKey,
  now,
  invoices,
}: {
  branchId: string;
  initialKey: string;
  /** The workspace wall-clock minute (`YYYY-MM-DDTHH:mm`) when the page rendered. */
  now: string;
  invoices: readonly PayableInvoice[];
}) {
  const { key, formKey, state, onSubmit, pending, invalid } = useEntryAction(
    payApInvoiceFromForm,
    initialKey,
    'ap-payment'
  );
  const aria = { 'aria-invalid': invalid || undefined, 'aria-describedby': 'ap-pay-status' };
  return (
    <form key={formKey} onSubmit={onSubmit} className="space-y-4" aria-label="Record payment">
      <input type="hidden" name="branchId" value={branchId} />
      <input type="hidden" name="commandKey" value={key} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <label className={`${fieldClass} md:col-span-2 xl:col-span-3`}>
          Invoice
          <select name="invoiceId" required className={selectClass} {...aria}>
            {invoices.map((invoice) => (
              <option key={invoice.invoiceId} value={invoice.invoiceId}>
                {`${invoice.reference} · ${invoice.payeeName} · ${invoice.supplierInvoiceRef} · ${invoice.currency} ${invoice.outstanding} outstanding`}
              </option>
            ))}
          </select>
        </label>
        <label className={fieldClass}>
          Amount paid
          <Input
            className="min-h-11 text-right font-mono tabular-nums"
            name="amount"
            inputMode="decimal"
            required
            placeholder="0.00"
            {...aria}
          />
        </label>
        <label className={fieldClass}>
          Paid at
          <Input
            className="min-h-11"
            type="datetime-local"
            name="paidAt"
            defaultValue={now}
            required
            {...aria}
          />
        </label>
        <label className={fieldClass}>
          Paid from
          <select name="fundingAccount" defaultValue="CASH" className={selectClass}>
            <option value="CASH">Cash</option>
            <option value="BANK">Bank</option>
          </select>
        </label>
        <label className={fieldClass}>
          Payment reference
          <Input
            className="min-h-11"
            name="reference"
            maxLength={80}
            required
            placeholder="e.g. PV-0107"
            {...aria}
          />
        </label>
        <label className={fieldClass}>
          Bank reference (optional)
          <Input className="min-h-11" name="bankReference" maxLength={160} {...aria} />
        </label>
      </div>
      <p className="text-sm text-text-muted">
        The server refuses a payment above what the invoice still owed at the time paid, before the
        invoice date, or in a closed period.
      </p>
      <Button type="submit" className="min-h-11" disabled={pending}>
        {pending ? 'Recording…' : 'Record payment'}
      </Button>
      <Status id="ap-pay-status" state={state} />
    </form>
  );
}
