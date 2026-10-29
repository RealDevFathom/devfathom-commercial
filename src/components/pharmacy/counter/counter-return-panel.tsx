'use client';

import { OperationApproval, operationApprovalReady } from './operation-approval';
import { useRef, useState, useSyncExternalStore } from 'react';
import { z } from '@/lib/zod-csp';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { trpc } from '@/lib/trpc';
import { browserUuid } from '@/lib/browser-uuid';
import { counterErrorMessage } from '@/lib/pharmacy/counter-messages';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { buildCounterBrowserReceipt } from '@/lib/pharmacy/counter-browser-print';

const attemptSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('return'),
    saleId: z.string(),
    input: z.object({
      branchId: z.string(),
      saleLineId: z.string(),
      lotId: z.string().optional(),
      canonicalUnits: z.number().int().positive(),
      disposition: z.enum(['RESTOCK', 'QUARANTINE']),
      quarantineLocationId: z.string().optional(),
      reason: z.string(),
      integrityDecision: z.string(),
      idempotencyKey: z.string(),
    }),
  }),
  z.object({
    kind: z.literal('refund'),
    saleId: z.string(),
    input: z.object({
      branchId: z.string(),
      originalTenderId: z.string(),
      amountMinor: z.number().int().positive(),
      deviceId: z.string(),
      businessDate: z.string(),
      reason: z.string(),
      idempotencyKey: z.string(),
      manualCashFallback: z.boolean(),
      // Preserve legacy saved attempts verbatim for idempotent recovery.
      requireReturnedValue: z.literal(true).optional(),
    }),
  }),
]);
type Attempt = z.infer<typeof attemptSchema>;
type Props = {
  branchId: string;
  organizationId: string;
  accountId: string;
  deviceId: () => string;
  businessDate: () => Date;
};
const selectClass =
  'h-11 w-full rounded-md border border-input bg-surface-card px-3 text-text-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50';

export function CounterReturnPanel(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" className="h-11" onClick={() => setOpen(true)}>
        Returns & refunds
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogTitle>Returns & refunds</DialogTitle>
          <DialogDescription>
            Find the original receipt, record returned stock, then refund its original tenders.
          </DialogDescription>
          {open && (
            <ReturnForm
              key={`${props.organizationId}:${props.accountId}:${props.branchId}`}
              {...props}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function subscribeConnection(changed: () => void) {
  window.addEventListener('online', changed);
  window.addEventListener('offline', changed);
  return () => {
    window.removeEventListener('online', changed);
    window.removeEventListener('offline', changed);
  };
}

export function ReturnForm({ branchId, organizationId, accountId, deviceId, businessDate }: Props) {
  const [approvalPin, setApprovalPin] = useState('');
  const [checkerId, setCheckerId] = useState('');
  const approvers = trpc.pharmacySales.rxApprovers.useQuery({ branchId, purpose: 'OPERATION' });
  const approvalReady =
    !approvers.isFetching &&
    !approvers.isError &&
    operationApprovalReady(approvers.data, approvalPin, checkerId);
  const storageKey = `pharmacy-return:${organizationId}:${accountId}:${branchId}`;
  // This form mounts only after opening the client-side dialog. Read recovery once,
  // before enabling any mutation; the parent key isolates account and branch changes.
  const [recovery] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      const attempt = saved ? attemptSchema.parse(JSON.parse(saved)) : null;
      if (attempt && attempt.input.branchId !== branchId) throw new Error('Branch mismatch');
      return { attempt, error: '' };
    } catch {
      return {
        attempt: null,
        error:
          'Saved return recovery is unavailable. Ask a supervisor before starting another refund.',
      };
    }
  });
  const ready = !recovery.error;
  const online = useSyncExternalStore(
    subscribeConnection,
    () => navigator.onLine,
    () => false
  );
  const [number, setNumber] = useState('');
  const [searched, setSearched] = useState(0);
  const [saleId, setSaleId] = useState(recovery.attempt?.saleId ?? '');
  const [lineId, setLineId] = useState('');
  const [lotId, setLotId] = useState('');
  const [units, setUnits] = useState('1');
  const [reason, setReason] = useState('WRONG_ITEM');
  const [disposition, setDisposition] = useState<'RESTOCK' | 'QUARANTINE'>('QUARANTINE');
  const [location, setLocation] = useState('');
  const [integrity, setIntegrity] = useState('');
  const [tenderId, setTenderId] = useState('');
  const [amount, setAmount] = useState('');
  const [manual, setManual] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(recovery.attempt);
  const [busy, setBusy] = useState(false);
  const latch = useRef(false);
  const [message, setMessage] = useState(
    recovery.attempt
      ? 'An earlier attempt needs reconciliation. Retry the saved attempt with the same reference.'
      : ''
  );
  const [error, setError] = useState(recovery.error);
  const lookup = trpc.pharmacySales.lookupReceiptByNumber.useQuery(
    { branchId, receiptNumber: searched || 1 },
    { enabled: ready && online && searched > 0, retry: false }
  );
  const history = trpc.pharmacySales.returnHistory.useQuery(
    { branchId, saleId },
    { enabled: ready && online && !!saleId, retry: false }
  );
  const receipt = trpc.pharmacySales.counterReceipt.useQuery(
    { branchId, saleId },
    { enabled: ready && online && !!saleId, retry: false }
  );
  const returnLine = trpc.pharmacySales.returnLine.useMutation();
  const refund = trpc.pharmacySales.refundTender.useMutation();
  const data = history.data;
  const line = data?.lines.find((row) => row.id === lineId);
  const selectedLot = line?.lots.find((row) => row.lotId === lotId);
  const maximumUnits =
    selectedLot?.returnableUnits ?? (line ? line.canonicalUnits - line.returnedUnits : 0);
  const tender = data?.tenders.find((row) => row.id === tenderId);
  const manualRequired = tender?.type === 'CARD' || tender?.type === 'WALLET';
  const amountMinor = /^\d+(\.\d{1,2})?$/.test(amount) ? Math.round(Number(amount) * 100) : 0;
  const available = Math.min(
    data?.refundableMinor ?? 0,
    tender ? tender.amountMinor - tender.refundedMinor : 0
  );
  const locked = busy || !!attempt || !ready || !online;
  const stale = history.isFetching || history.isError;

  async function execute(next: Attempt) {
    if (latch.current || !online || !ready || !approvalReady) return;
    const approval = { approvalPin, approvedByUserId: checkerId || undefined };
    setApprovalPin('');
    latch.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      // Write before sending; an ambiguous network outcome can only replay this exact request.
      localStorage.setItem(storageKey, JSON.stringify(next));
      setAttempt(next);
      if (next.kind === 'return') {
        const result = await returnLine.mutateAsync({ ...next.input, ...approval });
        if (result && 'blocked' in result) throw new Error(result.blocked);
      } else
        await refund.mutateAsync({
          ...next.input,
          ...approval,
          businessDate: new Date(next.input.businessDate),
        });
      await history.refetch({ throwOnError: true });
      localStorage.removeItem(storageKey);
      setAttempt(null);
      setConfirmed(false);
      setUnits('1');
      setAmount('');
      setMessage(
        next.kind === 'return'
          ? 'Return recorded. Choose an original tender to refund.'
          : 'Refund recorded. Loyalty tender refunds restore redeemed points. Reprint the receipt below.'
      );
    } catch (cause) {
      const code = (cause as { data?: { code?: string } })?.data?.code;
      if (['BAD_REQUEST', 'FORBIDDEN', 'NOT_FOUND', 'UNAUTHORIZED'].includes(code ?? '')) {
        try {
          localStorage.removeItem(storageKey);
          setAttempt(null);
        } catch {
          /* Keep recovery locked. */
        }
      }
      setError(
        `${counterErrorMessage(cause)} Check history before handing out cash; an unknown outcome must use the saved retry.`
      );
    } finally {
      latch.current = false;
      setBusy(false);
    }
  }

  function print() {
    try {
      if (!receipt.data || !data || stale || receipt.isFetching || receipt.isError)
        throw new Error('Reload receipt and return history before printing.');
      const popup = window.open('', '_blank', 'popup,width=480,height=720');
      if (!popup) throw new Error('Allow pop-ups to reprint this receipt.');
      popup.opener = null;
      popup.document.open();
      popup.document.write(buildCounterBrowserReceipt(receipt.data, 'en', 'THERMAL', true));
      popup.document.close();
      const appendix = popup.document.createElement('pre');
      appendix.textContent =
        '\nRETURNS & REFUNDS\n' +
        data.returns
          .map(
            (row) =>
              `${row.createdAt.toISOString()} ${row.reason}\n${row.lines.map((item) => `${data.lines.find((l) => l.id === item.saleLineId)?.name ?? 'Item'}: ${item.canonicalUnits} units · ${item.integrityDecision}`).join('\n')}`
          )
          .join('\n') +
        '\n' +
        data.tenders
          .flatMap((row) =>
            row.refunds.map(
              (item) => `${row.type}: PKR ${formatMinor(item.amountMinor)} · ${item.reason}`
            )
          )
          .join('\n');
      popup.document.body.append(appendix);
      popup.focus();
      popup.print();
      setMessage('Browser print dialog requested. Paper delivery is not confirmed.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Receipt could not print.');
    }
  }

  return (
    <div className="space-y-4">
      {!online && <p role="alert">Offline. Returns and refunds require a connection.</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <OperationApproval
        id="return-approval"
        data={approvers.data}
        loading={approvers.isLoading}
        error={approvers.isError}
        disabled={busy || !online || !ready}
        pin={approvalPin}
        checkerId={checkerId}
        onPin={setApprovalPin}
        onChecker={setCheckerId}
      />
      {attempt && (
        <Button
          className="h-11"
          disabled={busy || !online || !ready || !approvalReady}
          onClick={() => void execute(attempt)}
        >
          Retry saved {attempt.kind}
        </Button>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSearched(Number(number));
          setSaleId('');
          setLineId('');
          setTenderId('');
          setConfirmed(false);
        }}
      >
        <div>
          <Label htmlFor="return-receipt">Receipt number</Label>
          <Input
            id="return-receipt"
            type="number"
            min="1"
            step="1"
            required
            value={number}
            disabled={locked}
            onChange={(event) => setNumber(event.target.value)}
            className="h-11"
          />
        </div>
        <Button
          type="submit"
          variant="outline"
          className="h-11"
          disabled={locked || !Number.isSafeInteger(Number(number)) || Number(number) < 1}
        >
          Find receipt
        </Button>
      </form>
      {lookup.isFetching && searched > 0 && <p role="status">Looking up receipt…</p>}
      {lookup.isError && (
        <p role="alert">
          {counterErrorMessage(lookup.error)}{' '}
          <Button variant="outline" onClick={() => void lookup.refetch()}>
            Retry lookup
          </Button>
        </p>
      )}
      {searched > 0 && lookup.isSuccess && lookup.data.length === 0 && (
        <p>No settled receipt found in this branch.</p>
      )}
      {!!lookup.data?.length && (
        <div className="space-y-2">
          <p>Choose the matching date and counter. Receipt numbers can repeat.</p>
          {lookup.data.map((row) => (
            <Button
              key={row.id}
              variant="outline"
              className="h-auto min-h-11 w-full whitespace-normal"
              disabled={locked}
              aria-pressed={row.id === saleId}
              onClick={() => {
                setSaleId(row.id);
                setLineId('');
                setTenderId('');
                setConfirmed(false);
              }}
            >
              Receipt {row.receiptNumber} · {row.businessDate?.toISOString().slice(0, 10)} ·{' '}
              {row.receiptDeviceId}
            </Button>
          ))}
        </div>
      )}
      {saleId && history.isFetching && <p role="status">Loading return history…</p>}
      {saleId && history.isError && (
        <p role="alert">
          {counterErrorMessage(history.error)}{' '}
          <Button variant="outline" onClick={() => void history.refetch()}>
            Reload history
          </Button>
        </p>
      )}
      {data && (
        <>
          <fieldset
            disabled={locked || stale}
            className="space-y-3 rounded-lg border border-border-subtle p-4"
          >
            <legend className="px-1 font-semibold">1. Record returned stock</legend>
            <Label htmlFor="return-line">Sold line</Label>
            <select
              id="return-line"
              className={selectClass}
              value={lineId}
              onChange={(event) => {
                setLineId(event.target.value);
                setLotId('');
                setDisposition('QUARANTINE');
                setConfirmed(false);
              }}
            >
              <option value="">Choose a line</option>
              {data.lines.map((row) => (
                <option
                  key={row.id}
                  value={row.id}
                  disabled={row.returnedUnits === row.canonicalUnits}
                >
                  {row.name} · {row.quantity} {row.saleUnit === 'PACK' ? 'BOX' : row.saleUnit} ·{' '}
                  {row.canonicalUnits - row.returnedUnits} units returnable
                </option>
              ))}
            </select>
            <Label htmlFor="return-lot">Returned lot / batch</Label>
            <select
              id="return-lot"
              className={selectClass}
              value={lotId}
              onChange={(event) => {
                setLotId(event.target.value);
                setDisposition('QUARANTINE');
                setConfirmed(false);
              }}
            >
              <option value="">Lot cannot be verified — quarantine</option>
              {line?.lots.map((lot) => (
                <option key={lot.lotId} value={lot.lotId} disabled={lot.returnableUnits <= 0}>
                  {lot.batchNumber} · {lot.lotId} · {lot.returnableUnits} units remaining
                  {lot.restockAllowed ? '' : ' · quarantine only'}
                </option>
              ))}
            </select>
            {!lotId && (
              <p className="text-sm text-text-muted">
                Unidentified stock stays in quarantine with a pharmacist-verification task. No lot
                receives available stock.
              </p>
            )}
            <Label htmlFor="return-units">Return quantity (base units)</Label>
            <Input
              id="return-units"
              className="h-11"
              type="number"
              min="1"
              max={maximumUnits}
              step="1"
              value={units}
              onChange={(event) => {
                setUnits(event.target.value);
                setConfirmed(false);
              }}
            />
            {line && (
              <p className="text-sm text-text-muted">
                One sold {line.saleUnit === 'PACK' ? 'box' : line.saleUnit.toLowerCase()} contains{' '}
                {line.canonicalUnitsPerSaleUnit} base units.
              </p>
            )}
            <Label htmlFor="return-reason">Reason</Label>
            <select
              id="return-reason"
              className={selectClass}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setConfirmed(false);
              }}
            >
              <option value="WRONG_ITEM">Wrong item / strip</option>
              <option value="DAMAGED">Damaged</option>
              <option value="CUSTOMER_CHANGED_MIND">Customer changed mind</option>
              <option value="OTHER">Other — explain in inspection</option>
            </select>
            <Label htmlFor="return-disposition">Stock disposition</Label>
            <select
              id="return-disposition"
              className={selectClass}
              value={disposition}
              onChange={(event) => {
                setDisposition(event.target.value as typeof disposition);
                setConfirmed(false);
              }}
            >
              <option value="QUARANTINE">Quarantine for review</option>
              <option value="RESTOCK" disabled={!selectedLot?.restockAllowed}>
                Restock to verified lot and original shelf
              </option>
            </select>
            {disposition === 'QUARANTINE' && (
              <>
                <Label htmlFor="return-location">Quarantine location</Label>
                <select
                  id="return-location"
                  className={selectClass}
                  value={location}
                  onChange={(event) => {
                    setLocation(event.target.value);
                    setConfirmed(false);
                  }}
                >
                  <option value="">Choose location</option>
                  {data.locations.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </select>
                {data.locations.length === 0 && (
                  <p role="alert">
                    No quarantine location is configured for this branch. Ask a supervisor to
                    configure one.
                  </p>
                )}
              </>
            )}
            <Label htmlFor="return-integrity">Inspection and integrity decision</Label>
            <Input
              id="return-integrity"
              className="h-11"
              value={integrity}
              onChange={(event) => {
                setIntegrity(event.target.value);
                setConfirmed(false);
              }}
            />
            <p className="text-sm text-text-muted">
              Restock only inspected medicine with acceptable storage and intact packaging. Expired
              or recalled lots are refused by the server.
            </p>
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              I confirm the quantity, inspection and stock disposition.
            </label>
            <Button
              className="h-11"
              variant="destructive"
              disabled={
                !approvalReady ||
                !line ||
                !confirmed ||
                !integrity.trim() ||
                !Number.isSafeInteger(Number(units)) ||
                Number(units) < 1 ||
                Number(units) > maximumUnits ||
                (disposition === 'RESTOCK' && !selectedLot?.restockAllowed) ||
                (disposition === 'QUARANTINE' && !location)
              }
              onClick={() =>
                void execute({
                  kind: 'return',
                  saleId,
                  input: {
                    branchId,
                    saleLineId: lineId,
                    lotId: lotId || undefined,
                    canonicalUnits: Number(units),
                    disposition,
                    quarantineLocationId: disposition === 'QUARANTINE' ? location : undefined,
                    reason,
                    integrityDecision: integrity,
                    idempotencyKey: browserUuid(),
                  },
                })
              }
            >
              Record return
            </Button>
          </fieldset>
          <fieldset
            disabled={locked || stale}
            className="space-y-3 rounded-lg border border-border-subtle p-4"
          >
            <legend className="px-1 font-semibold">2. Refund original tender</legend>
            <p>Returned value awaiting refund: PKR {formatMinor(data.refundableMinor)}</p>
            <Label htmlFor="refund-tender">Original tender</Label>
            <select
              id="refund-tender"
              className={selectClass}
              value={tenderId}
              onChange={(event) => {
                setTenderId(event.target.value);
                setManual(false);
              }}
            >
              <option value="">Choose tender</option>
              {data.tenders.map((row) => (
                <option key={row.id} value={row.id} disabled={row.refundedMinor >= row.amountMinor}>
                  {row.type} · PKR {formatMinor(row.amountMinor - row.refundedMinor)} remaining
                </option>
              ))}
            </select>
            <Label htmlFor="refund-amount">Refund amount (PKR)</Label>
            <Input
              id="refund-amount"
              className="h-11"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <p className="text-sm text-text-muted">
              Refund up to PKR {formatMinor(available)} on this tender. Repeat with another original
              tender for a mixed payment. Loyalty refunds restore redeemed points.
            </p>
            {manualRequired && (
              <label className="flex min-h-11 items-start gap-2">
                <input
                  type="checkbox"
                  checked={manual}
                  onChange={(event) => setManual(event.target.checked)}
                />
                No provider refund adapter is configured. Issue CASH from this drawer; manual
                reversal required. I will reconcile the original provider separately.
              </label>
            )}
            <Button
              variant="destructive"
              className="h-11"
              disabled={
                !approvalReady ||
                !tender ||
                !Number.isSafeInteger(amountMinor) ||
                amountMinor <= 0 ||
                amountMinor > available ||
                (manualRequired && !manual)
              }
              onClick={() =>
                void execute({
                  kind: 'refund',
                  saleId,
                  input: {
                    branchId,
                    originalTenderId: tenderId,
                    amountMinor,
                    deviceId: deviceId(),
                    businessDate: businessDate().toISOString(),
                    reason,
                    idempotencyKey: browserUuid(),
                    manualCashFallback: manualRequired && manual,
                  },
                })
              }
            >
              Confirm refund
            </Button>
          </fieldset>
          <section aria-label="Return and refund history" className="space-y-2">
            <h3 className="font-semibold">Return and refund history</h3>
            {data.returns.length === 0 && <p>No returns recorded.</p>}
            {data.returns.map((row) => (
              <p key={row.id}>
                {row.reason}:{' '}
                {row.lines
                  .map((item) => `${item.canonicalUnits} units · ${item.integrityDecision}`)
                  .join(', ')}
              </p>
            ))}
            {data.tenders.flatMap((row) =>
              row.refunds.map((item) => (
                <p key={item.id}>
                  {row.type} refund: PKR {formatMinor(item.amountMinor)}
                  {item.manualReversalRequired ? ' · CASH — manual reversal required' : ''}
                </p>
              ))
            )}
            <Button
              variant="outline"
              className="h-11"
              disabled={
                busy ||
                !online ||
                !!attempt ||
                stale ||
                !receipt.data ||
                receipt.isFetching ||
                receipt.isError
              }
              onClick={print}
            >
              Reprint receipt with refunds
            </Button>
            {receipt.isError && (
              <Button variant="outline" onClick={() => void receipt.refetch()}>
                Reload receipt
              </Button>
            )}
          </section>
        </>
      )}
    </div>
  );
}
