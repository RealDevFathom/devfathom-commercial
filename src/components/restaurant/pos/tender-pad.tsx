'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { type FormEvent, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';

import type { TerminalRequest } from './checkout-panel';

const MONEY = /^\d+(\.\d{1,2})?$/;
const APPROVAL_CODE = /^[A-Za-z0-9]{2,12}$/;
// Last 4 digits or the machine reference; 13+ digits could be a full card number.
const REFERENCE = /^(?!\d{13,}$)[A-Za-z0-9]{4,24}$/;

export type TenderResult = {
  tenderId: string;
  billId: string;
  type: 'CASH' | 'CARD' | 'OTHER';
  amount: string;
  tipAmount: string;
  changeGiven: string | null;
  settled: boolean;
  receiptNumber: number | null;
  remainingDue: string;
  replayed: boolean;
};

type TenderPadProps = {
  billId: string;
  amountDue?: string;
  request: TerminalRequest;
  disabled?: boolean;
  onApplied: (result: TenderResult) => Promise<void> | void;
  onPendingChange?: (pending: boolean) => void;
};

function message(error: unknown) {
  return error instanceof Error ? error.message : 'Tender failed. Retry this payment.';
}

export function TenderPad({
  billId,
  amountDue,
  request,
  disabled = false,
  onApplied,
  onPendingChange,
}: TenderPadProps) {
  const [type, setType] = useState<TenderResult['type']>('CASH');
  const [amount, setAmount] = useState(amountDue ?? '');
  const [cashReceived, setCashReceived] = useState(amountDue ?? '');
  const [tipAmount, setTipAmount] = useState('');
  const [approvalCode, setApprovalCode] = useState('');
  const [reference, setReference] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TenderResult | null>(null);
  const [previousAmountDue, setPreviousAmountDue] = useState(amountDue);

  if (amountDue !== previousAmountDue) {
    setPreviousAmountDue(amountDue);
    setAmount(amountDue ?? '');
    setCashReceived(amountDue ?? '');
    if (amountDue !== undefined) setError(null);
    if (result?.remainingDue !== amountDue) setResult(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || disabled || result?.settled) return;
    if (!MONEY.test(amount)) {
      setError('Amount must be a non-negative decimal with at most two places.');
      return;
    }
    if (type === 'CASH' && !MONEY.test(cashReceived)) {
      setError('Cash received must be a non-negative decimal with at most two places.');
      return;
    }
    if (type !== 'CASH' && tipAmount && !MONEY.test(tipAmount)) {
      setError('Tip must be a non-negative decimal with at most two places.');
      return;
    }

    if (type === 'CARD' && !APPROVAL_CODE.test(approvalCode.trim())) {
      setError('Enter the approval code printed on the card machine slip.');
      return;
    }
    if (type === 'CARD' && !REFERENCE.test(reference.trim())) {
      setError('Enter the last 4 digits or the card machine reference. Never the full card number.');
      return;
    }

    const tender =
      type === 'CASH'
        ? { type, amount, cashReceived }
        : {
            type,
            amount,
            ...(tipAmount ? { tipAmount } : {}),
            ...(type === 'CARD'
              ? {
                  manualConfirmation: {
                    approvalCode: approvalCode.trim(),
                    reference: reference.trim(),
                  },
                }
              : {}),
          };
    setPending(true);
    onPendingChange?.(true);
    setError(null);
    try {
      const next = await request<TenderResult>('/api/restaurant/checkout/tender', {
        method: 'POST',
        body: { billId, tender },
        intent: `tender:${billId}:${JSON.stringify(tender)}`,
      });
      setResult(next);
      setAmount(next.remainingDue);
      if (type === 'CASH') setCashReceived(next.remainingDue);
      if (type === 'CARD') {
        setApprovalCode('');
        setReference('');
      }
      await onApplied(next);
    } catch (requestError) {
      setError(message(requestError));
    } finally {
      setPending(false);
      onPendingChange?.(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 border-t border-border-subtle pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-text-strong">Apply tender</p>
        {result ? (
          <StatusPill
            status={result.settled ? 'settled' : 'partial'}
            tone={result.settled ? 'success' : 'warning'}
          />
        ) : null}
      </div>
      {amountDue === undefined && !result ? (
        <p className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-text-body">
          Outstanding balance unavailable. Enter the exact tender amount.
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`tender-type-${billId}`}>Tender type</Label>
          <StudioSelect
            id={`tender-type-${billId}`}
            value={type}
            disabled={pending || disabled || result?.settled}
            onChange={(event) => {
              setType(event.target.value as TenderResult['type']);
              setError(null);
            }}
            className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            <option value="CASH">Cash</option>
            <option value="CARD">Card (confirmed on card machine)</option>
            <option value="OTHER">Other</option>
          </StudioSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`tender-amount-${billId}`}>Amount</Label>
          <Input
            id={`tender-amount-${billId}`}
            value={amount}
            disabled={pending || disabled || result?.settled}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            autoComplete="off"
            className="h-11 font-mono tabular-nums"
          />
        </div>
      </div>
      {type === 'CASH' ? (
        <div className="space-y-1.5">
          <Label htmlFor={`cash-received-${billId}`}>Cash received</Label>
          <Input
            id={`cash-received-${billId}`}
            value={cashReceived}
            disabled={pending || disabled || result?.settled}
            onChange={(event) => setCashReceived(event.target.value)}
            inputMode="decimal"
            autoComplete="off"
            className="h-11 font-mono tabular-nums"
          />
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor={`tip-amount-${billId}`}>Tip (optional)</Label>
          <Input
            id={`tip-amount-${billId}`}
            value={tipAmount}
            disabled={pending || disabled || result?.settled}
            onChange={(event) => setTipAmount(event.target.value)}
            inputMode="decimal"
            autoComplete="off"
            className="h-11 font-mono tabular-nums"
          />
        </div>
      )}
      {type === 'CARD' ? (
        <div className="space-y-3">
          <p className="text-sm text-text-muted">
            Take the payment on the card machine first. Confirm it was approved, then enter the
            details from the slip.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`card-approval-${billId}`}>Approval code</Label>
              <Input
                id={`card-approval-${billId}`}
                value={approvalCode}
                disabled={pending || disabled || result?.settled}
                onChange={(event) => setApprovalCode(event.target.value)}
                autoComplete="off"
                className="h-11 font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`card-reference-${billId}`}>Last 4 digits or reference</Label>
              <Input
                id={`card-reference-${billId}`}
                value={reference}
                disabled={pending || disabled || result?.settled}
                onChange={(event) => setReference(event.target.value)}
                autoComplete="off"
                className="h-11 font-mono"
              />
            </div>
          </div>
        </div>
      ) : null}
      {result ? (
        <div role="status" className="grid gap-1 rounded-lg bg-surface-sunken p-3 text-sm">
          <span className="font-mono tabular-nums text-text-strong">
            Remaining balance {result.remainingDue}
          </span>
          {result.changeGiven !== null ? (
            <span className="font-mono tabular-nums text-text-muted">
              Change {result.changeGiven}
            </span>
          ) : null}
          {result.tipAmount !== '0' && result.tipAmount !== '0.00' ? (
            <span className="font-mono tabular-nums text-text-muted">Tip {result.tipAmount}</span>
          ) : null}
          {result.receiptNumber !== null ? (
            <span className="text-text-muted">Receipt {result.receiptNumber}</span>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        type="submit"
        disabled={pending || disabled || Boolean(result?.settled)}
        className="h-11 w-full"
      >
        {pending ? 'Applying tender…' : result?.settled ? 'Bill settled' : 'Apply tender'}
      </Button>
    </form>
  );
}
