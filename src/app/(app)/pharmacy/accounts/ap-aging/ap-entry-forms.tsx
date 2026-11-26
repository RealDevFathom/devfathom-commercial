'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import {
  createContext,
  startTransition,
  useActionState,
  useContext,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  approveCreditSetOffFromForm,
  payApInvoiceFromForm,
  recordApInvoiceFromForm,
  rejectCreditSetOffFromForm,
  requestCreditSetOffFromForm,
  reverseApInvoiceFromForm,
  reverseApSettlementFromForm,
  reverseCreditSetOffFromForm,
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
            <StudioSelect name="currency" defaultValue="PKR" className={selectClass}>
              <option value="PKR">PKR</option>
              <option value="USD">USD</option>
            </StudioSelect>
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
          <StudioSelect name="invoiceId" required className={selectClass} {...aria}>
            {invoices.map((invoice) => (
              <option key={invoice.invoiceId} value={invoice.invoiceId}>
                {`${invoice.reference} · ${invoice.payeeName} · ${invoice.supplierInvoiceRef} · ${invoice.currency} ${invoice.outstanding} outstanding`}
              </option>
            ))}
          </StudioSelect>
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
          <StudioSelect name="fundingAccount" defaultValue="CASH" className={selectClass}>
            <option value="CASH">Cash</option>
            <option value="BANK">Bank</option>
          </StudioSelect>
        </label>
        <label className="text-sm">
          Approving administrator’s email (above the limit)
          <Input name="approverEmail" type="email" autoComplete="off" />
        </label>
        <label className="text-sm">
          Administrator approval PIN or code (when required)
          <Input type="password" name="pin" autoComplete="off" inputMode="numeric" maxLength={8} />
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

/** DEV-694: an open PKR bill and an unspent supplier credit note, offered for set-off. */
export type SetOffBill = {
  invoiceId: string;
  reference: string;
  payeeName: string;
  supplierInvoiceRef: string;
  outstanding: string;
};
export type SetOffCredit = {
  creditId: string;
  reference: string;
  supplierName: string;
  remaining: string;
};

/**
 * DEV-694: staff choose the bill a credit note is set off against. This only
 * records a request; the bill is reduced when a manager approves it.
 */
export function RequestCreditSetOffForm({
  branchId,
  initialKey,
  bills,
  credits,
}: {
  branchId: string;
  initialKey: string;
  bills: readonly SetOffBill[];
  credits: readonly SetOffCredit[];
}) {
  const { key, formKey, state, onSubmit, pending, invalid } = useEntryAction(
    requestCreditSetOffFromForm,
    initialKey,
    'ap-set-off'
  );
  const aria = { 'aria-invalid': invalid || undefined, 'aria-describedby': 'ap-set-off-status' };
  return (
    <form
      key={formKey}
      onSubmit={onSubmit}
      className="space-y-4"
      aria-label="Request credit note set-off"
    >
      <input type="hidden" name="branchId" value={branchId} />
      <input type="hidden" name="requestKey" value={key} />
      <div className="grid gap-4 md:grid-cols-2">
        <label className={fieldClass}>
          Credit note
          <StudioSelect name="supplierCreditId" required className={selectClass} {...aria}>
            {credits.map((credit) => (
              <option key={credit.creditId} value={credit.creditId}>
                {`${credit.reference} · ${credit.supplierName} · PKR ${credit.remaining} left`}
              </option>
            ))}
          </StudioSelect>
        </label>
        <label className={fieldClass}>
          Supplier bill
          <StudioSelect name="invoiceId" required className={selectClass} {...aria}>
            {bills.map((bill) => (
              <option key={bill.invoiceId} value={bill.invoiceId}>
                {`${bill.reference} · ${bill.payeeName} · ${bill.supplierInvoiceRef} · PKR ${bill.outstanding} outstanding`}
              </option>
            ))}
          </StudioSelect>
        </label>
        <label className={fieldClass}>
          Amount to set off (PKR)
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
          Note (optional)
          <Input className="min-h-11" name="note" maxLength={500} {...aria} />
        </label>
      </div>
      <p className="text-sm text-text-muted">
        The credit note&apos;s supplier must be the bill&apos;s payee. The server refuses more than
        is left on the credit note or owed on the bill.
      </p>
      <Button type="submit" className="min-h-11" disabled={pending}>
        {pending ? 'Requesting…' : 'Request set-off'}
      </Button>
      <Status id="ap-set-off-status" state={state} />
    </form>
  );
}

/** DEV-694: approve with the manager's own PIN, or reject with a reason. */
export function DecideCreditSetOffForms({
  branchId,
  setOffId,
  label,
  initialApproveKey,
  initialRejectKey,
}: {
  branchId: string;
  setOffId: string;
  /** Names the request for assistive technology, e.g. its credit and bill references. */
  label: string;
  initialApproveKey: string;
  initialRejectKey: string;
}) {
  const approve = useEntryAction(approveCreditSetOffFromForm, initialApproveKey, 'ap-set-off-ok');
  const reject = useEntryAction(rejectCreditSetOffFromForm, initialRejectKey, 'ap-set-off-no');
  const approveStatus = `ap-set-off-approve-${setOffId}`;
  const rejectStatus = `ap-set-off-reject-${setOffId}`;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <form
        key={`approve-${approve.formKey}`}
        onSubmit={approve.onSubmit}
        className="grid gap-2"
        aria-label={`Approve set-off ${label}`}
      >
        <input type="hidden" name="branchId" value={branchId} />
        <input type="hidden" name="setOffId" value={setOffId} />
        <input type="hidden" name="decisionKey" value={approve.key} />
        <label className={fieldClass}>
          Your manager or owner PIN
          <Input
            className="min-h-11 font-mono"
            name="pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            pattern="\d{4,8}"
            maxLength={8}
            required
            aria-invalid={approve.invalid || undefined}
            aria-describedby={approveStatus}
          />
        </label>
        <Button type="submit" className="min-h-11" disabled={approve.pending}>
          {approve.pending ? 'Approving…' : 'Approve set-off'}
        </Button>
        <Status id={approveStatus} state={approve.state} />
      </form>
      <form
        key={`reject-${reject.formKey}`}
        onSubmit={reject.onSubmit}
        className="grid gap-2"
        aria-label={`Reject set-off ${label}`}
      >
        <input type="hidden" name="branchId" value={branchId} />
        <input type="hidden" name="setOffId" value={setOffId} />
        <input type="hidden" name="decisionKey" value={reject.key} />
        <label className={fieldClass}>
          Reason to reject
          <Input
            className="min-h-11"
            name="reason"
            maxLength={500}
            required
            aria-invalid={reject.invalid || undefined}
            aria-describedby={rejectStatus}
          />
        </label>
        <Button type="submit" variant="destructive" className="min-h-11" disabled={reject.pending}>
          {reject.pending ? 'Rejecting…' : 'Reject'}
        </Button>
        <Status id={rejectStatus} state={reject.state} />
      </form>
    </div>
  );
}

/** DEV-694: undo an approved set-off with the manager's own PIN and a reason. */
export function ReverseCreditSetOffForm({
  branchId,
  setOffId,
  label,
  initialKey,
}: {
  branchId: string;
  setOffId: string;
  label: string;
  initialKey: string;
}) {
  const { key, formKey, state, onSubmit, pending, invalid } = useEntryAction(
    reverseCreditSetOffFromForm,
    initialKey,
    'ap-set-off-rev'
  );
  const status = `ap-set-off-reverse-${setOffId}`;
  const aria = { 'aria-invalid': invalid || undefined, 'aria-describedby': status };
  return (
    <form
      key={formKey}
      onSubmit={onSubmit}
      className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end"
      aria-label={`Reverse set-off ${label}`}
    >
      <input type="hidden" name="branchId" value={branchId} />
      <input type="hidden" name="setOffId" value={setOffId} />
      <input type="hidden" name="commandKey" value={key} />
      <label className={fieldClass}>
        Reason to reverse
        <Input className="min-h-11" name="reason" maxLength={500} required {...aria} />
      </label>
      <label className={fieldClass}>
        Your manager or owner PIN
        <Input
          className="min-h-11 font-mono"
          name="pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          pattern="\d{4,8}"
          maxLength={8}
          required
          {...aria}
        />
      </label>
      <Button type="submit" variant="destructive" className="min-h-11" disabled={pending}>
        {pending ? 'Reversing…' : 'Reverse set-off'}
      </Button>
      <Status id={status} state={state} />
    </form>
  );
}

/**
 * DEV-103: reverse a supplier expense invoice, or one payment against it, with the manager's or
 * owner's own PIN and a reason. The reason and the PIN are the deliberate confirmation step; the
 * server checks the PIN, who recorded the entry and every money rule, and dates it now.
 */
/**
 * DEV-103: a saved reversal removes its own row (the server re-renders the list without it), so
 * its confirmation is announced here, above the list, which stays mounted.
 */
const ReversalNotice = createContext<((message: string) => void) | null>(null);

export function ReversalNoticeArea({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('');
  return (
    <ReversalNotice.Provider value={setMessage}>
      <p
        role="status"
        aria-live="polite"
        // Always rendered, so the live region exists before the message arrives.
        className={message ? 'mt-3 text-sm font-medium text-success' : undefined}
      >
        {message}
      </p>
      {children}
    </ReversalNotice.Provider>
  );
}

export function ReverseApEntryForm({
  kind,
  branchId,
  targetId,
  label,
  initialKey,
}: {
  kind: 'invoice' | 'payment';
  branchId: string;
  /** The invoice id or the payment (settlement) id. */
  targetId: string;
  /** Names the entry for assistive technology, e.g. its reference. */
  label: string;
  initialKey: string;
}) {
  const prefix = kind === 'invoice' ? 'ap-invoice-rev' : 'ap-payment-rev';
  const announce = useContext(ReversalNotice);
  const action = kind === 'invoice' ? reverseApInvoiceFromForm : reverseApSettlementFromForm;
  const { key, formKey, state, onSubmit, pending, invalid } = useEntryAction(
    async (previous, form) => {
      const result = await action(previous, form);
      if (result.status === 'saved') announce?.(result.message);
      return result;
    },
    initialKey,
    prefix
  );
  const status = `${prefix}-${targetId}`;
  const aria = { 'aria-invalid': invalid || undefined, 'aria-describedby': status };
  const noun = kind === 'invoice' ? 'invoice' : 'payment';
  return (
    <form
      key={formKey}
      onSubmit={onSubmit}
      className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end"
      aria-label={`Reverse ${noun} ${label}`}
    >
      <input type="hidden" name="branchId" value={branchId} />
      <input
        type="hidden"
        name={kind === 'invoice' ? 'invoiceId' : 'settlementId'}
        value={targetId}
      />
      <input type="hidden" name="commandKey" value={key} />
      <label className={fieldClass}>
        Reason to reverse
        <Input className="min-h-11" name="reason" maxLength={500} required {...aria} />
      </label>
      <label className={fieldClass}>
        Your manager or owner PIN
        <Input
          className="min-h-11 font-mono"
          name="pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          pattern="\d{4,8}"
          maxLength={8}
          required
          {...aria}
        />
      </label>
      <Button type="submit" variant="destructive" className="min-h-11" disabled={pending}>
        {pending ? 'Reversing…' : `Reverse ${noun}`}
      </Button>
      <Status id={status} state={state} />
    </form>
  );
}
