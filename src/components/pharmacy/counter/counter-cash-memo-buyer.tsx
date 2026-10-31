'use client';

import { useLayoutEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CASH_MEMO_BUYER_NAME_MAX } from '@/lib/pharmacy/cash-memo';
import { trpc } from '@/lib/trpc';

export type CounterCashMemoBuyerProps = {
  branchId: string;
  /** The open bill; nothing can be saved without one. */
  saleId: string | null;
  /** The name already saved on this bill, loaded with the cart. */
  buyerName?: string | null;
  /** The selected patient or linked customer, offered as the starting value. */
  suggestedName?: string | null;
  disabled?: boolean;
  onSavingChange?: (saving: boolean) => void;
  onUnsavedChange?: (unsaved: boolean) => void;
  onSaved?: (buyerName: string | null) => void;
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
  buyerName = null,
  suggestedName = null,
  disabled = false,
  onSavingChange,
  onUnsavedChange,
  onSaved,
}: CounterCashMemoBuyerProps) {
  const policy = trpc.pharmacySales.counterCashMemoPolicy.useQuery(
    { branchId },
    { enabled: Boolean(branchId) }
  );
  const save = trpc.pharmacySales.counterSetBuyerName.useMutation();
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ saleId: string; name: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const [isSaving, setIsSaving] = useState(false);

  const value = draft ?? buyerName ?? suggestedName ?? '';
  const trimmed = value.replace(/\s+/g, ' ').trim();
  const tooLong = trimmed.length > CASH_MEMO_BUYER_NAME_MAX;
  const required = policy.data?.buyerNameRequired;
  const savedHere = saved !== null && saved.saleId === saleId;
  const persistedName = savedHere ? saved.name : buyerName;
  const unchanged = persistedName === (trimmed || null);
  const unsaved = Boolean(saleId && policy.data?.cashMemo && !unchanged);

  // Suggestions can change without an input event. Report them before the
  // browser accepts a payment click/shortcut, and release the guard on unmount.
  useLayoutEffect(() => {
    onUnsavedChange?.(unsaved);
  }, [onUnsavedChange, unsaved]);
  useLayoutEffect(() => () => onUnsavedChange?.(false), [onUnsavedChange]);

  if (!policy.data?.cashMemo) return null;

  const submit = async () => {
    if (disabled || !saleId || tooLong || saving.current) return;
    // Notify synchronously so a payment shortcut in the same turn is guarded too.
    saving.current = true;
    setIsSaving(true);
    onSavingChange?.(true);
    setError(null);
    try {
      const result = await save.mutateAsync({ branchId, saleId, buyerName: trimmed || null });
      setSaved({ saleId, name: result.buyerName });
      setDraft(result.buyerName ?? '');
      onSaved?.(result.buyerName);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : 'The buyer name could not be saved. Retry before taking payment.'
      );
    } finally {
      saving.current = false;
      setIsSaving(false);
      onSavingChange?.(false);
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
          disabled={disabled || !saleId || isSaving}
          aria-invalid={tooLong || error !== null ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
            onUnsavedChange?.(
              (event.target.value.replace(/\s+/g, ' ').trim() || null) !== persistedName
            );
          }}
          className="h-11 min-w-0 flex-1 sm:max-w-sm"
        />
        <Button
          type="button"
          variant="outline"
          className="h-11"
          disabled={disabled || !saleId || tooLong || isSaving || unchanged}
          onClick={() => void submit()}
        >
          {isSaving ? 'Saving…' : 'Save buyer name'}
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
      ) : unsaved ? (
        <p className="text-sm text-text-muted">
          Save the displayed buyer name before taking payment.
        </p>
      ) : savedHere && unchanged ? (
        <p role="status" className="text-sm text-text-muted">
          {saved?.name ? 'Buyer name saved for this bill.' : 'Buyer name cleared for this bill.'}
        </p>
      ) : null}
    </div>
  );
}
