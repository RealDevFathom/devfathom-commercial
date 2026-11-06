'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState, useSyncExternalStore } from 'react';
import { z } from '@/lib/zod-csp';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { trpc } from '@/lib/trpc';
import { browserUuid } from '@/lib/browser-uuid';
import { useCounterError } from '@/i18n/use-counter-error';
import {
  formatMinor,
  formatCounterTime,
  localizeReceiptDigits,
} from '@/lib/pharmacy/counter-receipt';
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
/** Transient witness credential. Never persisted with the saved attempt. */
type ControlledWitness = { staffProfileId: string; pin: string };
const witnessPinPattern = /^\d{4,8}$/;

export function isBlockedResult(result: unknown): result is { blocked: string } {
  return (
    typeof result === 'object' &&
    result !== null &&
    'blocked' in result &&
    typeof (result as { blocked: unknown }).blocked === 'string'
  );
}
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
  const ct = useTranslations('CounterText');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" className="h-11" onClick={() => setOpen(true)}>
        {ct('returnsRefunds')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogTitle>{ct('returnsRefunds')}</DialogTitle>
          <DialogDescription>
            {ct('findTheOriginalReceiptRecordReturnedStockThenRefund')}
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
  const ct = useTranslations('CounterText');
  const locale = useLocale() === 'ur' ? 'ur' : 'en';
  const counterErrorMessage = useCounterError();
  const reasonLabel = (value: string) => {
    const names: Record<string, string> = {
      WRONG_ITEM: 'wrongItemStrip',
      DAMAGED: 'damaged',
      CUSTOMER_CHANGED_MIND: 'customerChangedMind',
      OTHER: 'otherExplainInInspection',
    };
    return Object.hasOwn(names, value) ? ct(names[value]!) : value;
  };
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
        error: ct('returnRecoveryUnavailable'),
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
  const [witnessStaffId, setWitnessStaffId] = useState('');
  const [witnessPin, setWitnessPin] = useState('');
  const [busy, setBusy] = useState(false);
  const latch = useRef(false);
  const [message, setMessage] = useState(recovery.attempt ? ct('returnEarlierAttempt') : '');
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
  // A saved return keeps its own line; a fresh one uses the selected line.
  const witnessLineId = attempt?.kind === 'return' ? attempt.input.saleLineId : lineId;
  const witnessRequired = !!data?.lines.find((row) => row.id === witnessLineId)?.controlled;
  const pharmacists = trpc.pharmacySafety.controlledPharmacists.useQuery(undefined, {
    enabled: ready && online && witnessRequired,
    retry: false,
  });
  const witnessReady = !witnessRequired || (!!witnessStaffId && witnessPinPattern.test(witnessPin));
  const witness: ControlledWitness | undefined =
    witnessRequired && witnessReady
      ? { staffProfileId: witnessStaffId, pin: witnessPin }
      : undefined;
  const manualRequired = tender?.type === 'CARD' || tender?.type === 'WALLET';
  const amountMinor = /^\d+(\.\d{1,2})?$/.test(amount) ? Math.round(Number(amount) * 100) : 0;
  const available = Math.min(
    data?.refundableMinor ?? 0,
    tender ? tender.amountMinor - tender.refundedMinor : 0
  );
  const locked = busy || !!attempt || !ready || !online;
  const stale = history.isFetching || history.isError;

  async function execute(next: Attempt, controlledWitness?: ControlledWitness) {
    if (latch.current || !online || !ready) return;
    latch.current = true;
    const retry = !!attempt;
    setBusy(true);
    setError('');
    setMessage('');
    // A witness PIN is single-use: clear it whatever the outcome.
    setWitnessPin('');
    try {
      // Write before sending; an ambiguous network outcome can only replay this exact request.
      // The witness PIN is deliberately excluded from persistent storage.
      localStorage.setItem(storageKey, JSON.stringify(next));
      setAttempt(next);
      if (next.kind === 'return') {
        const result = await returnLine.mutateAsync(
          controlledWitness ? { ...next.input, controlledWitness } : next.input
        );
        if (isBlockedResult(result)) {
          // The server refused before any stock change. A fresh attempt is definitely not
          // recorded; a retried attempt keeps its saved reference so an earlier ambiguous
          // outcome can still be reconciled with the same idempotency key.
          if (!retry) {
            try {
              localStorage.removeItem(storageKey);
              setAttempt(null);
            } catch {
              /* Keep recovery locked. */
            }
          }
          setError(
            ct('returnNotRecordedValue0Value1', {
              value0: result.blocked,
              value1: retry ? ct('returnWitnessRetry') : '',
            })
          );
          return;
        }
      } else
        await refund.mutateAsync({
          ...next.input,
          businessDate: new Date(next.input.businessDate),
        });
      await history.refetch({ throwOnError: true });
      localStorage.removeItem(storageKey);
      setAttempt(null);
      setConfirmed(false);
      setUnits('1');
      setAmount('');
      setMessage(
        next.kind === 'return' ? ct('returnRecordedChooseTender') : ct('refundRecordedReprint')
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
        ct('value0CheckHistoryBeforeHandingOutCashAnUnknown', {
          value0: counterErrorMessage(cause),
        })
      );
    } finally {
      latch.current = false;
      setBusy(false);
    }
  }

  const witnessFields = (
    <section
      aria-label={ct('controlledMedicineReturnWitness')}
      className="space-y-3 rounded-md border border-border-subtle p-3"
    >
      <p className="text-sm text-text-muted">
        {ct('controlledMedicineADifferentPharmacistMustWitnessThisReturn')}
      </p>
      <Label htmlFor="return-witness">{ct('witnessingPharmacist')}</Label>
      <select
        id="return-witness"
        className={selectClass}
        disabled={busy || !online || !ready || pharmacists.isLoading || pharmacists.isError}
        value={witnessStaffId}
        onChange={(event) => {
          setWitnessStaffId(event.target.value);
          setWitnessPin('');
        }}
      >
        <option value="">{ct('selectPharmacist')}</option>
        {pharmacists.data?.map((staff) => (
          <option key={staff.id} value={staff.id}>
            {staff.name}
          </option>
        ))}
      </select>
      {pharmacists.isLoading ? (
        <p role="status">{ct('loadingPharmacists')}</p>
      ) : pharmacists.isError ? (
        <p role="alert">
          {counterErrorMessage(pharmacists.error)}{' '}
          <Button variant="outline" onClick={() => void pharmacists.refetch()}>
            {ct('reloadPharmacists')}
          </Button>
        </p>
      ) : pharmacists.data && pharmacists.data.length === 0 ? (
        <p role="status">{ct('noIndependentPharmacistWithAnActiveStaffPINIs')}</p>
      ) : null}
      <Label htmlFor="return-witness-pin">{ct('witnessPIN')}</Label>
      <Input
        id="return-witness-pin"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={8}
        className="h-11"
        disabled={busy || !online || !ready || !witnessStaffId}
        value={witnessPin}
        onChange={(event) => setWitnessPin(event.target.value.replace(/\D/g, ''))}
      />
    </section>
  );

  function print() {
    try {
      if (!receipt.data || !data || stale || receipt.isFetching || receipt.isError)
        throw new Error(ct('reloadReceiptBeforePrinting'));
      const popup = window.open('', '_blank', 'popup,width=480,height=720');
      if (!popup) throw new Error(ct('allowPopUpsForReceipt'));
      popup.opener = null;
      popup.document.open();
      popup.document.write(buildCounterBrowserReceipt(receipt.data, locale, 'THERMAL', true));
      popup.document.close();
      const appendix = popup.document.createElement('pre');
      appendix.textContent =
        '\n' +
        ct('returnPrintHeading') +
        '\n' +
        data.returns
          .map(
            (row) =>
              `${formatCounterTime(row.createdAt, locale)} ${reasonLabel(row.reason)}\n${row.lines.map((item) => ct('returnPrintLine', { name: data.lines.find((l) => l.id === item.saleLineId)?.name ?? ct('returnItemFallback'), units: localizeReceiptDigits(item.canonicalUnits, locale), decision: item.integrityDecision })).join('\n')}`
          )
          .join('\n') +
        '\n' +
        data.tenders
          .flatMap((row) =>
            row.refunds.map(
              (item) =>
                `${ct(`tenderCodes.${row.type}`)}: PKR ${formatMinor(item.amountMinor, locale)} · ${item.reason}`
            )
          )
          .join('\n');
      popup.document.body.append(appendix);
      popup.focus();
      popup.print();
      setMessage(ct('returnPrintRequested'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : ct('receiptCouldNotPrint'));
    }
  }

  return (
    <div className="space-y-4">
      {!online && <p role="alert">{ct('offlineReturnsAndRefundsRequireAConnection')}</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {counterErrorMessage(new Error(error))}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {attempt && (
        <Button
          className="h-11"
          onClick={() => void execute(attempt, witness)}
          disabled={
            busy ||
            !online ||
            !ready ||
            // A saved return waits for its line details so a controlled line gets a witness.
            (attempt.kind === 'return' && (!data || !witnessReady))
          }
        >
          {ct('retrySaved')}
          {ct(`returnActions.${attempt.kind}`)}
        </Button>
      )}
      {attempt?.kind === 'return' && witnessRequired && witnessFields}
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
          <Label htmlFor="return-receipt">{ct('receiptNumber')}</Label>
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
          {ct('findReceipt')}
        </Button>
      </form>
      {lookup.isFetching && searched > 0 && <p role="status">{ct('lookingUpReceipt')}</p>}
      {lookup.isError && (
        <p role="alert">
          {counterErrorMessage(lookup.error)}{' '}
          <Button variant="outline" onClick={() => void lookup.refetch()}>
            {ct('retryLookup')}
          </Button>
        </p>
      )}
      {searched > 0 && lookup.isSuccess && lookup.data.length === 0 && (
        <p>{ct('noSettledReceiptFoundInThisBranch')}</p>
      )}
      {!!lookup.data?.length && (
        <div className="space-y-2">
          <p>{ct('chooseTheMatchingDateAndCounterReceiptNumbersCan')}</p>
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
              {ct('receipt2')}
              {row.receiptNumber} · {row.businessDate?.toISOString().slice(0, 10)} ·{' '}
              {row.receiptDeviceId}
            </Button>
          ))}
        </div>
      )}
      {saleId && history.isFetching && <p role="status">{ct('loadingReturnHistory')}</p>}
      {saleId && history.isError && (
        <p role="alert">
          {counterErrorMessage(history.error)}{' '}
          <Button variant="outline" onClick={() => void history.refetch()}>
            {ct('reloadHistory')}
          </Button>
        </p>
      )}
      {data && (
        <>
          <fieldset
            disabled={locked || stale}
            className="space-y-3 rounded-lg border border-border-subtle p-4"
          >
            <legend className="px-1 font-semibold">{ct('1RecordReturnedStock')}</legend>
            <Label htmlFor="return-line">{ct('soldLine')}</Label>
            <select
              id="return-line"
              className={selectClass}
              value={lineId}
              onChange={(event) => {
                setLineId(event.target.value);
                setWitnessStaffId('');
                setWitnessPin('');
                setLotId('');
                setDisposition('QUARANTINE');
                setConfirmed(false);
              }}
            >
              <option value="">{ct('chooseALine')}</option>
              {data.lines.map((row) => (
                <option
                  key={row.id}
                  value={row.id}
                  disabled={row.returnedUnits === row.canonicalUnits}
                >
                  {row.name} · {row.quantity} {ct(`returnSaleUnits.${row.saleUnit}`)} ·{' '}
                  {row.canonicalUnits - row.returnedUnits} {ct('unitsReturnable')}
                </option>
              ))}
            </select>
            <Label htmlFor="return-lot">{ct('returnedLotBatch')}</Label>
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
              <option value="">{ct('lotCannotBeVerifiedQuarantine')}</option>
              {line?.lots.map((lot) => (
                <option key={lot.lotId} value={lot.lotId} disabled={lot.returnableUnits <= 0}>
                  {lot.batchNumber} · {lot.lotId} · {lot.returnableUnits} {ct('unitsRemaining')}
                  {lot.restockAllowed ? '' : ct('quarantineOnly')}
                </option>
              ))}
            </select>
            {!lotId && (
              <p className="text-sm text-text-muted">
                {ct('unidentifiedStockStaysInQuarantineWithAPharmacistVerification')}
              </p>
            )}
            <Label htmlFor="return-units">{ct('returnQuantityBaseUnits')}</Label>
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
                {ct('oneSold')}
                {ct(`returnSaleUnits.${line.saleUnit}`)} {ct('contains')}{' '}
                {line.canonicalUnitsPerSaleUnit} {ct('baseUnits')}
              </p>
            )}
            <Label htmlFor="return-reason">{ct('reason')}</Label>
            <select
              id="return-reason"
              className={selectClass}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setConfirmed(false);
              }}
            >
              <option value="WRONG_ITEM">{ct('wrongItemStrip')}</option>
              <option value="DAMAGED">{ct('damaged')}</option>
              <option value="CUSTOMER_CHANGED_MIND">{ct('customerChangedMind')}</option>
              <option value="OTHER">{ct('otherExplainInInspection')}</option>
            </select>
            <Label htmlFor="return-disposition">{ct('stockDisposition')}</Label>
            <select
              id="return-disposition"
              className={selectClass}
              value={disposition}
              onChange={(event) => {
                setDisposition(event.target.value as typeof disposition);
                setConfirmed(false);
              }}
            >
              <option value="QUARANTINE">{ct('quarantineForReview')}</option>
              <option value="RESTOCK" disabled={!selectedLot?.restockAllowed}>
                {ct('restockToVerifiedLotAndOriginalShelf')}
              </option>
            </select>
            {disposition === 'QUARANTINE' && (
              <>
                <Label htmlFor="return-location">{ct('quarantineLocation')}</Label>
                <select
                  id="return-location"
                  className={selectClass}
                  value={location}
                  onChange={(event) => {
                    setLocation(event.target.value);
                    setConfirmed(false);
                  }}
                >
                  <option value="">{ct('chooseLocation')}</option>
                  {data.locations.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </select>
                {data.locations.length === 0 && (
                  <p role="alert">{ct('noQuarantineLocationIsConfiguredForThisBranchAsk')}</p>
                )}
              </>
            )}
            <Label htmlFor="return-integrity">{ct('inspectionAndIntegrityDecision')}</Label>
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
              {ct('restockOnlyInspectedMedicineWithAcceptableStorageAndIntact')}
            </p>
            {!attempt && witnessRequired && witnessFields}
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              {ct('iConfirmTheQuantityInspectionAndStockDisposition')}
            </label>
            <Button
              className="h-11"
              variant="destructive"
              disabled={
                !line ||
                !confirmed ||
                !integrity.trim() ||
                !Number.isSafeInteger(Number(units)) ||
                Number(units) < 1 ||
                Number(units) > maximumUnits ||
                (disposition === 'RESTOCK' && !selectedLot?.restockAllowed) ||
                (disposition === 'QUARANTINE' && !location) ||
                !witnessReady
              }
              onClick={() =>
                void execute(
                  {
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
                  },
                  witness
                )
              }
            >
              {ct('recordReturn')}
            </Button>
          </fieldset>
          <fieldset
            disabled={locked || stale}
            className="space-y-3 rounded-lg border border-border-subtle p-4"
          >
            <legend className="px-1 font-semibold">{ct('2RefundOriginalTender')}</legend>
            <p>
              {ct('returnedValueAwaitingRefundPKR')}
              {formatMinor(data.refundableMinor)}
            </p>
            <Label htmlFor="refund-tender">{ct('originalTender')}</Label>
            <select
              id="refund-tender"
              className={selectClass}
              value={tenderId}
              onChange={(event) => {
                setTenderId(event.target.value);
                setManual(false);
              }}
            >
              <option value="">{ct('chooseTender')}</option>
              {data.tenders.map((row) => (
                <option key={row.id} value={row.id} disabled={row.refundedMinor >= row.amountMinor}>
                  {ct(`tenderCodes.${row.type}`)} {ct('pkr')}
                  {formatMinor(row.amountMinor - row.refundedMinor, locale)} {ct('remaining')}
                </option>
              ))}
            </select>
            <Label htmlFor="refund-amount">{ct('refundAmountPKR')}</Label>
            <Input
              id="refund-amount"
              className="h-11"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <p className="text-sm text-text-muted">
              {ct('refundUpToPKR')}
              {formatMinor(available)} {ct('onThisTenderRepeatWithAnotherOriginalTenderFor')}
            </p>
            {manualRequired && (
              <label className="flex min-h-11 items-start gap-2">
                <input
                  type="checkbox"
                  checked={manual}
                  onChange={(event) => setManual(event.target.checked)}
                />
                {ct('noProviderRefundAdapterIsConfiguredIssueCASHFrom')}
              </label>
            )}
            <Button
              variant="destructive"
              className="h-11"
              disabled={
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
              {ct('confirmRefund')}
            </Button>
          </fieldset>
          <section aria-label={ct('returnAndRefundHistory')} className="space-y-2">
            <h3 className="font-semibold">{ct('returnAndRefundHistory')}</h3>
            {data.returns.length === 0 && <p>{ct('noReturnsRecorded')}</p>}
            {data.returns.map((row) => (
              <p key={row.id}>
                {reasonLabel(row.reason)}:{' '}
                {row.lines
                  .map((item) =>
                    ct('value0UnitsValue1', {
                      value0: item.canonicalUnits,
                      value1: item.integrityDecision,
                    })
                  )
                  .join(', ')}
              </p>
            ))}
            {data.tenders.flatMap((row) =>
              row.refunds.map((item) => (
                <p key={item.id}>
                  {ct(`tenderCodes.${row.type}`)} {ct('refundPKR')}
                  {formatMinor(item.amountMinor, locale)}
                  {item.manualReversalRequired ? ct('cashManualReversalRequired') : ''}
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
              {ct('reprintReceiptWithRefunds')}
            </Button>
            {receipt.isError && (
              <Button variant="outline" onClick={() => void receipt.refetch()}>
                {ct('reloadReceipt')}
              </Button>
            )}
          </section>
        </>
      )}
    </div>
  );
}
