'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cashShiftNeedsApproval } from '@/lib/pharmacy/cash-shift-report';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { counterErrorMessage } from '@/lib/pharmacy/counter-messages';
import { amountInputError, amountInputToMinor } from '@/lib/money-input';
import { trpc } from '@/lib/trpc';

import { CashShiftReportView, shiftClockTime, shiftVarianceLabel } from './cash-shift-report-view';
import { COUNTER_NATIVE_SELECT_CLASS, type CounterCashier } from './counter-drawer-operator';

/** The counter's view of a drawer that runs shifts, as `drawerStatus` reports it. */
export type CounterCashShiftStatus = {
  openShift: CounterShiftRow | null;
  lastClosedShift: CounterShiftRow | null;
  currency: string;
};

type CounterShiftRow = {
  id: string;
  sequence: number;
  cashierName: string | null;
  isYours: boolean;
  openedAt: Date | string;
  countedCashMinor: number | null;
};

function typedMinor(value: string) {
  const amount = amountInputToMinor(value);
  return amount.status === 'OK' ? amount.minor : null;
}

function typedError(value: string) {
  const amount = amountInputToMinor(value);
  if (amount.status === 'INVALID') return amountInputError(amount.reason);
  if (amount.status === 'EMPTY') return 'Enter the cash you counted, or 0.';
  return null;
}

/**
 * DEV-958B: cash shifts at the counter, on a drawer whose branch runs shifts. With a shift open it
 * names whose shift it is and closes it with a count: the cash expected so far, the difference as
 * you type, a note when they differ, and a manager's approval with their PIN when the difference
 * is above the owner's limit. Between shifts it opens the next one with the cash the next cashier
 * counts. The server decides every figure and enforces every rule; this only asks for them.
 */
export function CounterCashShiftPanel({
  branchId,
  drawerSessionId,
  status,
  currency,
  timeZone,
  actorIsManager,
  cashiers,
  currentUserId,
  onChanged,
}: {
  branchId: string;
  drawerSessionId: string;
  status: CounterCashShiftStatus;
  currency: string;
  timeZone: string;
  actorIsManager: boolean;
  cashiers?: readonly CounterCashier[];
  currentUserId?: string;
  onChanged: () => void;
}) {
  const open = status.openShift;
  const last = status.lastClosedShift;
  return (
    <div className="space-y-3">
      {open ? (
        <CloseShift
          key={open.id}
          branchId={branchId}
          shift={open}
          currency={currency}
          timeZone={timeZone}
          mayClose={open.isYours || actorIsManager}
          onClosed={onChanged}
        />
      ) : (
        <>
          <OpenShift
            branchId={branchId}
            drawerSessionId={drawerSessionId}
            lastClosed={last}
            currency={currency}
            cashiers={actorIsManager ? cashiers : undefined}
            currentUserId={currentUserId}
            onOpened={onChanged}
          />
          {last && (last.isYours || actorIsManager) ? (
            <LastShiftReport
              key={last.id}
              branchId={branchId}
              shift={last}
              currency={currency}
              timeZone={timeZone}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/** The report of the shift that just closed on this drawer, for its cashier or a manager. */
function LastShiftReport({
  branchId,
  shift,
  currency,
  timeZone,
}: {
  branchId: string;
  shift: CounterShiftRow;
  currency: string;
  timeZone: string;
}) {
  const [shown, setShown] = useState(shift.isYours);
  const report = trpc.pharmacySales.shiftReport.useQuery(
    { branchId, shiftId: shift.id },
    { enabled: shown, refetchOnWindowFocus: false }
  );
  if (!shown)
    return (
      <Button
        type="button"
        variant="outline"
        className="min-h-11 rounded-control"
        onClick={() => setShown(true)}
      >
        Show shift {shift.sequence} report
      </Button>
    );
  if (report.isLoading)
    return (
      <p role="status" className="text-sm text-text-muted">
        Loading the shift {shift.sequence} report…
      </p>
    );
  if (report.error || !report.data)
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-text-body">
        {report.error ? counterErrorMessage(report.error) : 'The shift report did not load.'}
        <Button
          type="button"
          variant="outline"
          className="min-h-11 rounded-control"
          onClick={() => void report.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  return (
    <CashShiftReportView
      report={report.data.report}
      status={report.data.report.status}
      currency={currency}
      timeZone={timeZone}
    />
  );
}

function CloseShift({
  branchId,
  shift,
  currency,
  timeZone,
  mayClose,
  onClosed,
}: {
  branchId: string;
  shift: CounterShiftRow;
  currency: string;
  timeZone: string;
  mayClose: boolean;
  onClosed: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [approverId, setApproverId] = useState('');
  const [approverPin, setApproverPin] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const report = trpc.pharmacySales.shiftReport.useQuery(
    { branchId, shiftId: shift.id },
    { enabled: expanded, refetchOnWindowFocus: false }
  );
  const approvers = trpc.pharmacySales.shiftApprovers.useQuery(
    { branchId },
    { enabled: expanded, staleTime: 60_000 }
  );
  const close = trpc.pharmacySales.closeShift.useMutation();
  const countedMinor = typedMinor(counted);
  const expected = report.data?.report.cash.expectedMinor ?? null;
  const tolerance = report.data?.toleranceMinor ?? 0;
  const variance = countedMinor !== null && expected !== null ? countedMinor - expected : null;
  const needsNote = variance !== null && variance !== 0;
  const needsApproval = variance !== null && cashShiftNeedsApproval(variance, tolerance);
  const pinValid = /^\d{4,8}$/.test(approverPin);
  const ready =
    countedMinor !== null &&
    expected !== null &&
    (!needsNote || note.trim().length > 0) &&
    (!needsApproval || (Boolean(approverId) && pinValid));
  const owner = shift.isYours ? 'Your shift' : `${shift.cashierName ?? 'Another cashier'}'s shift`;

  return (
    <div
      role="region"
      aria-labelledby={`counter-shift-${shift.id}`}
      className="space-y-3 rounded-[var(--radius-sm)] border border-border-subtle bg-surface-sunken p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={`counter-shift-${shift.id}`} className="text-sm text-text-body">
          <span className="font-semibold text-text-strong">
            {owner} · shift {shift.sequence}
          </span>{' '}
          · open since {shiftClockTime(shift.openedAt, timeZone)}
        </p>
        {mayClose && !expanded ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 rounded-control"
            onClick={() => setExpanded(true)}
          >
            Close shift
          </Button>
        ) : null}
      </div>
      {!mayClose ? (
        <p className="text-sm text-text-muted">
          Only {shift.cashierName ?? 'the cashier running it'} or a manager or owner can close this
          shift.
        </p>
      ) : null}
      {expanded ? (
        <form
          className="space-y-3"
          aria-label={`Close shift ${shift.sequence}`}
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(true);
            if (!ready || close.isPending || countedMinor === null) return;
            close.mutate(
              {
                branchId,
                shiftId: shift.id,
                countedCashMinor: countedMinor,
                ...(note.trim() ? { varianceNote: note.trim() } : {}),
                ...(needsApproval ? { approval: { approverId, approverPin } } : {}),
              },
              {
                // The PIN is never kept after an attempt, accepted or refused.
                onSettled: () => setApproverPin(''),
                onSuccess: () => onClosed(),
                onError: () => void report.refetch(),
              }
            );
          }}
        >
          {report.isLoading ? (
            <p role="status" className="text-sm text-text-muted">
              Working out the cash this shift should hold…
            </p>
          ) : report.error ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-text-body">
              {counterErrorMessage(report.error)}
              <Button
                type="button"
                variant="outline"
                className="min-h-11 rounded-control"
                onClick={() => void report.refetch()}
              >
                Check again
              </Button>
            </div>
          ) : expected !== null ? (
            <p className="text-sm text-text-body">
              Cash expected in the drawer:{' '}
              <span className="font-mono font-semibold tabular-nums text-text-strong">
                {currency} {formatMinor(expected)}
              </span>
            </p>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor={`shift-count-${shift.id}`}>Cash counted ({currency})</Label>
            <Input
              id={`shift-count-${shift.id}`}
              className="min-h-11"
              inputMode="decimal"
              autoComplete="off"
              value={counted}
              disabled={close.isPending}
              aria-invalid={submitted && countedMinor === null}
              aria-describedby={`shift-count-${shift.id}-help`}
              onChange={(event) => setCounted(event.target.value)}
            />
            <p
              id={`shift-count-${shift.id}-help`}
              className="text-sm text-text-muted"
              aria-live="polite"
            >
              {submitted && countedMinor === null
                ? typedError(counted)
                : variance !== null
                  ? shiftVarianceLabel(variance, currency)
                  : 'Count every note and coin in the drawer.'}
            </p>
          </div>
          {needsNote ? (
            <div className="space-y-1.5">
              <Label htmlFor={`shift-note-${shift.id}`}>Why the count differs</Label>
              <Textarea
                id={`shift-note-${shift.id}`}
                maxLength={1000}
                value={note}
                disabled={close.isPending}
                aria-invalid={submitted && !note.trim()}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
          ) : null}
          {needsApproval ? (
            <fieldset className="space-y-2 rounded-[var(--radius-xs)] border border-warning/40 bg-surface-card p-3">
              <legend className="px-1 text-sm font-semibold text-text-strong">
                Manager approval
              </legend>
              <p className="text-sm text-text-body">
                The difference is above the owner&apos;s limit of {currency}{' '}
                {formatMinor(tolerance)}. A manager or owner approves it with their PIN.
              </p>
              {approvers.isLoading ? (
                <p role="status" className="text-sm text-text-muted">
                  Finding who can approve…
                </p>
              ) : approvers.data?.length ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={`shift-approver-${shift.id}`}>Approved by</Label>
                    <select
                      id={`shift-approver-${shift.id}`}
                      className={COUNTER_NATIVE_SELECT_CLASS}
                      value={approverId}
                      disabled={close.isPending}
                      aria-invalid={submitted && !approverId}
                      onChange={(event) => setApproverId(event.target.value)}
                    >
                      <option value="">Choose a manager or owner</option>
                      {approvers.data.map((approver) => (
                        <option key={approver.id} value={approver.id}>
                          {approver.isYou
                            ? `${approver.name ?? 'You'} (you)`
                            : (approver.name ?? 'Manager')}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`shift-approver-pin-${shift.id}`}>Their PIN</Label>
                    <Input
                      id={`shift-approver-pin-${shift.id}`}
                      className="min-h-11"
                      type="password"
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={8}
                      value={approverPin}
                      disabled={close.isPending}
                      aria-invalid={submitted && !pinValid}
                      onChange={(event) => setApproverPin(event.target.value)}
                    />
                  </div>
                </div>
              ) : (
                <p role="alert" className="text-sm text-text-body">
                  No manager or owner with a PIN works at this branch. Ask the owner to set one up
                  before this shift closes.
                </p>
              )}
            </fieldset>
          ) : null}
          {close.error ? (
            <p role="alert" className="text-sm text-destructive">
              {counterErrorMessage(close.error)}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              className="min-h-11 rounded-control"
              disabled={close.isPending || expected === null}
            >
              {close.isPending ? 'Closing shift…' : 'Close shift'}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 rounded-control"
              disabled={close.isPending}
              onClick={() => {
                setExpanded(false);
                setSubmitted(false);
                setApproverPin('');
              }}
            >
              Keep shift open
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function OpenShift({
  branchId,
  drawerSessionId,
  lastClosed,
  currency,
  cashiers,
  currentUserId,
  onOpened,
}: {
  branchId: string;
  drawerSessionId: string;
  lastClosed: CounterShiftRow | null;
  currency: string;
  cashiers?: readonly CounterCashier[];
  currentUserId?: string;
  onOpened: () => void;
}) {
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [cashierId, setCashierId] = useState(currentUserId ?? '');
  const [submitted, setSubmitted] = useState(false);
  const openShift = trpc.pharmacySales.openShift.useMutation();
  const countedMinor = typedMinor(counted);
  const left = lastClosed?.countedCashMinor ?? null;
  const difference = countedMinor !== null && left !== null ? countedMinor - left : null;
  const needsNote = difference !== null && difference !== 0;
  const ready = countedMinor !== null && (!needsNote || note.trim().length > 0);
  return (
    <form
      aria-labelledby="counter-open-shift-title"
      className="space-y-3 rounded-[var(--radius-sm)] border border-border-subtle bg-surface-sunken p-4"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (!ready || openShift.isPending || countedMinor === null) return;
        openShift.mutate(
          {
            branchId,
            drawerSessionId,
            openingFloatMinor: countedMinor,
            ...(note.trim() ? { openingNote: note.trim() } : {}),
            ...(cashiers?.length && cashierId && cashierId !== currentUserId ? { cashierId } : {}),
          },
          { onSuccess: () => onOpened() }
        );
      }}
    >
      <div className="space-y-1">
        <h3 id="counter-open-shift-title" className="text-sm font-semibold text-text-strong">
          Open the next shift
        </h3>
        <p className="text-sm text-text-body">
          {lastClosed && left !== null
            ? `Shift ${lastClosed.sequence} closed with ${currency} ${formatMinor(left)} counted. Count the cash in the drawer and enter it. Bills can be taken once your shift is open.`
            : 'Count the cash in the drawer and enter it. Bills can be taken once your shift is open.'}
        </p>
      </div>
      {cashiers?.length ? (
        <div className="space-y-1.5">
          <Label htmlFor="counter-open-shift-cashier">Cashier for this shift</Label>
          <select
            id="counter-open-shift-cashier"
            className={COUNTER_NATIVE_SELECT_CLASS}
            value={cashierId}
            disabled={openShift.isPending}
            onChange={(event) => setCashierId(event.target.value)}
          >
            {cashiers.map((cashier) => (
              <option key={cashier.id} value={cashier.id}>
                {cashier.id === currentUserId ? `${cashier.name} (you)` : cashier.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="counter-open-shift-count">Cash counted in the drawer ({currency})</Label>
        <Input
          id="counter-open-shift-count"
          className="min-h-11"
          inputMode="decimal"
          autoComplete="off"
          autoFocus
          value={counted}
          disabled={openShift.isPending}
          aria-invalid={submitted && countedMinor === null}
          aria-describedby="counter-open-shift-count-help"
          onChange={(event) => setCounted(event.target.value)}
        />
        <p
          id="counter-open-shift-count-help"
          className="text-sm text-text-muted"
          aria-live="polite"
        >
          {submitted && countedMinor === null
            ? typedError(counted)
            : difference !== null && difference !== 0
              ? `${difference > 0 ? 'More' : 'Less'} than the last shift left by ${currency} ${formatMinor(Math.abs(difference))}.`
              : difference === 0
                ? 'Matches what the last shift left.'
                : 'Type 0 if the drawer is empty.'}
        </p>
      </div>
      {needsNote ? (
        <div className="space-y-1.5">
          <Label htmlFor="counter-open-shift-note">Why the count differs</Label>
          <Textarea
            id="counter-open-shift-note"
            maxLength={500}
            value={note}
            disabled={openShift.isPending}
            aria-invalid={submitted && !note.trim()}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      ) : null}
      {openShift.error ? (
        <p role="alert" className="text-sm text-destructive">
          {counterErrorMessage(openShift.error)}
        </p>
      ) : null}
      <Button type="submit" className="min-h-11 rounded-control" disabled={openShift.isPending}>
        {openShift.isPending ? 'Opening shift…' : 'Open shift'}
      </Button>
    </form>
  );
}
