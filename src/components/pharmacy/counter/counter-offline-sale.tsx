'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Minus, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import { amountInputError, amountInputToMinor, amountInputUnit } from '@/lib/money-input';
import { searchOfflineCatalogue } from '@/lib/pharmacy/counter-offline-catalogue';
import type { CounterDraft } from '@/lib/pharmacy/counter-offline-runtime';
import {
  addToOfflineDraft,
  newOfflineDraft,
  priceOfflineBill,
  pruneOfflineDraft,
  setOfflineDraftQuantity,
} from '@/lib/pharmacy/counter-offline-sale';
import { saleUnitLabel } from '@/lib/pharmacy/counter-pricing';
import {
  formatMinor,
  formatReceiptIssuedAt,
  type CounterReceipt,
} from '@/lib/pharmacy/counter-receipt';
import { canRetryOfflineReceipt } from '@/lib/pharmacy/counter-replay-transport';
import { buildCounterReceiptPreview } from '@/lib/pharmacy/counter-receipt-presentation';
import type { CounterQueuedCommand } from '@/lib/pharmacy/counter-command-queue';

import type { CounterOfflineView } from './use-counter-offline';

/** The last sale written on this computer: its receipt and the change to hand back. */
export type OfflinePaid = { receipt: CounterReceipt; changeMinor: number };

function money(amountMinor: number): string {
  return `Rs ${formatMinor(amountMinor)}`;
}

/**
 * DEV-957 phase 2: a cash sale of listed over-the-counter medicines with no connection.
 *
 * The bill is built only from the counter's verified offline list (offline rows), saved on
 * this computer on every change, and paid in cash. "Paid" and the receipt appear only
 * after the sale is written to this computer; until then, and on any refusal, the bill
 * stays as it is and the reason is said in plain words.
 */
export function CounterOfflineSale({
  offline,
  paid,
  onPaid,
}: {
  offline: CounterOfflineView;
  /**
   * Kept by the panel, not here: a sale that uses the last receipt number or the last
   * offline unit ends offline selling, and its receipt and change must stay on screen.
   */
  paid: OfflinePaid | null;
  onPaid: (paid: OfflinePaid | null) => void;
}) {
  const { actions, rows, operator } = offline;
  const searchId = useId();
  const cashId = useId();
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<CounterDraft | null>(null);
  const [cash, setCash] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const restored = useRef(false);

  // A reload brings back the newest bill this cashier was building.
  useEffect(() => {
    if (restored.current || !actions) return;
    restored.current = true;
    const kept = offline.drafts.find((row) => row.operatorUserId === (operator?.userId ?? null));
    setDraft(kept ?? newOfflineDraft(operator?.userId ?? null, new Date()));
  }, [actions, offline.drafts, operator]);

  const bill = useMemo(() => (draft ? priceOfflineBill(draft, rows) : null), [draft, rows]);
  const results = searchOfflineCatalogue(rows, query, 8);
  const searching = query.trim().length >= 2;
  const cashInput = amountInputToMinor(cash);
  const cashMinor = cashInput.status === 'OK' ? cashInput.minor : null;
  const cashError =
    cashInput.status === 'INVALID'
      ? amountInputError(cashInput.reason)
      : bill && cashMinor !== null && cashMinor < bill.totalMinor
        ? 'The cash received is less than the total.'
        : null;
  const changeMinor =
    bill && cashMinor !== null && cashMinor >= bill.totalMinor ? cashMinor - bill.totalMinor : null;

  async function change(next: CounterDraft) {
    setDraft(next);
    setMessage(null);
    if (!actions) return;
    const saved = await actions.saveDraft(next);
    if (!saved)
      setMessage(
        'This bill could not be saved on this computer. It stays on screen; finish it before closing the browser.'
      );
  }

  /** Nothing was sold: the bill is dropped from this computer and a new one starts. */
  async function discard() {
    if (!actions || !draft) return;
    await actions.discardDraft(draft.draftId);
    setDraft(newOfflineDraft(operator?.userId ?? null, new Date()));
    setCash('');
    setMessage(null);
  }

  async function pay() {
    if (!actions || !draft || !bill || cashMinor === null || paying) return;
    setPaying(true);
    setMessage(null);
    try {
      const result = await actions.pay(draft, cashMinor);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      onPaid({ receipt: result.receipt, changeMinor: result.changeMinor });
      setDraft(newOfflineDraft(operator?.userId ?? null, new Date()));
      setCash('');
      setQuery('');
    } finally {
      setPaying(false);
    }
  }

  if (!actions || !draft || !bill)
    return (
      <p className="text-text-muted" role="status">
        Opening the offline bill…
      </p>
    );

  const quotaProblem = bill.overQuota[0];
  const canPay =
    bill.lines.length > 0 &&
    !quotaProblem &&
    cashMinor !== null &&
    cashMinor >= bill.totalMinor &&
    !paying;

  return (
    <div className="space-y-4 border-t border-border-subtle pt-3" data-counter-offline-sale="">
      <p className="text-text-body" data-counter-offline-operator="">
        <span className="font-medium text-text-strong">Recorded for: </span>
        {operator?.name
          ? `${operator.name}, who was signed in when this counter last connected. Offline sales go on their name.`
          : 'the person who was signed in when this counter last connected.'}
      </p>

      {paid ? <OfflinePaidCard paid={paid} onNext={() => onPaid(null)} /> : null}

      <div className="space-y-2">
        <Label htmlFor={searchId}>Add a medicine to the offline bill</Label>
        <Input
          id={searchId}
          type="search"
          className="min-h-11 max-w-md bg-surface-raised"
          value={query}
          autoComplete="off"
          placeholder="Type two letters of a medicine name"
          aria-describedby={`${searchId}-help`}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setQuery('');
          }}
        />
        <p id={`${searchId}-help`} className="text-xs text-text-muted">
          Only medicines this counter holds offline stock for. Prices come from the signed price
          list on this computer.
        </p>
        {searching ? (
          results.length ? (
            <ul aria-label="Offline search results" className="divide-y divide-border-subtle">
              {results.map((row) => (
                <li
                  key={`${row.inventoryLotId}:${row.stockLocationId}`}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2"
                >
                  <div className="min-w-0">
                    <p className="break-words font-medium text-text-strong">{row.medicineName}</p>
                    <p className="text-xs text-text-muted">
                      {row.presentation} · {money(row.packPriceMinor)} a pack of {row.unitsPerPack}{' '}
                      · expires {row.expiresAt.slice(0, 10)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill
                      status="quota"
                      tone="neutral"
                      label={`${row.unitsLeft} unit${row.unitsLeft === 1 ? '' : 's'} offline`}
                    />
                    {row.roundingIncrementMinor === null || row.saleUnits.length === 0 ? (
                      <span className="text-xs text-text-muted">Price check only</span>
                    ) : (
                      row.saleUnits.map((option) => (
                        <Button
                          key={`${option.kind}:${option.packLevelId}:${option.canonicalUnitsPerSaleUnit}`}
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          disabled={option.canonicalUnitsPerSaleUnit > row.unitsLeft}
                          onClick={() =>
                            void change(addToOfflineDraft(draft, row, option, new Date()))
                          }
                        >
                          Add {saleUnitLabel(option, row.dosageForm).toLowerCase()}
                        </Button>
                      ))
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-text-body" role="status">
              No medicine this counter holds offline matches “{query.trim()}”. Prescription-only,
              controlled and restricted medicines are never sold offline.
            </p>
          )
        ) : null}
      </div>

      <section aria-label="Offline bill" className="space-y-2">
        <h3 className="text-sm font-semibold text-text-strong">Offline bill</h3>
        {bill.problems.length ? (
          <div className="space-y-2" role="status">
            {bill.problems.map((problem) => (
              <p key={problem} className="text-sm text-text-body">
                {problem}
              </p>
            ))}
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => void change(pruneOfflineDraft(draft, rows, new Date()))}
            >
              Take these off the bill
            </Button>
          </div>
        ) : null}
        {bill.lines.length === 0 ? (
          <p className="text-sm text-text-muted">
            No items yet. Search above and add a pack, strip or unit.
          </p>
        ) : (
          <ul className="divide-y divide-border-subtle" aria-label="Offline bill lines">
            {bill.lines.map((line) => {
              const index = draft.lines.indexOf(line.line);
              return (
                <li
                  key={`${index}:${line.line.inventoryLotId}:${line.line.saleUnit}`}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2"
                >
                  <div className="min-w-0">
                    <p className="break-words font-medium text-text-strong">
                      {line.row.medicineName}
                    </p>
                    <p className="text-xs text-text-muted tabular-nums">
                      {line.label} · {money(line.unitPriceMinor)} each
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-11 w-11"
                      aria-label={`One less ${line.label.toLowerCase()} of ${line.row.medicineName}`}
                      onClick={() =>
                        void change(
                          setOfflineDraftQuantity(draft, index, line.line.quantity - 1, new Date())
                        )
                      }
                    >
                      <Minus aria-hidden="true" />
                    </Button>
                    <span
                      className="min-w-8 text-center font-medium tabular-nums text-text-strong"
                      aria-label={`Quantity ${line.line.quantity}`}
                    >
                      {line.line.quantity}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-11 w-11"
                      aria-label={`One more ${line.label.toLowerCase()} of ${line.row.medicineName}`}
                      onClick={() =>
                        void change(
                          setOfflineDraftQuantity(draft, index, line.line.quantity + 1, new Date())
                        )
                      }
                    >
                      <Plus aria-hidden="true" />
                    </Button>
                    <span className="w-28 text-right font-medium tabular-nums text-text-strong">
                      {money(line.lineTotalMinor)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-11 w-11"
                      aria-label={`Remove ${line.row.medicineName}`}
                      onClick={() =>
                        void change(setOfflineDraftQuantity(draft, index, 0, new Date()))
                      }
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {quotaProblem ? (
          <p className="text-sm text-destructive" role="alert">
            This counter holds only {quotaProblem.row.unitsLeft} unit
            {quotaProblem.row.unitsLeft === 1 ? '' : 's'} of {quotaProblem.row.medicineName} for
            offline selling; this bill needs {quotaProblem.units}. Lower the quantity.
          </p>
        ) : null}
        {draft.lines.length > 0 ? (
          <Button type="button" variant="ghost" className="min-h-11" onClick={() => void discard()}>
            Discard this bill
          </Button>
        ) : null}
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-border-subtle pt-2">
          <span className="eyebrow">Total</span>
          <span className="text-xl font-semibold tabular-nums text-text-strong">
            {money(bill.totalMinor)}
          </span>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,16rem)_1fr] sm:items-end">
        <div className="space-y-1">
          <Label htmlFor={cashId}>Cash received ({amountInputUnit('PKR')})</Label>
          <Input
            id={cashId}
            inputMode="decimal"
            autoComplete="off"
            className="min-h-11 bg-surface-raised tabular-nums"
            value={cash}
            placeholder="For example 500"
            aria-invalid={cashError ? true : undefined}
            aria-describedby={cashError ? `${cashId}-error` : `${cashId}-help`}
            disabled={bill.lines.length === 0}
            onChange={(event) => setCash(event.target.value)}
          />
          {cashError ? (
            <p id={`${cashId}-error`} className="text-xs text-destructive">
              {cashError}
            </p>
          ) : (
            <p id={`${cashId}-help`} className="text-xs text-text-muted">
              Cash only offline. Card, wallet, bank transfer and khata wait for the connection.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {changeMinor !== null ? (
            <p className="text-text-body">
              <span className="eyebrow mr-2">Change</span>
              <span className="text-lg font-semibold tabular-nums text-text-strong">
                {money(changeMinor)}
              </span>
            </p>
          ) : null}
          <Button type="button" className="min-h-11" disabled={!canPay} onClick={() => void pay()}>
            {paying ? 'Saving the sale…' : `Take cash ${money(bill.totalMinor)}`}
          </Button>
        </div>
      </div>
      {message ? (
        <p className="text-sm text-destructive" role="alert">
          {message}
        </p>
      ) : null}

      <OfflineQueue queued={offline.queued} />
    </div>
  );
}

export function OfflinePaidCard({ paid, onNext }: { paid: OfflinePaid; onNext: () => void }) {
  let preview: string | null = null;
  try {
    preview = buildCounterReceiptPreview(paid.receipt, 'en', 80);
  } catch {
    preview = null;
  }
  return (
    <div
      role="status"
      className="space-y-3 rounded-lg border border-border-subtle bg-success/10 p-4"
      data-counter-offline-paid=""
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <StatusPill status="paid" tone="success" label="Paid" />
          <p className="font-medium text-text-strong">
            Receipt {paid.receipt.receiptNumber} · {formatReceiptIssuedAt(paid.receipt.completedAt)}
          </p>
          {paid.receipt.cashierName ? (
            <p className="text-sm text-text-body" data-counter-offline-sold-by="">
              Sold by {paid.receipt.cashierName} (offline), who was signed in when this counter last
              connected.
            </p>
          ) : null}
          <p className="text-sm text-text-body">
            Saved and sealed on this computer. This counter sends it when the connection returns.
          </p>
        </div>
        <dl className="flex flex-wrap gap-x-8 gap-y-2">
          <div>
            <dt className="eyebrow">Total</dt>
            <dd className="text-xl font-semibold tabular-nums text-text-strong">
              {money(paid.receipt.totals.netMinor)}
            </dd>
          </div>
          <div>
            <dt className="eyebrow">Change</dt>
            <dd className="text-xl font-semibold tabular-nums text-text-strong">
              {money(paid.changeMinor)}
            </dd>
          </div>
        </dl>
      </div>
      {preview ? (
        <pre
          aria-label={`Receipt ${paid.receipt.receiptNumber}`}
          className="max-h-80 overflow-auto rounded-md border border-border-subtle bg-surface-raised p-3 font-mono text-xs text-text-body"
        >
          {preview}
        </pre>
      ) : null}
      <Button type="button" variant="outline" className="min-h-11" onClick={onNext}>
        Next customer
      </Button>
    </div>
  );
}

function commandState(command: CounterQueuedCommand): {
  label: string;
  tone: 'warning' | 'neutral' | 'danger';
} {
  if (command.status === 'QUARANTINED') return { label: 'Needs a manager', tone: 'danger' };
  if (command.status === 'IN_FLIGHT') return { label: 'Sending', tone: 'neutral' };
  return { label: 'Waiting to send', tone: 'warning' };
}

/** Sales taken offline on this computer and not yet accepted by the server, oldest first. */
export function OfflineQueue({
  queued,
  resolveConflict,
}: {
  queued: readonly CounterQueuedCommand[];
  resolveConflict?: (
    commandId: string,
    reason: string,
    action?: 'reject' | 'retry'
  ) => Promise<void>;
}) {
  return (
    <section
      aria-label="Offline sales waiting to send"
      className="space-y-2"
      data-counter-offline-queue=""
    >
      <h3 className="text-sm font-semibold text-text-strong">
        Offline sales waiting to send ({queued.length})
      </h3>
      {queued.length > 0 ? (
        <p className="text-xs text-text-muted">
          Receipts are sent in order when this counter reconnects. The server accepts a sale up to 7
          days after it was taken.
        </p>
      ) : null}
      {queued.length === 0 ? (
        <p className="text-sm text-text-muted">No offline sale is waiting on this computer.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-left">
                <th scope="col" className="eyebrow py-2 pr-3 font-normal">
                  Receipt
                </th>
                <th scope="col" className="eyebrow py-2 pr-3 font-normal">
                  Sold
                </th>
                <th scope="col" className="eyebrow py-2 pr-3 text-right font-normal">
                  Total
                </th>
                <th scope="col" className="eyebrow py-2 font-normal">
                  State
                </th>
              </tr>
            </thead>
            <tbody>
              {queued.map((command) => {
                const state = commandState(command);
                const amount = command.payload.amountMinor;
                return (
                  <tr
                    key={command.commandId}
                    className="border-b border-border-subtle last:border-0"
                  >
                    <td className="py-2 pr-3 font-medium tabular-nums text-text-strong">
                      {command.receiptNumber ?? '—'}
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-text-body">
                      {formatReceiptIssuedAt(command.clientOriginAt)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-text-strong">
                      {typeof amount === 'number' ? money(amount) : '—'}
                    </td>
                    <td className="py-2">
                      <StatusPill status={state.label} tone={state.tone} label={state.label} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {queued[0]?.status === 'QUARANTINED' ? (
        <OfflineReceiptReview
          key={queued[0].commandId}
          sale={queued[0]}
          resolve={resolveConflict}
        />
      ) : null}
    </section>
  );
}

function OfflineReceiptReview({
  sale,
  resolve,
}: {
  sale: CounterQueuedCommand;
  resolve?: (commandId: string, reason: string, action?: 'reject' | 'retry') => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const id = useId();
  return (
    <section
      aria-label="Manager receipt review"
      className="space-y-3 rounded-md border border-border-subtle bg-surface-raised p-4"
    >
      <h4 className="font-semibold text-text-strong">Review receipt {sale.receiptNumber}</h4>
      <p className="text-sm text-text-body">
        {sale.rejection} Later receipts wait here until this one is settled.
      </p>
      {resolve ? (
        <form
          className="space-y-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy.current || !note.trim()) return;
            busy.current = true;
            setPending(true);
            setError('');
            try {
              const submitter = (event.nativeEvent as SubmitEvent).submitter;
              if (submitter?.getAttribute('value') === 'retry') {
                await resolve(sale.commandId, note.trim(), 'retry');
              } else {
                await resolve(sale.commandId, note.trim());
              }
            } catch (failure) {
              setError(
                failure instanceof Error
                  ? failure.message
                  : 'Review could not be confirmed. The receipt is kept here.'
              );
            } finally {
              busy.current = false;
              setPending(false);
            }
          }}
        >
          <Label htmlFor={id}>Manager note for receipt {sale.receiptNumber}</Label>
          <Input
            id={id}
            className="min-h-11 rounded-control"
            value={note}
            maxLength={500}
            required
            disabled={pending}
            onChange={(event) => setNote(event.target.value)}
            aria-describedby={id + '-effect'}
          />
          <p id={id + '-effect'} className="text-sm text-text-muted">
            Record how you handled the cash. Confirming closes this receipt as rejected without
            booking a sale or issuing a refund.
          </p>
          {canRetryOfflineReceipt(sale.refusalCode) && (
            <Button
              type="submit"
              value="retry"
              className="min-h-11"
              disabled={pending || !note.trim()}
            >
              Try again
            </Button>
          )}
          <Button
            type="submit"
            variant="destructive"
            className="min-h-11"
            disabled={pending || !note.trim()}
          >
            {pending ? 'Recording review…' : 'Confirm rejection'}
          </Button>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </form>
      ) : (
        <p className="text-sm text-text-muted">
          A manager can record the outcome on this counter when it is online.
        </p>
      )}
    </section>
  );
}
