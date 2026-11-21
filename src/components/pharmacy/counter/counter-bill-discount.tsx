'use client';

import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { amountInputError, amountInputToMinor } from '@/lib/money-input';
import type { BillDiscountExclusion, BillDiscountRequest } from '@/lib/pharmacy/bill-discount';
import type { CounterApprovalPin } from '@/lib/pharmacy/counter-line-approval';
import {
  COUNTER_DISCOUNT_APPROVAL_REQUIRED,
  counterErrorMessage,
} from '@/lib/pharmacy/counter-messages';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { NO_MAXIMUM_DISCOUNT_BPS } from '@/lib/pharmacy/smart-discount';
import { trpc } from '@/lib/trpc';
import { percentToBps } from './discount-maximum-panel';

/** DEV-956: why an item took no share of the whole-bill discount, in the cashier's words. */
export const BILL_DISCOUNT_EXCLUSION_TEXT: Record<BillDiscountExclusion, string> = {
  REGULATED: 'prescription, restricted and controlled medicines are never discounted',
  OWN_DISCOUNT: 'it already has its own discount, voucher or promotion',
  TIER_PRICED: "it is already priced by the customer's prepaid tier",
  AT_FLOOR:
    "it is already at its lowest allowed price (its cost, the branch's minimum margin or the owner's maximum discount)",
  UNPRICED: 'it was sold before batch prices were kept',
};

type CartLine = { saleLineId: string; medicineName: string; billDiscountMinor?: number };

export function describeBillDiscountExclusions(
  excluded: readonly { saleLineId: string; reason: BillDiscountExclusion }[],
  lines: readonly CartLine[]
): string[] {
  const names = new Map(lines.map((line) => [line.saleLineId, line.medicineName]));
  return excluded.map(
    ({ saleLineId, reason }) =>
      `${names.get(saleLineId) ?? 'An item'}: not discounted, because ${BILL_DISCOUNT_EXCLUSION_TEXT[reason]}.`
  );
}

export type CounterBillDiscountInput = {
  branchId: string;
  saleId: string;
  lines: readonly CartLine[];
  requestApproval: (discount: string) => Promise<CounterApprovalPin | null>;
  onChanged: (message: string) => void;
};

/**
 * DEV-956: the whole-bill discount's server call, shared by the bill's own form and (DEV-977
 * phase 3) the discount sheet's "Whole bill" choice. One procedure, one approval path: a cashier
 * without the discount right is asked for a manager's or owner's PIN in the counter's approval
 * dialog (a solo owner enters their own). `send` resolves to the refusal to show, or null once
 * the server applied it.
 */
export function useCounterBillDiscount({
  branchId,
  saleId,
  lines,
  requestApproval,
  onChanged,
}: CounterBillDiscountInput) {
  const setting = trpc.pharmacySales.billDiscountSetting.useQuery({ branchId });
  const maximum = trpc.pharmacySales.discountMaximum.useQuery(
    { branchId },
    { enabled: setting.data?.enabled === true }
  );
  const apply = trpc.pharmacySales.applyBillDiscount.useMutation();
  const stored = maximum.data?.maxDiscountBps;
  const maxBps = stored !== undefined && stored < NO_MAXIMUM_DISCOUNT_BPS ? stored : null;

  const send = async (
    discount: BillDiscountRequest,
    label: string
  ): Promise<{ error: string | null; leftOut: string[] }> => {
    let discountApproval: CounterApprovalPin | undefined;
    const post = () =>
      apply.mutateAsync({
        branchId,
        saleId,
        discount,
        ...(discountApproval ? { discountApproval } : {}),
      });
    try {
      let outcome: Awaited<ReturnType<typeof post>>;
      try {
        outcome = await post();
      } catch (failure) {
        if (!(failure instanceof Error) || failure.message !== COUNTER_DISCOUNT_APPROVAL_REQUIRED)
          throw failure;
        const approval = await requestApproval(label);
        if (!approval) {
          return {
            error: 'The discount was not given: it needs a manager or owner to approve it.',
            leftOut: [],
          };
        }
        discountApproval = approval;
        outcome = await post();
      }
      const reasons = describeBillDiscountExclusions(outcome.excluded, lines);
      if (outcome.status === 'REFUSED') {
        return {
          error:
            outcome.reason === 'ABOVE_LIMIT'
              ? `This bill can take at most Rs ${formatMinor(outcome.capacityMinor)} off without taking an item below its cost, the branch's minimum margin or the owner's maximum discount. Give Rs ${formatMinor(outcome.capacityMinor)} or less.`
              : `No item on this bill can take this discount.${reasons.length ? ` ${reasons.join(' ')}` : ''}`,
          leftOut: [],
        };
      }
      onChanged(
        outcome.totalMinor > 0
          ? `A whole-bill discount of Rs ${formatMinor(outcome.totalMinor)} is on the bill, shared over ${outcome.lines.length} ${outcome.lines.length === 1 ? 'item' : 'items'}.${reasons.length ? ` ${reasons.length} ${reasons.length === 1 ? 'item was' : 'items were'} left out.` : ''}`
          : 'The whole-bill discount was removed.'
      );
      return { error: null, leftOut: reasons };
    } catch (failure) {
      return {
        error:
          failure instanceof Error && failure.message === COUNTER_DISCOUNT_APPROVAL_REQUIRED
            ? 'That PIN did not approve the discount, so it was not given. A manager or owner must enter their own PIN.'
            : counterErrorMessage(failure),
        leftOut: [],
      };
    }
  };

  return { enabled: setting.data?.enabled === true, maxBps, pending: apply.isPending, send };
}

/**
 * DEV-956: one discount for the whole bill, as a percentage or an amount, shown only when the
 * owner has switched it on (with it off the counter is unchanged). The server shares it onto the
 * bill's items under the same rules as an item discount and says which items it left out; the
 * cashier is told each one. A cashier without the discount right is asked for a manager's or
 * owner's PIN in the counter's approval dialog (a solo owner enters their own).
 */
export function CounterBillDiscountEntry({
  branchId,
  saleId,
  lines,
  disabled,
  requestApproval,
  onChanged,
}: CounterBillDiscountInput & {
  /** No discount while the counter is busy, offline, or the bill has taken a payment. */
  disabled: boolean;
}) {
  const id = useId();
  const bill = useCounterBillDiscount({ branchId, saleId, lines, requestApproval, onChanged });
  const [kind, setKind] = useState<BillDiscountRequest['kind']>('PERCENT');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState<{ saleId: string; text: string[] } | null>(null);
  if (!bill.enabled) return null;
  const maxBps = bill.maxBps;
  const givenMinor = lines.reduce((sum, line) => sum + (line.billDiscountMinor ?? 0), 0);
  const leftOut = left?.saleId === saleId ? left.text : [];
  const busy = disabled || bill.pending;

  const send = async (discount: BillDiscountRequest, label: string) => {
    setError(null);
    const result = await bill.send(discount, label);
    if (result.error) {
      setError(result.error);
      return;
    }
    setLeft({ saleId, text: result.leftOut });
    setValue('');
  };

  return (
    <div className="mt-3 space-y-2 border-t border-border-subtle pt-3 text-sm">
      {givenMinor > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2" role="status">
          <p className="min-w-0 text-text-body">
            Whole-bill discount:{' '}
            <span className="font-mono tabular-nums">Rs {formatMinor(givenMinor)}</span>, shared
            over {lines.filter((line) => (line.billDiscountMinor ?? 0) > 0).length} of{' '}
            {lines.length} items.
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={() => void send({ kind: 'AMOUNT', minor: 0 }, 'removal')}
          >
            Remove bill discount
          </Button>
        </div>
      ) : null}
      {leftOut.length ? (
        <ul className="space-y-1 text-text-muted" aria-label="Items left out of the bill discount">
          {leftOut.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      ) : null}
      <details className="rounded-md border border-border-subtle p-3">
        <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium focus-visible:outline-2 focus-visible:outline-ring">
          {givenMinor > 0 ? 'Change the bill discount' : 'Discount the whole bill'}
        </summary>
        <form
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            if (kind === 'AMOUNT') {
              // Typed rupees go through the shared reader, so "12.50" is 1250 exactly.
              const amount = amountInputToMinor(value);
              if (amount.status === 'INVALID') {
                setError(amountInputError(amount.reason));
                return;
              }
              if (amount.status === 'EMPTY' || amount.minor === 0) {
                setError('Enter an amount in rupees above 0, with at most two decimal places.');
                return;
              }
              void send(
                { kind, minor: amount.minor },
                `Rs ${formatMinor(amount.minor)} off the bill`
              );
              return;
            }
            const bps = percentToBps(value);
            if (bps === null || bps === 0) {
              setError(
                'Enter a percentage above 0 and up to 100, with at most two decimal places.'
              );
              return;
            }
            if (maxBps !== null && bps > maxBps) {
              setError(
                `${bps / 100}% is above the owner's maximum discount of ${maxBps / 100}%. Give a smaller discount, or ask the owner to raise the maximum.`
              );
              return;
            }
            void send({ kind, bps }, `${bps / 100}% off the bill`);
          }}
        >
          <p id={`${id}-rules`} className="text-text-body">
            One discount for the whole bill, shared over its items by price. A percentage is taken
            of the items that can be discounted. Adding an item afterwards removes it, so give it
            once the bill is complete.{' '}
            {maxBps !== null
              ? `No item takes more than the owner's maximum of ${maxBps / 100}%.`
              : 'The owner has not set a maximum discount.'}{' '}
            No item goes below its cost or the branch&apos;s minimum margin.
          </p>
          <fieldset className="space-y-1.5">
            <legend className="font-medium">Discount as</legend>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ['PERCENT', 'Percentage (%)'],
                  ['AMOUNT', 'Amount (Rs)'],
                ] as const
              ).map(([option, label]) => (
                <Button
                  key={option}
                  type="button"
                  variant={kind === option ? 'default' : 'outline'}
                  className="min-h-11"
                  aria-pressed={kind === option}
                  disabled={busy}
                  onClick={() => {
                    setKind(option);
                    setError(null);
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
          </fieldset>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-value`}>
              {kind === 'PERCENT' ? 'Bill discount (%)' : 'Bill discount (Rs)'}
            </Label>
            <Input
              id={`${id}-value`}
              className="h-11 w-40"
              inputMode="decimal"
              autoComplete="off"
              value={value}
              disabled={busy}
              aria-invalid={error ? true : undefined}
              aria-describedby={`${id}-rules ${id}-help${error ? ` ${id}-error` : ''}`}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
            />
          </div>
          <p id={`${id}-help`} className="text-text-muted">
            Prescription, restricted and controlled medicines, and items that already have their own
            discount, voucher or promotion, are left out and named here. Give it before taking any
            payment. If you cannot give discounts on your own, a manager or owner approves with
            their PIN.
          </p>
          <Button type="submit" className="min-h-11" disabled={busy}>
            {bill.pending ? 'Applying…' : 'Apply to bill'}
          </Button>
        </form>
      </details>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
