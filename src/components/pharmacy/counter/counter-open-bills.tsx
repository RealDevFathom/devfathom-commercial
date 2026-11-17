'use client';

import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { StatusPill } from '@/components/ui/status-pill';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import type { SaleVoidReason } from '@/lib/pharmacy/sale-void-reasons';
import { CounterVoidDialog } from './counter-void-dialog';

export type CounterOpenBill = {
  saleId: string;
  status: 'OPEN' | 'HELD';
  createdAt: Date | string;
  openedBy: string | null;
  lineCount: number;
  reservedUnits: number;
  netMinor: number;
  tenderedMinor: number;
  customerOrder: boolean;
};

type Props = {
  bills: readonly CounterOpenBill[] | undefined;
  loading: boolean;
  error: string | null;
  activeSaleId: string | null;
  /** True while the counter is busy or a payment outcome is unresolved. */
  disabled: boolean;
  onRefresh: () => void;
  onResume: (bill: CounterOpenBill) => Promise<boolean>;
  onVoid: (bill: CounterOpenBill, reason: SaleVoidReason) => Promise<boolean>;
};

function openedLabel(bill: CounterOpenBill): string {
  const time = new Date(bill.createdAt).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return bill.openedBy ? `Opened ${time} by ${bill.openedBy}` : `Opened ${time}`;
}

/**
 * DEV-623: every unpaid OPEN or HELD bill in the branch. Each one keeps its stock
 * allocated, so a bill lost to a reload or another browser is resumed or voided
 * here. The server re-checks the branch gate and the transition on every action.
 */
export function CounterOpenBills({
  bills,
  loading,
  error,
  activeSaleId,
  disabled,
  onRefresh,
  onResume,
  onVoid,
}: Props) {
  const [open, setOpen] = useState(false);
  // DEV-508: the bill whose void is being confirmed, with a reason, in the void dialog.
  const [confirmVoid, setConfirmVoid] = useState<CounterOpenBill | null>(null);
  const reasonId = useId();
  const count = bills?.length ?? 0;
  return (
    <>
      <Button
        variant="outline"
        className="h-11"
        onClick={() => {
          setConfirmVoid(null);
          setOpen(true);
          onRefresh();
        }}
      >
        Open bills{count ? ` (${count})` : ''}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
          <DialogTitle>Open and held bills</DialogTitle>
          <DialogDescription>
            Unpaid bills keep their stock off the shelf until they are paid or voided. Resume a bill
            to finish it, or void it to put its stock back.
          </DialogDescription>
          {error ? (
            <div className="grid gap-2">
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
              <Button variant="outline" className="h-11 justify-self-start" onClick={onRefresh}>
                Retry
              </Button>
            </div>
          ) : loading && !bills ? (
            <p role="status" className="text-sm text-text-muted">
              Loading open bills…
            </p>
          ) : !count ? (
            <p className="text-sm text-text-muted">No open or held bills in this branch.</p>
          ) : (
            <ul className="grid gap-3" aria-label="Open and held bills">
              {bills!.map((bill, index) => {
                const current = bill.saleId === activeSaleId;
                // The server refuses this void too; the money must be refunded first.
                const paid = bill.tenderedMinor > 0;
                const paidReason = `refund-first-${bill.saleId}`;
                const busyReason = `${reasonId}-busy-${index}`;
                const currentReason = `${reasonId}-current-${index}`;
                return (
                  <li
                    key={bill.saleId}
                    className="grid gap-2 border-b border-border-subtle pb-3 last:border-b-0"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill
                        status={bill.status === 'HELD' ? 'held' : 'open'}
                        tone={bill.status === 'HELD' ? 'warning' : 'info'}
                        label={bill.status === 'HELD' ? 'Held' : 'Open'}
                      />
                      {current ? (
                        <StatusPill status="active" tone="info" label="On this counter" />
                      ) : null}
                      {bill.customerOrder ? (
                        <StatusPill status="order" tone="neutral" label="Customer order" />
                      ) : null}
                    </div>
                    <p className="text-sm text-text-body">{openedLabel(bill)}</p>
                    <p className="text-sm text-text-body">
                      {bill.lineCount} {bill.lineCount === 1 ? 'line' : 'lines'} ·{' '}
                      {bill.reservedUnits} {bill.reservedUnits === 1 ? 'unit' : 'units'} held ·{' '}
                      <span className="font-mono tabular-nums">{formatMinor(bill.netMinor)}</span>
                      {bill.tenderedMinor ? (
                        <>
                          {' '}
                          · paid{' '}
                          <span className="font-mono tabular-nums">
                            {formatMinor(bill.tenderedMinor)}
                          </span>
                        </>
                      ) : null}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        className="h-11"
                        disabled={disabled || current}
                        aria-describedby={
                          disabled ? busyReason : current ? currentReason : undefined
                        }
                        onClick={() => {
                          void onResume(bill).then((done) => {
                            if (done) setOpen(false);
                          });
                        }}
                      >
                        {current ? 'On this counter' : 'Resume'}
                      </Button>
                      <Button
                        variant="outline"
                        className="h-11"
                        disabled={disabled || paid}
                        aria-describedby={
                          [disabled ? busyReason : '', paid ? paidReason : '']
                            .filter(Boolean)
                            .join(' ') || undefined
                        }
                        onClick={() => setConfirmVoid(bill)}
                      >
                        Void
                      </Button>
                    </div>
                    {disabled ? (
                      <p id={busyReason} className="text-sm text-text-muted">
                        Wait for the current counter action to finish or review payment status.
                      </p>
                    ) : null}
                    {current && !disabled ? (
                      <p id={currentReason} className="text-sm text-text-muted">
                        This bill is already on this counter.
                      </p>
                    ) : null}
                    {paid ? (
                      <p id={paidReason} className="text-sm text-text-muted">
                        Payment was taken on this bill. A manager or owner must refund it before the
                        bill can be voided.
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {/* Nested in the list dialog so focus returns to it on close. */}
          <CounterVoidDialog
            open={confirmVoid !== null}
            onOpenChange={(next) => {
              if (!next) setConfirmVoid(null);
            }}
            busy={disabled}
            onConfirm={(reason) => {
              const bill = confirmVoid;
              if (!bill) return;
              void onVoid(bill, reason).then(() => setConfirmVoid(null));
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
