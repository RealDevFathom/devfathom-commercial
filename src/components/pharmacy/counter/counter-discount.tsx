'use client';

import { type RefObject, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/components/ui/select-field';
import { browserUuid } from '@/lib/browser-uuid';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogDescription, DialogPortal, DialogTrigger } from '@/components/ui/dialog';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { amountInputError, amountInputToMinor } from '@/lib/money-input';
import { counterErrorMessage } from '@/lib/pharmacy/counter-messages';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { BPS, NO_MAXIMUM_DISCOUNT_BPS } from '@/lib/pharmacy/smart-discount';
import { trpc } from '@/lib/trpc';
import { percentToBps } from './discount-maximum-panel';
import {
  ApprovalFallback,
  ApprovalNames,
  matchingProfiles,
  useApprovalEntry,
  type ApprovalEntry,
} from './counter-approval-entry';
import { useCounterApprovalCopy } from './counter-approval-copy';
import {
  COUNTER_SHEET_BACKDROP,
  CounterNote,
  CounterSheetFooter,
  CounterSheetHeader,
  counterSheetClassName,
} from './counter-sheet';

/** DEV-929: a manual discount the cashier set for the next item, as a share or an amount. */
export type CounterHeldDiscount =
  { kind: 'PERCENT'; bps: number } | { kind: 'AMOUNT'; minor: number };

/**
 * The discount, in minor units, the counter sends for a line of `grossMinor`. A percentage
 * rounds down, so it never exceeds the share the cashier asked for (or the owner's maximum).
 */
export function counterDiscountMinor(held: CounterHeldDiscount, grossMinor: number): number {
  return held.kind === 'PERCENT' ? Math.floor((grossMinor * held.bps) / BPS) : held.minor;
}

/**
 * DEV-977 phase 3: the whole-bill choice in the discount sheet. `apply` is the whole-bill
 * procedure the bill's own form uses (DEV-956, with its approval dialog), and resolves to the
 * refusal to show, or null once applied.
 */
export type CounterDiscountWholeBill = {
  /** The bill is busy, offline or has taken a payment: no whole-bill discount now. */
  disabled: boolean;
  apply: (
    discount: { kind: 'PERCENT'; bps: number } | { kind: 'AMOUNT'; minor: number },
    label: string
  ) => Promise<string | null>;
};

/** Who may approve a discount at this till, from the existing approvers read (DEV-929). */
type DiscountApprover = { id: string; name: string; self: boolean };
export type CounterDiscountApprovers =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; list: readonly DiscountApprover[] };

export function describeCounterDiscount(held: CounterHeldDiscount): string {
  return held.kind === 'PERCENT' ? `${held.bps / 100}%` : `Rs ${formatMinor(held.minor)}`;
}

/**
 * DEV-929: the counter's place to give a manual discount on the next item added. It shows the
 * owner's maximum and refuses a larger share before sending. The server stays the judge: it
 * re-checks the maximum, the cost floor and minimum margin, regulated medicines, and whether
 * the cashier may discount without a manager's PIN (the counter then asks for one).
 *
 * DEV-972: it sits on the bill side as a compact "Discount" button that opens a small panel,
 * and one short line with its remove action while a discount is held, so nothing comes between
 * the search box and its results. Escape (or applying the discount) closes the panel and focus
 * returns to `returnFocus`.
 *
 * DEV-977 phase 2B (Counter v2 A4): the panel is the design's discount sheet (eyebrow, title,
 * type as a segmented choice, the amount, then Cancel and Apply). The approval itself stays
 * where it is today: a manager or owner approves with their PIN when the item is added.
 */
export function CounterDiscountEntry({
  branchId,
  held,
  disabled,
  onHold,
  onClear,
  returnFocus,
  wholeBill,
  billLines,
  approvers,
  onOpenChange,
}: {
  branchId: string;
  held: CounterHeldDiscount | null;
  disabled: boolean;
  onHold: (discount: CounterHeldDiscount) => void;
  onClear: () => void;
  /** Where focus goes when the panel closes (the counter's search box). */
  returnFocus?: RefObject<HTMLElement | null>;
  /** DEV-977 phase 3: offered only while the owner has the whole-bill discount on. */
  wholeBill?: CounterDiscountWholeBill;
  billLines?: {
    lines: { saleLineId: string; medicineName: string }[];
    apply: (
      saleLineId: string,
      discount: CounterHeldDiscount,
      requestId: string,
      approval?: ApprovalEntry
    ) => Promise<void>;
  };
  /** DEV-977 phase 3: who can approve, read while the sheet is open (the supervisor block). */
  approvers?: CounterDiscountApprovers;
  /** Told when the sheet opens and closes, so the approvers are read only while it is open. */
  onOpenChange?: (open: boolean) => void;
}) {
  const id = useId();
  const valueRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  // DEV-961: how a manager or owner approves follows the authenticator for approvals setting.
  const approvalCopy = useCounterApprovalCopy();
  const maximum = trpc.pharmacySales.discountMaximum.useQuery({ branchId });
  const [kind, setKind] = useState<CounterHeldDiscount['kind']>('PERCENT');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<'ITEM' | 'BILL' | 'LINE'>('ITEM');
  const [lineId, setLineId] = useState('');
  const form = useApprovalEntry();
  const { profile: approverId, setProfile: setApproverId, pin: secret, setPin: setSecret } = form;
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const resetLine = () => {
    form.reset();
    setLineId('');
    attempt.current = null;
  };
  const toLine = target === 'LINE';
  const [sending, setSending] = useState(false);
  // The whole bill can only be chosen while it is offered; otherwise the sheet is the next item's.
  const toBill = target === 'BILL' && Boolean(wholeBill);
  const stored = maximum.data?.maxDiscountBps;
  // The owner's maximum in bps, or null when none is set (or it has not loaded).
  const maxBps = stored !== undefined && stored < NO_MAXIMUM_DISCOUNT_BPS ? stored : null;

  if (held) {
    return (
      <div
        role="status"
        title={`A discount of ${describeCounterDiscount(held)} comes off the next item you add.`}
        className="flex min-w-0 items-center gap-1 rounded-xs bg-surface-sunken ps-3 text-sm"
      >
        <span className="min-w-0 truncate text-text-body">
          {describeCounterDiscount(held)} off the next item
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 shrink-0"
          aria-label="Remove discount"
          disabled={disabled}
          onClick={onClear}
        >
          <X aria-hidden />
        </Button>
      </div>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
        if (!next) {
          resetLine();
          setTarget('ITEM');
          setError(null);
        }
      }}
    >
      <DialogTrigger render={<Button type="button" variant="outline" className="min-h-11" />}>
        Discount
      </DialogTrigger>
      <DialogPortal>
        <DialogPrimitive.Backdrop className={`fixed inset-0 z-50 ${COUNTER_SHEET_BACKDROP}`} />
        <DialogPrimitive.Popup
          data-counter-sheet="dialog"
          className={counterSheetClassName('dialog')}
          initialFocus={valueRef}
          finalFocus={returnFocus ?? true}
        >
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (disabled || sending) return;
              let discount: CounterHeldDiscount;
              if (kind === 'AMOUNT') {
                // DEV-939: the shared typed-amount reader, so "12.50" is 1250 exactly, never via a float.
                const amount = amountInputToMinor(value);
                if (amount.status === 'INVALID') {
                  setError(amountInputError(amount.reason));
                  return;
                }
                if (amount.status === 'EMPTY' || amount.minor === 0) {
                  setError('Enter an amount in rupees above 0, with at most two decimal places.');
                  return;
                }
                discount = { kind, minor: amount.minor };
              } else {
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
                discount = { kind, bps };
              }
              if (toLine) {
                if (!billLines || !lineId) {
                  setError('Choose a bill line.');
                  return;
                }
                if ((secret || approverId || form.matches) && !form.entry) {
                  setError('Choose the approving manager or owner and enter their approval.');
                  setSecret('');
                  return;
                }
                const fingerprint = JSON.stringify([branchId, lineId, discount]);
                if (attempt.current?.fingerprint !== fingerprint)
                  attempt.current = { fingerprint, id: browserUuid() };
                setSending(true);
                setError(null);
                const approval = form.entry;
                setSecret('');
                void billLines
                  .apply(lineId, discount, attempt.current.id, approval)
                  .then(() => {
                    setValue('');
                    setTarget('ITEM');
                    resetLine();
                    setOpen(false);
                    onOpenChange?.(false);
                  })
                  .catch((e) => {
                    const matches = matchingProfiles(e);
                    if (matches) form.reset(matches);
                    setError(counterErrorMessage(e));
                  })
                  .finally(() => setSending(false));
                return;
              }
              if (toBill && wholeBill) {
                if (wholeBill.disabled) return;
                // DEV-977 phase 3: the bill's own procedure and approval, unchanged.
                setSending(true);
                setError(null);
                void wholeBill
                  .apply(
                    discount,
                    discount.kind === 'PERCENT'
                      ? `${discount.bps / 100}% off the bill`
                      : `Rs ${formatMinor(discount.minor)} off the bill`
                  )
                  .then((refusal) => {
                    setSending(false);
                    if (refusal) {
                      setError(refusal);
                      return;
                    }
                    setValue('');
                    setTarget('ITEM');
                    setOpen(false);
                    onOpenChange?.(false);
                  });
                return;
              }
              onHold(discount);
              setValue('');
              setError(null);
              setOpen(false);
              onOpenChange?.(false);
            }}
          >
            <CounterSheetHeader
              eyebrow="Discount"
              title={
                toLine
                  ? 'Discount on a bill line'
                  : toBill
                    ? 'Discount on the whole bill'
                    : 'Discount on the next item'
              }
            />
            <DialogDescription className="sr-only">
              {toBill
                ? 'One discount shared over the items of this bill.'
                : toLine
                  ? 'Apply a manual discount to the selected item on this bill.'
                  : 'A manual discount on the next item you add to this bill.'}
            </DialogDescription>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4.5 text-sm">
              {wholeBill || billLines?.lines.length ? (
                // DEV-977 phase 3 (Counter v2 A4): where the discount goes. "Next item" is the
                // existing item discount, given when the item is added; "Whole bill" is the
                // existing whole-bill discount, shared over the bill's items by the server.
                <fieldset className="space-y-1.5">
                  <legend className="text-[13px] font-semibold text-text-strong">Apply to</legend>
                  <div
                    data-counter-segmented=""
                    className="inline-flex flex-wrap gap-1 rounded-sm bg-surface-sunken p-1"
                  >
                    {(
                      [
                        ['ITEM', 'Next item'],
                        ['BILL', 'Whole bill'],
                      ] as const
                    )
                      .filter(([option]) => option !== 'BILL' || wholeBill)
                      .map(([option, label]) => (
                        <Button
                          key={option}
                          type="button"
                          variant={target === option ? 'default' : 'ghost'}
                          className="min-h-11 shadow-none hover:translate-y-0 active:translate-y-0"
                          aria-pressed={target === option}
                          disabled={disabled || (option === 'BILL' && wholeBill?.disabled)}
                          onClick={() => {
                            resetLine();
                            setTarget(option);
                            setError(null);
                          }}
                        >
                          {label}
                        </Button>
                      ))}
                    {!!billLines?.lines.length && (
                      <Button
                        type="button"
                        size="touch"
                        variant={toLine ? 'default' : 'ghost'}
                        aria-pressed={toLine}
                        disabled={sending || disabled}
                        onClick={() => {
                          setTarget('LINE');
                          setLineId(billLines.lines[0]!.saleLineId);
                          setError(null);
                        }}
                      >
                        Bill line
                      </Button>
                    )}
                  </div>
                  {toLine && (
                    <>
                      <Label htmlFor={id + '-line'}>Bill line to discount</Label>
                      <SelectField
                        id={id + '-line'}
                        value={lineId}
                        onChange={(e) => {
                          setLineId(e.target.value);
                          setSecret('');
                        }}
                      >
                        {billLines?.lines.map((l, i) => (
                          <option key={l.saleLineId} value={l.saleLineId}>
                            {i + 1}. {l.medicineName}
                          </option>
                        ))}
                      </SelectField>
                    </>
                  )}
                  <p className="text-xs text-text-muted">
                    {toLine
                      ? 'Applies only to the selected line.'
                      : wholeBill?.disabled
                        ? 'The whole bill can be discounted only before any payment is taken.'
                        : toBill
                          ? 'Shared over the bill’s items by price. Adding an item afterwards removes it, so give it once the bill is complete.'
                          : 'Comes off the next item you add to this bill.'}
                  </p>
                </fieldset>
              ) : null}
              <p id={`${id}-maximum`} className="text-text-body">
                {maximum.isLoading
                  ? "Checking the owner's maximum discount…"
                  : maximum.isError
                    ? `The owner's maximum discount could not be loaded: ${counterErrorMessage(maximum.error)} The discount is still checked when you add the item.`
                    : maxBps !== null
                      ? `The owner's maximum discount is ${maxBps / 100}% of an item's price.`
                      : "The owner has not set a maximum discount. A discount still cannot take an item below its cost or the branch's minimum margin."}
              </p>
              <fieldset className="space-y-1.5">
                <legend className="text-[13px] font-semibold text-text-strong">Discount as</legend>
                <div
                  data-counter-segmented=""
                  className="inline-flex flex-wrap gap-1 rounded-sm bg-surface-sunken p-1"
                >
                  {(
                    [
                      ['PERCENT', 'Percentage (%)'],
                      ['AMOUNT', 'Amount (Rs)'],
                    ] as const
                  ).map(([option, label]) => (
                    <Button
                      key={option}
                      type="button"
                      variant={kind === option ? 'default' : 'ghost'}
                      className="min-h-11 shadow-none hover:translate-y-0 active:translate-y-0"
                      aria-pressed={kind === option}
                      disabled={disabled}
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
                <Label htmlFor={`${id}-value`} className="text-[13px] font-semibold">
                  {kind === 'PERCENT' ? 'Discount (%)' : 'Discount (Rs)'}
                </Label>
                <Input
                  ref={valueRef}
                  id={`${id}-value`}
                  className="h-11 w-40 font-semibold tabular-nums"
                  inputMode="decimal"
                  autoComplete="off"
                  value={value}
                  disabled={disabled}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={`${id}-maximum ${id}-help${error ? ` ${id}-error` : ''}`}
                  onChange={(event) => {
                    setValue(event.target.value);
                    setError(null);
                  }}
                />
              </div>
              {error ? (
                <p
                  id={`${id}-error`}
                  role="alert"
                  className="rounded-sm bg-destructive/10 px-3.5 py-3 text-destructive"
                >
                  {error}
                </p>
              ) : null}
              <CounterNote tone="warning">
                <p id={`${id}-help`}>
                  {toLine
                    ? approvalCopy.discountApprovalLine
                    : toBill
                      ? approvalCopy.discountApprovalBill
                      : approvalCopy.discountApproval}
                </p>
              </CounterNote>
              {approvers ? (
                // Existing lines take approval in this sheet. The other targets open their own approval dialog.
                <section
                  aria-labelledby={`${id}-supervisor`}
                  className="space-y-2.5 border-t border-border-subtle pt-4"
                >
                  <h3
                    id={`${id}-supervisor`}
                    className="text-[13px] font-semibold text-text-strong"
                  >
                    Supervisor approval
                  </h3>
                  <CounterNote tone="warning">
                    <p>
                      <b className="font-semibold text-text-strong">
                        A manager or owner must approve a discount you cannot give on your own.
                      </b>{' '}
                      {approvalCopy.discountSupervisorHow}{' '}
                      {toLine
                        ? 'when you apply it to this line'
                        : toBill
                          ? 'when you apply it to the bill'
                          : 'when you add the item'}
                      . The approval and both names are saved with the sale.
                    </p>
                  </CounterNote>
                  {toLine &&
                    (form.codeOnly ||
                      (approvers.status === 'ready' && approvers.list.length > 0)) && (
                      <>
                        <ApprovalNames form={form}>
                          <Label htmlFor={id + '-approver'}>Approving manager or owner</Label>
                          <SelectField
                            id={id + '-approver'}
                            value={approverId}
                            onChange={(e) => {
                              setApproverId(e.target.value);
                              setSecret('');
                            }}
                          >
                            <option value="">Use my own discount right</option>
                            {form
                              .visible(approvers.status === 'ready' ? approvers.list : [])
                              .map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.name}
                                </option>
                              ))}
                          </SelectField>
                        </ApprovalNames>
                        <Label htmlFor={id + '-secret'}>{approvalCopy.approverLabel}</Label>
                        <Input
                          id={id + '-secret'}
                          type="password"
                          inputMode="numeric"
                          autoComplete="off"
                          maxLength={8}
                          disabled={(!form.codeOnly && !approverId) || sending}
                          value={secret}
                          onChange={(e) => setSecret(e.target.value)}
                        />
                        <ApprovalFallback form={form} disabled={sending} />
                      </>
                    )}
                  {form.codeOnly || form.matches ? null : approvers.status === 'loading' ? (
                    <p role="status" className="text-text-muted">
                      Checking who can approve…
                    </p>
                  ) : approvers.status === 'error' ? (
                    <p role="status" className="text-text-muted">
                      Who can approve could not be loaded. You are still asked for an approval if
                      the discount needs one.
                    </p>
                  ) : approvers.list.length === 0 ? (
                    <p role="status" className="text-text-muted">
                      No manager or owner can approve a discount at this till yet. A discount that
                      needs approval cannot be given until one is set up to approve.
                    </p>
                  ) : (
                    <div className="space-y-1">
                      <p id={`${id}-who`} className="text-xs text-text-muted">
                        Who can approve
                      </p>
                      <ul aria-labelledby={`${id}-who`} className="flex flex-wrap gap-1.5">
                        {approvers.list.map((approver) => (
                          <li
                            key={approver.id}
                            className="rounded-full bg-surface-sunken px-3 py-1.5 font-semibold text-text-strong"
                          >
                            {approver.self ? `${approver.name} (you)` : approver.name}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
              ) : null}
            </div>
            <CounterSheetFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 shadow-none hover:translate-y-0 active:translate-y-0"
                onClick={() => {
                  resetLine();
                  setOpen(false);
                  setTarget('ITEM');
                  setError(null);
                  onOpenChange?.(false);
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="min-h-11"
                disabled={disabled || sending || (toBill && wholeBill?.disabled)}
              >
                {toLine
                  ? sending
                    ? 'Applying…'
                    : 'Apply to selected line'
                  : toBill
                    ? sending
                      ? 'Applying…'
                      : 'Apply to bill'
                    : 'Apply to next item'}
              </Button>
            </CounterSheetFooter>
          </form>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
