'use client';

import { forwardRef, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import type { TenderDraft } from './tender-attempt-storage';

/** The tenders POS-05 recognises. Card and wallet need a certified adapter. */
const TENDER_TYPES = [
  { value: 'CASH', label: 'Cash', requiresAdapter: false },
  { value: 'CARD', label: 'Card', requiresAdapter: true },
  { value: 'BANK_TRANSFER', label: 'Bank transfer', requiresAdapter: false },
  { value: 'WALLET', label: 'Wallet', requiresAdapter: true },
  { value: 'CREDIT', label: 'Khata / credit', requiresAdapter: false },
] as const;

export type CounterTenderType = (typeof TENDER_TYPES)[number]['value'];

export type CounterTenderResult = {
  status: 'accepted' | 'rejected' | 'unknown';
  message: string;
};

export type CounterTenderBillState =
  'idle' | 'loading' | 'error' | 'stale' | 'unavailable' | 'ready' | 'settled';

export type CounterTenderPanelProps = {
  /** Only a known, current bill has a balance; zero alone is not settlement. */
  balanceMinor: number | null;
  state: CounterTenderBillState;
  blocked: boolean;
  pending?: boolean;
  disabled?: boolean;
  error?: string | null;
  initialDraft?: TenderDraft & { type: CounterTenderType };
  recoveryOutcome?: CounterTenderResult | null;
  checkingOutcome?: boolean;
  onCheckOutcome?: () => Promise<CounterTenderResult>;
  onRetry: () => void;
  onTender: (
    input: {
      type: CounterTenderType;
      amountMinor: number;
      cashReceivedMinor?: number;
    },
    draft: TenderDraft
  ) => Promise<CounterTenderResult>;
};

function parseAmountMinor(value: string): number | null {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const major = Number.parseInt(match[1]!, 10);
  const fraction = Number.parseInt((match[2] ?? '0').padEnd(2, '0'), 10);
  const minor = major * 100 + fraction;
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * POS-05 tenders, from the counter.
 *
 * Two refusals are enforced here rather than left to the server round trip, so
 * the operator is told before they take money:
 *
 * - A bill carrying an unresolved SAFETY_BLOCK cannot be tendered at all.
 * - Cash tendered below the amount due is not change, it is a short payment.
 *
 * The server still enforces both. This only shortens the feedback loop; it is
 * not the authority.
 */
export const CounterTenderPanel = forwardRef<HTMLDivElement, CounterTenderPanelProps>(
  function CounterTenderPanel(
    {
      balanceMinor,
      state,
      blocked,
      pending = false,
      disabled = false,
      error,
      onRetry,
      onTender,
      initialDraft,
      recoveryOutcome,
      checkingOutcome = false,
      onCheckOutcome,
    },
    ref
  ) {
    const [type, setType] = useState<CounterTenderType>(initialDraft?.type ?? 'CASH');
    const [amount, setAmount] = useState(initialDraft?.amount ?? '');
    const [cashReceived, setCashReceived] = useState(initialDraft?.cashReceived ?? '');
    const [submitting, setSubmitting] = useState(false);
    const [outcome, setOutcome] = useState<CounterTenderResult | null>(null);
    const submissionRef = useRef(false);
    const checkRef = useRef(false);
    const statusRef = useRef<HTMLParagraphElement>(null);
    const takingPayment = pending || submitting;
    const displayedOutcome = recoveryOutcome ?? outcome;
    const unknown = displayedOutcome?.status === 'unknown';
    const balanceKnown =
      balanceMinor !== null && Number.isSafeInteger(balanceMinor) && balanceMinor >= 0;
    const editable = state === 'ready' && balanceKnown && !disabled && !takingPayment && !unknown;

    const amountMinor = amount.trim() === '' ? balanceMinor : parseAmountMinor(amount);
    const cashReceivedMinor = cashReceived.trim() === '' ? null : parseAmountMinor(cashReceived);
    const amountValid =
      balanceKnown && amountMinor !== null && amountMinor > 0 && amountMinor <= balanceMinor;
    const cashInvalid = type === 'CASH' && cashReceived.trim() !== '' && cashReceivedMinor === null;
    const cashShort =
      type === 'CASH' &&
      cashReceivedMinor !== null &&
      amountMinor !== null &&
      cashReceivedMinor < amountMinor;
    const changeMinor =
      type === 'CASH' && cashReceivedMinor !== null && amountMinor !== null && !cashShort
        ? cashReceivedMinor - amountMinor
        : null;
    const selected = TENDER_TYPES.find((entry) => entry.value === type)!;
    const submittable = editable && !blocked && amountValid && !cashShort && !cashInvalid;

    async function submitTender() {
      if (!submittable || amountMinor === null || submissionRef.current) return;
      submissionRef.current = true;
      setSubmitting(true);
      setOutcome(null);
      try {
        const result = await onTender(
          {
            type,
            amountMinor,
            ...(type === 'CASH' && cashReceivedMinor !== null ? { cashReceivedMinor } : {}),
          },
          { amount, cashReceived: type === 'CASH' ? cashReceived : '' }
        );
        setOutcome(result);
        if (result.status === 'accepted') {
          setAmount('');
          setCashReceived('');
        }
      } catch {
        setOutcome({
          status: 'unknown',
          message:
            'Payment outcome is unknown. Keep this bill open and ask a supervisor to check the payment before taking more money.',
        });
      } finally {
        submissionRef.current = false;
        setSubmitting(false);
      }
    }

    async function checkOutcome() {
      if (!onCheckOutcome || checkRef.current || checkingOutcome || takingPayment) return;
      checkRef.current = true;
      try {
        const result = await onCheckOutcome();
        setOutcome(result);
        if (result.status === 'accepted') {
          setAmount('');
          setCashReceived('');
          statusRef.current?.focus();
        }
      } catch {
        setOutcome({
          status: 'unknown',
          message:
            'Payment outcome could not be checked. Keep this bill open and check again before taking more money.',
        });
      } finally {
        checkRef.current = false;
      }
    }

    return (
      <div ref={ref} tabIndex={-1} className="space-y-4 focus-visible:outline-none">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-text-body">
            Balance due{' '}
            <span className="font-mono tabular-nums text-text-strong">
              {balanceKnown && (state === 'ready' || state === 'settled') && !unknown
                ? formatMinor(balanceMinor)
                : 'Unavailable'}
            </span>
          </p>
          {state === 'settled' && balanceMinor === 0 && !unknown && !takingPayment ? (
            <StatusPill status="settled" tone="success" label="Settled" />
          ) : null}
        </div>

        <p
          ref={statusRef}
          tabIndex={-1}
          id="tender-status"
          role="status"
          aria-live="polite"
          className="text-sm text-text-body focus-visible:outline-ring"
        >
          {takingPayment
            ? 'Taking payment… Keep this bill open.'
            : checkingOutcome
              ? 'Checking payment outcome… No payment is being sent.'
              : (displayedOutcome?.message ??
                (state === 'idle'
                  ? 'Open a bill before taking payment.'
                  : state === 'loading'
                    ? 'Checking the bill balance…'
                    : state === 'stale'
                      ? 'Refresh this bill to verify the balance before taking payment.'
                      : state === 'error'
                        ? 'The bill balance could not be verified. Retry the bill read before taking payment.'
                        : state === 'unavailable'
                          ? 'This bill is not available for payment.'
                          : ''))}
        </p>
        {onCheckOutcome ? (
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={checkingOutcome || takingPayment}
            aria-describedby="tender-status tender-error"
            onClick={() => void checkOutcome()}
          >
            {checkingOutcome ? 'Checking payment outcome…' : 'Check payment outcome'}
          </Button>
        ) : null}
        {!takingPayment && ['error', 'stale', 'unavailable'].includes(state) ? (
          <Button type="button" variant="outline" className="h-11" onClick={onRetry}>
            Refresh bill
          </Button>
        ) : null}

        {blocked ? (
          <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-text-body">
            This bill carries an unresolved safety block. Resolve it in the prescription panel
            before taking payment.
          </p>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="tender-type">Tender</Label>
          <select
            id="tender-type"
            value={type}
            disabled={!editable}
            onChange={(event) => setType(event.target.value as CounterTenderType)}
            className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            {TENDER_TYPES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
          {selected.requiresAdapter ? (
            <p className="text-sm text-text-muted">
              Requires a certified payment provider. Without one configured, the server refuses this
              tender rather than simulating an approval.
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="tender-amount">Amount</Label>
          <Input
            id="tender-amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder={balanceKnown ? formatMinor(balanceMinor) : undefined}
            value={amount}
            disabled={!editable}
            aria-invalid={state === 'ready' && amount.trim() !== '' && !amountValid}
            aria-describedby="tender-status tender-error tender-amount-error"
            onChange={(event) => setAmount(event.target.value)}
            className="h-11"
          />
          {state === 'ready' && amount.trim() !== '' && !amountValid ? (
            <p id="tender-amount-error" className="text-sm text-destructive" role="alert">
              Enter an amount between 0.01 and the balance due.
            </p>
          ) : null}
        </div>

        {type === 'CASH' ? (
          <div className="space-y-1.5">
            <Label htmlFor="tender-cash-received">Cash received</Label>
            <Input
              id="tender-cash-received"
              inputMode="decimal"
              autoComplete="off"
              value={cashReceived}
              disabled={!editable}
              aria-invalid={cashShort || cashInvalid || undefined}
              aria-describedby="tender-status tender-error tender-cash-error"
              onChange={(event) => setCashReceived(event.target.value)}
              className="h-11"
            />
            {cashInvalid ? (
              <p id="tender-cash-error" className="text-sm text-destructive" role="alert">
                Enter a valid cash amount with at most two decimal places.
              </p>
            ) : cashShort ? (
              <p id="tender-cash-error" className="text-sm text-destructive" role="alert">
                Cash received is less than the amount tendered.
              </p>
            ) : changeMinor !== null ? (
              <p className="text-sm text-text-body" aria-live="polite">
                Change{' '}
                <span className="font-mono tabular-nums text-text-strong">
                  {formatMinor(changeMinor)}
                </span>
              </p>
            ) : null}
          </div>
        ) : null}

        <p
          id="tender-error"
          className="text-sm text-destructive"
          role={error ? 'alert' : undefined}
        >
          {error}
        </p>

        <Button
          type="button"
          className="h-11 w-full"
          disabled={!submittable}
          aria-describedby="tender-status tender-error"
          onClick={() => void submitTender()}
        >
          {takingPayment ? 'Taking payment…' : 'Take payment'}
        </Button>
      </div>
    );
  }
);
