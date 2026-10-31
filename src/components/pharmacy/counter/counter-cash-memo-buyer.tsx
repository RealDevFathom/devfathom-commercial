'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CASH_MEMO_BUYER_NAME_MAX } from '@/lib/pharmacy/cash-memo';
import { trpc } from '@/lib/trpc';

export type CounterCashMemoBuyerProps = {
  branchId: string;
  /** The open bill; nothing can be saved without one. */
  saleId: string | null;
  /** The selected patient or linked customer, offered as the starting value. */
  suggestedName?: string | null;
  disabled?: boolean;
};

/**
 * #708: the buyer-name field for a Sindh cash memo (Sindh Drugs Rules r.18).
 *
 * Shown only when the branch's regulatory profile in force is for Sindh. The
 * name is saved on the open bill and frozen when the receipt is issued. It is
 * optional for walk-ins unless the owner policy requires it; a linked customer
 * is used when nothing is typed.
 */
export function CounterCashMemoBuyer({
  branchId,
  saleId,
  suggestedName = null,
  disabled = false,
}: CounterCashMemoBuyerProps) {
  const policy = trpc.pharmacySales.counterCashMemoPolicy.useQuery(
    { branchId },
    { enabled: Boolean(branchId) }
  );
  const save = trpc.pharmacySales.counterSetBuyerName.useMutation();
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ saleId: string; name: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!policy.data?.cashMemo) return null;

  const value = draft ?? suggestedName ?? '';
  const trimmed = value.replace(/\s+/g, ' ').trim();
  const tooLong = trimmed.length > CASH_MEMO_BUYER_NAME_MAX;
  const required = policy.data.buyerNameRequired;
  const savedHere = saved !== null && saved.saleId === saleId;
  const unchanged = savedHere && saved.name === (trimmed || null);

  const submit = async () => {
    if (!saleId || tooLong || save.isPending) return;
    setError(null);
    try {
      const result = await save.mutateAsync({ branchId, saleId, buyerName: trimmed || null });
      setSaved({ saleId, name: result.buyerName });
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : 'The buyer name could not be saved. Retry before taking payment.'
      );
    }
  };

  const describedBy = ['cash-memo-buyer-help', error || tooLong ? 'cash-memo-buyer-error' : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="space-y-1.5">
      <Label htmlFor="cash-memo-buyer">
        Buyer name for cash memo{required ? ' (required)' : ''}
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="cash-memo-buyer"
          value={value}
          maxLength={CASH_MEMO_BUYER_NAME_MAX + 20}
          autoComplete="off"
          disabled={disabled || !saleId || save.isPending}
          aria-invalid={tooLong || error !== null ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          className="h-11 min-w-0 flex-1 sm:max-w-sm"
        />
        <Button
          type="button"
          variant="outline"
          className="h-11"
          disabled={disabled || !saleId || tooLong || save.isPending || unchanged}
          onClick={() => void submit()}
        >
          {save.isPending ? 'Saving…' : 'Save buyer name'}
        </Button>
      </div>
      <p id="cash-memo-buyer-help" className="text-xs text-text-muted">
        Printed on the Sindh cash memo with the signature line.{' '}
        {required
          ? 'This branch requires a buyer name before payment.'
          : 'Optional for walk-ins; a linked customer is used if left blank.'}{' '}
        Save it before taking payment. It cannot change once the receipt is issued.
      </p>
      {tooLong ? (
        <p id="cash-memo-buyer-error" role="alert" className="text-sm text-destructive">
          Use {CASH_MEMO_BUYER_NAME_MAX} characters or fewer.
        </p>
      ) : error ? (
        <p id="cash-memo-buyer-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : unchanged ? (
        <p role="status" className="text-sm text-text-muted">
          {saved?.name ? 'Buyer name saved for this bill.' : 'Buyer name cleared for this bill.'}
        </p>
      ) : null}
    </div>
  );
}
