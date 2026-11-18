'use client';

import { useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import { browserUuid } from '@/lib/browser-uuid';
import type {
  CardTerminalCounterPhase,
  CardTerminalCounterView,
} from '@/lib/pharmacy/card-terminal/counter-view';
import { counterPaymentErrorMessage } from '@/lib/pharmacy/counter-messages';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { trpc } from '@/lib/trpc';

/**
 * DEV-743: an integrated card-terminal payment at the counter, driven by the one durable
 * attempt record on the server. It renders nothing unless the server says an admitted terminal
 * serves this counter; no provider is bound yet, so the counter normally shows only its manual
 * Card and Wallet tenders, which this panel never touches.
 *
 * Counter states: sending and waiting while the charge is out (dispatch, pending); paid;
 * declined; unknown, with a status check that asks the terminal again and never charges again;
 * and manual review, which waits for a manager or owner.
 */

type Props = {
  branchId: string;
  saleId: string | null;
  deviceId: string | null;
  /** The bill's balance still due, charged in full on the terminal. */
  balanceMinor: number | null;
  disabled?: boolean;
  businessDate: () => Date;
  /** The terminal payment became a tender: re-read the bill. */
  onSettled: () => void;
};

const COPY: Record<CardTerminalCounterPhase, { label: string; tone: StatusTone; text: string }> = {
  SENDING: {
    label: 'Sending',
    tone: 'info',
    text: 'Sending this payment to the card terminal. Do not take another payment on this bill.',
  },
  PENDING: {
    label: 'Waiting',
    tone: 'warning',
    text: 'Waiting for the customer at the card terminal. Do not take another payment on this bill.',
  },
  UNKNOWN: {
    label: 'Unknown',
    tone: 'danger',
    text: 'The terminal did not confirm this payment, so the customer may have been charged. Do not take another payment: check its status.',
  },
  RECORDING: {
    label: 'Approved',
    tone: 'info',
    text: 'The terminal approved this payment. It is being recorded on the bill.',
  },
  PAID: { label: 'Paid', tone: 'success', text: 'Card payment recorded on this bill.' },
  DECLINED: {
    label: 'Declined',
    tone: 'warning',
    text: 'The terminal declined this payment. Nothing was charged. Take the payment again.',
  },
  NOT_SENT: {
    label: 'Not sent',
    tone: 'neutral',
    text: 'This payment was never sent to the terminal. Nothing was charged. Take the payment again.',
  },
  MANUAL_REVIEW: {
    label: 'Review',
    tone: 'danger',
    text: 'A manager or owner must review this card payment before this bill can take another payment.',
  },
  REVERSED: {
    label: 'Reversed',
    tone: 'neutral',
    text: 'This card payment was reversed. Take the payment again.',
  },
};

export function CounterCardTerminalPanel(props: Props) {
  // The payment overlay stays mounted across bills: each bill gets its own panel state, so one
  // bill's result never shows on, holds or checks another bill.
  return <CardTerminalPanelForSale key={`${props.branchId}:${props.saleId ?? ''}`} {...props} />;
}

function CardTerminalPanelForSale({
  branchId,
  saleId,
  deviceId,
  balanceMinor,
  disabled = false,
  businessDate,
  onSettled,
}: Props) {
  const headingId = useId();
  const availability = trpc.pharmacyCardTerminal.availability.useQuery(
    { branchId, deviceId: deviceId ?? '' },
    { enabled: Boolean(deviceId), staleTime: 60_000 }
  );
  const available = availability.data?.available === true;
  const latest = trpc.pharmacyCardTerminal.attempt.useQuery(
    { branchId, saleId: saleId ?? '' },
    { enabled: available && Boolean(saleId) }
  );
  const charge = trpc.pharmacyCardTerminal.charge.useMutation();
  const checkStatus = trpc.pharmacyCardTerminal.checkStatus.useMutation();
  const [result, setResult] = useState<CardTerminalCounterView | null>(null);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  // An answer for this bill that arrives after the counter moved to another bill is dropped.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (!available || !saleId) return null;

  // The server's record wins over a stale mutation answer once it has been re-read.
  const view =
    result && latest.data?.attemptKey === result.attemptKey
      ? latest.data
      : (result ?? latest.data ?? null);
  const busy = charge.isPending || checkStatus.isPending;
  const phase: CardTerminalCounterPhase | null = charge.isPending
    ? 'PENDING'
    : (view?.phase ?? null);
  const held = charge.isPending || Boolean(view?.open);
  const canCharge =
    !disabled && !busy && !held && balanceMinor !== null && balanceMinor > 0 && Boolean(deviceId);

  async function settle(next: CardTerminalCounterView) {
    if (!mounted.current) return;
    setResult(next);
    await latest.refetch();
    if (mounted.current && next.phase === 'PAID') onSettled();
  }

  async function startCharge() {
    if (!canCharge || inFlight.current || balanceMinor === null || !deviceId || !saleId) return;
    inFlight.current = true;
    setError('');
    try {
      await settle(
        await charge.mutateAsync({
          branchId,
          saleId,
          deviceId,
          businessDate: businessDate(),
          amountMinor: balanceMinor,
          // One key per charge: a retried request replays this attempt, never a second charge.
          attemptKey: `card-terminal:${browserUuid()}`,
        })
      );
    } catch (failure) {
      // The attempt may have committed before the answer was lost: show what the server holds.
      const read = await latest.refetch();
      setResult(null);
      setError(
        read.data?.open
          ? 'The counter lost contact while charging. Check this payment’s status before taking another.'
          : `Payment was not sent. ${counterPaymentErrorMessage(failure)}`
      );
    } finally {
      inFlight.current = false;
    }
  }

  async function runStatusCheck() {
    if (!view || inFlight.current) return;
    inFlight.current = true;
    setError('');
    try {
      await settle(await checkStatus.mutateAsync({ branchId, attemptKey: view.attemptKey }));
    } catch (failure) {
      setError(`The status check did not finish. ${counterPaymentErrorMessage(failure)}`);
    } finally {
      inFlight.current = false;
    }
  }

  const copy = phase ? COPY[phase] : null;
  const card =
    view?.cardBrand || view?.cardLast4
      ? [view.cardBrand?.replaceAll('_', ' '), view.cardLast4 ? `•••• ${view.cardLast4}` : null]
          .filter(Boolean)
          .join(' ')
      : null;

  return (
    <section
      aria-labelledby={headingId}
      data-testid="counter-card-terminal"
      className="mb-4 space-y-3 rounded-md border border-border-subtle bg-surface-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold text-text-strong">
          Card terminal
        </h3>
        {copy ? <StatusPill status={copy.label} tone={copy.tone} /> : null}
      </div>
      <div aria-live="polite" className="space-y-1">
        {copy ? <p className="text-sm text-text-body">{copy.text}</p> : null}
        {view && phase !== 'PENDING' ? (
          <p className="font-mono text-xs text-text-muted tabular-nums">
            Rs {formatMinor(view.amountMinor)}
            {card ? ` · ${card}` : ''}
          </p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {held ? (
          view?.canCheckStatus && !charge.isPending ? (
            <Button
              variant="outline"
              className="h-11"
              disabled={busy}
              aria-busy={checkStatus.isPending}
              onClick={() => void runStatusCheck()}
            >
              {checkStatus.isPending ? 'Checking status…' : 'Check status'}
            </Button>
          ) : null
        ) : (
          <Button
            className="h-11"
            disabled={!canCharge}
            aria-busy={charge.isPending}
            onClick={() => void startCharge()}
          >
            {balanceMinor !== null && balanceMinor > 0
              ? `Charge Rs ${formatMinor(balanceMinor)} on terminal`
              : 'Charge on terminal'}
          </Button>
        )}
      </div>
    </section>
  );
}
