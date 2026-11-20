'use client';

import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import { formatMinor, formatReceiptIssuedAt } from '@/lib/pharmacy/counter-receipt';
import { reconcileSalesCsv, type ReconcileSale } from '@/lib/pharmacy/counter-reconcile';
import { trpc } from '@/lib/trpc';

import { COUNTER_NATIVE_SELECT_CLASS } from './counter-drawer-operator';
import { useCounterReconcile, type CounterReconcileView } from './use-counter-reconcile';

type Outcome = 'ENTERED_ONLINE' | 'MONEY_RETURNED' | 'OTHER';

const OUTCOMES: Array<{ value: Outcome; label: string }> = [
  { value: 'ENTERED_ONLINE', label: 'Entered as a sale online' },
  { value: 'MONEY_RETURNED', label: 'Money given back to the customer' },
  { value: 'OTHER', label: 'Something else (say what in the note)' },
];

function money(amountMinor: number): string {
  return `Rs ${formatMinor(amountMinor)}`;
}

function download(sales: readonly ReconcileSale[]) {
  const blob = new Blob([reconcileSalesCsv(sales)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  // Named by the receipt numbers it holds; the export carries no day of its own.
  const numbers = sales.map((sale) => sale.receiptNumber).filter((n): n is number => n !== null);
  const range = numbers.length ? `-receipts-${Math.min(...numbers)}-${Math.max(...numbers)}` : '';
  link.download = `offline-sales-to-reconcile${range}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function recordError(error: unknown): string {
  const code = (error as { data?: { code?: string } } | null)?.data?.code;
  if (code === 'FORBIDDEN' || code === 'UNAUTHORIZED')
    return 'Only a manager of this branch can record this. Ask a manager to sign in on this computer.';
  if (code === 'NOT_FOUND') return 'The server does not know this counter at this branch.';
  return 'This could not be recorded just now. Nothing changed; try again.';
}

function RecordOutcome({
  sale,
  branchId,
  online,
  onRecorded,
}: {
  sale: ReconcileSale;
  branchId: string;
  online: boolean;
  onRecorded: (message: string) => Promise<void>;
}) {
  const id = useId();
  const record = trpc.pharmacyOffline.recordUnsentOfflineSale.useMutation({ retry: false });
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>('ENTERED_ONLINE');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        disabled={!online}
        onClick={() => setOpen(true)}
      >
        Record what was done
      </Button>
    );
  return (
    <form
      className="w-full space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!note.trim()) {
          setError('Write what was done with this sale.');
          return;
        }
        setError(null);
        void record
          .mutateAsync({
            branchId,
            deviceId: sale.deviceId,
            commandId: sale.commandId,
            sequence: sale.sequence,
            receiptNumber: sale.receiptNumber ?? 1,
            amountMinor: sale.amountMinor,
            soldAt: sale.soldAt,
            sealHash: sale.sealHash,
            outcome,
            note: note.trim(),
          })
          .then((result) =>
            onRecorded(
              result.recorded
                ? `Receipt ${sale.receiptNumber ?? '—'} is recorded and no longer kept on this computer.`
                : `The server already holds receipt ${sale.receiptNumber ?? '—'}, so it is no longer kept on this computer.`
            )
          )
          .catch((failure: unknown) => setError(recordError(failure)));
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-outcome`}>What was done</Label>
          <select
            id={`${id}-outcome`}
            className={COUNTER_NATIVE_SELECT_CLASS}
            value={outcome}
            disabled={record.isPending}
            onChange={(event) => setOutcome(event.target.value as Outcome)}
          >
            {OUTCOMES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-note`}>Note</Label>
          <Input
            id={`${id}-note`}
            className="min-h-11"
            value={note}
            maxLength={500}
            disabled={record.isPending}
            aria-invalid={error !== null}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(event) => setNote(event.target.value)}
            placeholder="For example: entered as bill 4512"
          />
        </div>
      </div>
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="min-h-11" disabled={record.isPending || !online}>
          {record.isPending ? 'Recording…' : 'Record'}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={record.isPending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * DEV-957 phase 2 (review B2): offline sales a revoked (or removed) counter took on this
 * computer and never sent. Kept read-only; never deleted by a revoke, a wipe or a sign-out.
 * Anyone at the counter sees them; a manager exports them and records each one.
 */
export function CounterSalesToReconcileList({
  view,
  branchId,
  online,
}: {
  view: CounterReconcileView;
  branchId: string;
  online: boolean;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  if (!view.sales.length && !notice) return null;
  return (
    <section
      aria-label="Sales to reconcile"
      className="mb-3 space-y-3 rounded-lg border border-border-subtle bg-surface-raised p-4 text-sm"
      data-counter-sales-to-reconcile=""
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold text-text-strong">
            Sales to reconcile ({view.sales.length})
          </h2>
          <p className="max-w-prose text-text-body">
            Offline sales taken on a counter that was later revoked or removed from this
            computer, and never sent to the server. The cash was taken, but these sales are not
            booked. They are kept here read-only: they cannot be sold again, changed or sent. A
            manager exports them and records what was done with each one.
          </p>
        </div>
        {view.sales.length ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => download(view.sales)}
          >
            Export (CSV)
          </Button>
        ) : null}
      </div>
      {!online && view.sales.length ? (
        <p className="text-text-muted">Recording what was done needs the connection.</p>
      ) : null}
      {notice ? (
        <p className="text-text-body" role="status">
          {notice}
        </p>
      ) : null}
      <ul className="divide-y divide-border-subtle">
        {view.sales.map((sale) => (
          <li key={`${sale.recordKey}:${sale.commandId}`} className="space-y-2 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <div className="min-w-0">
                <p className="font-medium text-text-strong tabular-nums">
                  Receipt {sale.receiptNumber ?? '—'} · {formatReceiptIssuedAt(sale.soldAt)}
                </p>
                <p className="text-xs text-text-muted">
                  {sale.counterName ? `Counter ${sale.counterName}` : 'A removed counter'}
                  {sale.cashierName ? ` · sold by ${sale.cashierName} (offline)` : ''}
                </p>
                <p className="break-words text-xs text-text-body">
                  {sale.lines
                    .map(
                      (line) =>
                        `${line.quantity} × ${line.medicineName ?? 'medicine'} (${line.saleUnit.toLowerCase()})`
                    )
                    .join(', ')}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium tabular-nums text-text-strong">
                  {money(sale.amountMinor)}
                </span>
                <StatusPill status="not-booked" tone="warning" label="Not booked" />
              </div>
            </div>
            <RecordOutcome
              sale={sale}
              branchId={branchId}
              online={online}
              onRecorded={async (message) => {
                await view.settle(sale);
                setNotice(message);
              }}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CounterSalesToReconcile(props: {
  organizationId: string;
  branchId: string;
  online: boolean;
  refreshKey?: unknown;
}) {
  const view = useCounterReconcile(props);
  return <CounterSalesToReconcileList view={view} branchId={props.branchId} online={props.online} />;
}
