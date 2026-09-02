'use client';

import { forwardRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';

/** The tenders POS-05 recognises. Card and wallet need a certified adapter. */
const TENDER_TYPES = [
  { value: 'CASH', label: 'Cash', requiresAdapter: false },
  { value: 'CARD', label: 'Card', requiresAdapter: true },
  { value: 'BANK_TRANSFER', label: 'Bank transfer', requiresAdapter: false },
  { value: 'WALLET', label: 'Wallet', requiresAdapter: true },
  { value: 'CREDIT', label: 'Khata / credit', requiresAdapter: false },
] as const;

export type CounterTenderType = (typeof TENDER_TYPES)[number]['value'];

export type CounterTenderPanelProps = {
  /** Outstanding balance in minor units. Zero means the bill is settled. */
  balanceMinor: number;
  blocked: boolean;
  pending?: boolean;
  disabled?: boolean;
  error?: string | null;
  onTender: (input: {
    type: CounterTenderType;
    amountMinor: number;
    cashReceivedMinor?: number;
  }) => void;
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
    { balanceMinor, blocked, pending = false, disabled = false, error, onTender },
    ref
  ) {
    const [type, setType] = useState<CounterTenderType>('CASH');
    const [amount, setAmount] = useState('');
    const [cashReceived, setCashReceived] = useState('');

    const amountMinor = amount.trim() === '' ? balanceMinor : parseAmountMinor(amount);
    const cashReceivedMinor = cashReceived.trim() === '' ? null : parseAmountMinor(cashReceived);
    const amountValid =
      amountMinor !== null && amountMinor > 0 && amountMinor <= Math.max(balanceMinor, 0);
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
    const submittable = !disabled && !pending && !blocked && amountValid && !cashShort;

    return (
      <div ref={ref} tabIndex={-1} className="space-y-4 focus-visible:outline-none">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-text-body">
            Balance due{' '}
            <span className="font-mono tabular-nums text-text-strong">
              {formatMinor(Math.max(balanceMinor, 0))}
            </span>
          </p>
          {balanceMinor <= 0 ? (
            <StatusPill status="settled" tone="success" label="Settled" />
          ) : null}
        </div>

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
            disabled={disabled || pending || balanceMinor <= 0}
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
            placeholder={formatMinor(Math.max(balanceMinor, 0))}
            value={amount}
            disabled={disabled || pending || balanceMinor <= 0}
            aria-invalid={amount.trim() !== '' && !amountValid}
            onChange={(event) => setAmount(event.target.value)}
            className="h-11"
          />
          {amount.trim() !== '' && !amountValid ? (
            <p className="text-sm text-destructive" role="alert">
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
              disabled={disabled || pending || balanceMinor <= 0}
              aria-invalid={cashShort || undefined}
              onChange={(event) => setCashReceived(event.target.value)}
              className="h-11"
            />
            {cashShort ? (
              <p className="text-sm text-destructive" role="alert">
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

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <Button
          type="button"
          className="h-11 w-full"
          disabled={!submittable}
          onClick={() => {
            if (!submittable || amountMinor === null) return;
            onTender({
              type,
              amountMinor,
              ...(type === 'CASH' && cashReceivedMinor !== null ? { cashReceivedMinor } : {}),
            });
            setAmount('');
            setCashReceived('');
          }}
        >
          {pending ? 'Taking payment…' : 'Take payment'}
        </Button>
      </div>
    );
  }
);
