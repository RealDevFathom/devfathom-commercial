'use client';

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
import { formatLotExpiry } from '@/lib/pharmacy/product-class';
import {
  formatSoldQuantity,
  soldUnitNoun,
  soldUnitPluralNoun,
} from '@/lib/pharmacy/stock-breakdown';
import { buildCounterBrowserReceipt } from '@/lib/pharmacy/counter-browser-print';
import { batchPhrase } from '@/lib/pharmacy/unrecorded-batch';

const returnInputSchema = z.object({
  branchId: z.string(),
  saleLineId: z.string(),
  lotId: z.string().optional(),
  canonicalUnits: z.number().int().positive(),
  disposition: z.enum(['RESTOCK', 'QUARANTINE']),
  quarantineLocationId: z.string().optional(),
  reason: z.string(),
  integrityDecision: z.string(),
  idempotencyKey: z.string(),
});
const attemptSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('return'),
    saleId: z.string(),
    input: returnInputSchema,
  }),
  // DEV-501: one confirm records the return and refunds it in a single server transaction.
  z.object({
    kind: z.literal('returnRefund'),
    saleId: z.string(),
    input: returnInputSchema.extend({
      refund: z.object({
        originalTenderId: z.string(),
        deviceId: z.string(),
        businessDate: z.string(),
        // Omitted: the server refunds this return's exact value.
        amountMinor: z.number().int().positive().optional(),
        manualCashFallback: z.boolean(),
      }),
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
const PREPAID_REFUND_NOTE =
  'This refund goes back to the customer’s prepaid balance. Do not give cash.';
const attemptLabel: Record<Attempt['kind'], string> = {
  return: 'return',
  returnRefund: 'return and refund',
  refund: 'refund',
};
/** Transient witness credential. Never persisted with the saved attempt. */
type ControlledWitness = { staffProfileId: string; pin: string };
const witnessPinPattern = /^\d{4,8}$/;

/**
 * Reads a typed receipt reference. Accepts the printed forms ("1042", "Receipt 1042",
 * "QA-1042", "receipt:1042") and returns the trailing receipt sequence, or null.
 */
export function parseReceiptNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 :#-]*$/.test(trimmed)) return null;
  const digits = /(\d+)$/.exec(trimmed)?.[1];
  const parsed = digits ? Number(digits) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function isBlockedResult(result: unknown): result is { blocked: string } {
  return (
    typeof result === 'object' &&
    result !== null &&
    'blocked' in result &&
    typeof (result as { blocked: unknown }).blocked === 'string'
  );
}
/** Parses a whole, non-negative count typed at the counter; blank reads as zero. */
function wholeCount(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
}

const REASONS = [
  ['WRONG_ITEM', 'Wrong item / strip'],
  ['DAMAGED', 'Damaged'],
  ['CUSTOMER_CHANGED_MIND', 'Customer changed mind'],
  ['OTHER', 'Other — explain in inspection'],
] as const;

type Props = {
  branchId: string;
  organizationId: string;
  accountId: string;
  deviceId: () => string;
  businessDate: () => Date;
  /** DEV-647: managers and owners only. The server enforces the same rule. */
  refundAuthorized?: boolean;
};
const selectClass =
  'h-11 w-full rounded-md border border-input bg-surface-card px-3 text-text-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50';

/** Explicit, mutually exclusive choices using the shared touch-sized controls. */
function ChoiceGroup<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  confirmation,
}: {
  id: string;
  label: string;
  value: T | '';
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>;
  onChange: (value: T) => void;
  confirmation?: string;
}) {
  return (
    <div role="group" aria-labelledby={id} className="space-y-2">
      <p id={id} className="text-sm font-medium text-text-strong">
        {label}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <Button
            key={option.value}
            type="button"
            variant={value === option.value ? 'default' : 'outline'}
            className="h-auto min-h-11 w-full flex-col gap-1 whitespace-normal py-3"
            aria-label={confirmation ? `${option.label} — ${confirmation}` : undefined}
            aria-pressed={value === option.value}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
          >
            <span>{option.label}</span>
            {confirmation && <span className="text-xs font-normal">{confirmation}</span>}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function CounterReturnPanel(props: Omit<Props, 'refundAuthorized'>) {
  const [open, setOpen] = useState(false);
  // DEV-647 / DEV-621: returns and refunds stay with managers and owners.
  const access = trpc.pharmacySales.refundAccess.useQuery(undefined, { retry: false });
  const refundAuthorized = access.data?.authorized === true;
  const title = refundAuthorized ? 'Returns & refunds' : 'Returns';
  return (
    <>
      <Button variant="outline" className="h-11" onClick={() => setOpen(true)}>
        {title}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="pharmacy-workspace [&_[data-slot=dialog-close]]:min-h-11 [&_[data-slot=dialog-close]]:min-w-11 max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {refundAuthorized
              ? 'Scan or find the receipt, choose the returned line, then confirm the return and its refund together.'
              : 'Find the original receipt. A manager or owner records returns and refunds with their PIN.'}
          </DialogDescription>
          {open && (
            <ReturnForm
              key={`${props.organizationId}:${props.accountId}:${props.branchId}`}
              {...props}
              refundAuthorized={refundAuthorized}
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

export function ReturnForm({
  branchId,
  organizationId,
  accountId,
  deviceId,
  businessDate,
  refundAuthorized = false,
}: Props) {
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
  const [searched, setSearched] = useState<{ value: number | null } | null>(null);
  const [editedSinceSearch, setEditedSinceSearch] = useState(false);
  const [chosenSaleId, setSaleId] = useState(recovery.attempt?.saleId ?? '');
  const [chosenLineId, setLineId] = useState('');
  const [lotId, setLotId] = useState('');
  // DEV-501: quantity is typed in the unit the line was sold in, plus any loose units.
  // null keeps the default for the selected line and lot.
  const [quantity, setQuantity] = useState<{ sold: string; loose: string } | null>(null);
  const [reason, setReason] = useState('');
  // Keep the existing later-refund reason independent of fresh return choices.
  const [refundReason, setRefundReason] = useState('');
  const [disposition, setDisposition] = useState<'' | 'RESTOCK' | 'QUARANTINE'>('');
  const [chosenLocation, setLocation] = useState('');
  const [integrity, setIntegrity] = useState('');
  // The tender refunded with the return: '' (choose), 'none' (record only) or a tender id.
  const [chosenReturnTender, setReturnTender] = useState('');
  const [returnAmount, setReturnAmount] = useState<string | null>(null);
  const [returnManual, setReturnManual] = useState(false);
  const [tenderId, setTenderId] = useState('');
  const [amount, setAmount] = useState('');
  const [manual, setManual] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(recovery.attempt);
  const [witnessStaffId, setWitnessStaffId] = useState('');
  const [witnessPin, setWitnessPin] = useState('');
  const [managerPin, setManagerPin] = useState('');
  const [busy, setBusy] = useState(false);
  const latch = useRef(false);
  const [message, setMessage] = useState(
    recovery.attempt
      ? 'An earlier attempt needs reconciliation. Retry the saved attempt with the same reference.'
      : ''
  );
  const [error, setError] = useState(recovery.error);
  const lookup = trpc.pharmacySales.lookupReceiptByNumber.useQuery(
    { branchId, receiptNumber: searched?.value ?? 1 },
    { enabled: ready && online && !!searched?.value, retry: false }
  );
  // A reference with no receipt sequence (for example QA-0000) cannot match any receipt.
  const unparsed = !!searched && searched.value === null;
  const showInvalid = unparsed && !editedSinceSearch;
  // DEV-501: a scan or search with exactly one match in this branch opens that receipt.
  const onlyMatch =
    !unparsed && !!searched?.value && lookup.data?.length === 1 ? lookup.data[0] : undefined;
  const saleId = chosenSaleId || (onlyMatch?.branchId === branchId ? onlyMatch.id : '');
  const history = trpc.pharmacySales.returnHistory.useQuery(
    { branchId, saleId },
    { enabled: ready && online && !!saleId, retry: false }
  );
  const receipt = trpc.pharmacySales.counterReceipt.useQuery(
    { branchId, saleId },
    { enabled: ready && online && !!saleId, retry: false }
  );
  const returnLine = trpc.pharmacySales.returnLine.useMutation();
  const returnAndRefund = trpc.pharmacySales.returnAndRefund.useMutation();
  const refund = trpc.pharmacySales.refundTender.useMutation();
  const data = history.data;
  const returnable = data?.lines.filter((row) => row.returnedUnits < row.canonicalUnits) ?? [];
  // A receipt with one returnable line selects it.
  const lineId = chosenLineId || (returnable.length === 1 ? returnable[0].id : '');
  const line = data?.lines.find((row) => row.id === lineId);
  const selectedLot = line?.lots.find((row) => row.lotId === lotId);
  const maximumUnits =
    selectedLot?.returnableUnits ?? (line ? line.canonicalUnits - line.returnedUnits : 0);
  const perSold = line && line.canonicalUnitsPerSaleUnit > 1 ? line.canonicalUnitsPerSaleUnit : 1;
  const soldNoun = line ? soldUnitNoun(line.saleUnit, line.levelLabel) : 'unit';
  const soldPlural = line ? soldUnitPluralNoun(line.saleUnit, line.levelLabel) : 'units';
  // Default: one sold unit, or every returnable loose unit when less than one remains.
  const quantityInput = quantity ?? {
    sold: perSold > 1 && maximumUnits < perSold ? '0' : '1',
    loose: perSold > 1 && maximumUnits < perSold ? String(Math.max(0, maximumUnits)) : '0',
  };
  const units =
    wholeCount(quantityInput.sold) * perSold + (perSold > 1 ? wholeCount(quantityInput.loose) : 0);
  const unitsValid = Number.isSafeInteger(units) && units >= 1 && units <= maximumUnits;
  const location = chosenLocation || (data?.locations.length === 1 ? data.locations[0].id : '');
  const reasonLabel = REASONS.find(([value]) => value === reason)?.[1] ?? reason;
  const integrityDecision = integrity.trim() || `Inspected at the counter: ${reasonLabel}`;
  const refundableTenders =
    data?.tenders.filter((row) => row.refundedMinor < row.amountMinor) ?? [];
  // A sale paid with one tender refunds to it.
  const returnTenderId =
    chosenReturnTender || (refundableTenders.length === 1 ? refundableTenders[0].id : '');
  const returnTender = data?.tenders.find((row) => row.id === returnTenderId);
  const refundNow = !!returnTender;
  // The server prices the proposed return exactly as it will snapshot it, from the selected
  // lot's own allocation prices, so the confirmed refund is the refund recorded.
  const quote = trpc.pharmacySales.returnQuote.useQuery(
    { branchId, saleLineId: lineId, lotId: lotId || undefined, canonicalUnits: units },
    {
      enabled: ready && online && refundAuthorized && refundNow && !!line && unitsValid,
      retry: false,
    }
  );
  const quoted =
    refundNow && line && unitsValid && quote.isSuccess && !quote.isFetching
      ? quote.data.valueMinor
      : undefined;
  const returnValueMinor = quoted ?? 0;
  const returnTenderRemaining = returnTender
    ? returnTender.amountMinor - returnTender.refundedMinor
    : 0;
  // The refund is prefilled from the returned quantity and bounded by it and the tender.
  const returnRefundMax = Math.min(returnValueMinor, returnTenderRemaining);
  const returnAmountMinor =
    returnAmount === null
      ? returnRefundMax
      : /^\d+(\.\d{1,2})?$/.test(returnAmount.trim())
        ? Math.round(Number(returnAmount.trim()) * 100)
        : 0;
  // DEV-863: a prepaid wallet refund goes back to the customer's prepaid balance, never as cash.
  const returnManualRequired =
    !returnTender?.prepaid && (returnTender?.type === 'CARD' || returnTender?.type === 'WALLET');
  const tender = data?.tenders.find((row) => row.id === tenderId);
  // A saved return keeps its own line; a fresh one uses the selected line.
  const witnessLineId = attempt && attempt.kind !== 'refund' ? attempt.input.saleLineId : lineId;
  // DEV-911: no pharmacist witness is asked for while the owner has the check switched off.
  const pharmacistCheckOff =
    (data as { pharmacistCheckOff?: boolean } | undefined)?.pharmacistCheckOff === true;
  const witnessRequired =
    !pharmacistCheckOff && !!data?.lines.find((row) => row.id === witnessLineId)?.controlled;
  const pharmacists = trpc.pharmacySafety.controlledPharmacists.useQuery(undefined, {
    enabled: ready && online && witnessRequired,
    retry: false,
  });
  const witnessReady = !witnessRequired || (!!witnessStaffId && witnessPinPattern.test(witnessPin));
  const witness: ControlledWitness | undefined =
    witnessRequired && witnessReady
      ? { staffProfileId: witnessStaffId, pin: witnessPin }
      : undefined;
  const manualRequired = !tender?.prepaid && (tender?.type === 'CARD' || tender?.type === 'WALLET');
  const amountMinor = /^\d+(\.\d{1,2})?$/.test(amount) ? Math.round(Number(amount) * 100) : 0;
  const available = Math.min(
    data?.refundableMinor ?? 0,
    tender ? tender.amountMinor - tender.refundedMinor : 0
  );
  const locked = busy || !!attempt || !ready || !online;
  const stale = history.isFetching || history.isError;

  const managerPinReady = witnessPinPattern.test(managerPin);
  const returnReady =
    !!line &&
    !!reason &&
    unitsValid &&
    witnessReady &&
    managerPinReady &&
    (returnTenderId === 'none' ||
      (refundNow &&
        quoted !== undefined &&
        Number.isSafeInteger(returnAmountMinor) &&
        returnAmountMinor > 0 &&
        returnAmountMinor <= returnRefundMax &&
        !(returnManualRequired && !returnManual)));

  function canConfirmReturn(choice: 'RESTOCK' | 'QUARANTINE') {
    return (
      returnReady &&
      !locked &&
      !stale &&
      refundAuthorized &&
      (choice === 'RESTOCK' ? !!selectedLot?.restockAllowed : !!location)
    );
  }

  function resetReturn() {
    setLineId('');
    setLotId('');
    setQuantity(null);
    setReason('');
    setRefundReason('');
    setDisposition('');
    setIntegrity('');
    setReturnTender('');
    setReturnAmount(null);
    setReturnManual(false);
  }

  async function execute(next: Attempt, controlledWitness?: ControlledWitness, pin?: string) {
    if (latch.current || !online || !ready) return;
    latch.current = true;
    const retry = !!attempt;
    setBusy(true);
    setError('');
    setMessage('');
    // Witness and manager PINs are single-use: clear them whatever the outcome.
    setWitnessPin('');
    setManagerPin('');
    try {
      // Write before sending; an ambiguous network outcome can only replay this exact request.
      // The witness PIN is deliberately excluded from persistent storage.
      localStorage.setItem(storageKey, JSON.stringify(next));
      setAttempt(next);
      let refundedMinor: number | undefined;
      if (next.kind !== 'refund') {
        // DEV-621: the manager PIN is sent with the request only, never saved with the attempt.
        const result =
          next.kind === 'return'
            ? await returnLine.mutateAsync({
                ...next.input,
                ...(controlledWitness ? { controlledWitness } : {}),
                managerPin: pin ?? '',
              })
            : await returnAndRefund.mutateAsync({
                ...next.input,
                refund: {
                  ...next.input.refund,
                  businessDate: new Date(next.input.refund.businessDate),
                },
                ...(controlledWitness ? { controlledWitness } : {}),
                managerPin: pin ?? '',
              });
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
            `Return not recorded. ${result.blocked}${retry ? ' Enter a fresh witness PIN and retry the saved return.' : ''}`
          );
          return;
        }
        const refunded = (result as { refund?: { amountMinor?: unknown } } | undefined)?.refund
          ?.amountMinor;
        if (typeof refunded === 'number') refundedMinor = refunded;
      } else {
        // The manager PIN is sent with the request only, never saved with the attempt.
        const result = await refund.mutateAsync({
          ...next.input,
          businessDate: new Date(next.input.businessDate),
          managerPin: pin ?? '',
        });
        if (isBlockedResult(result)) {
          // Refused before any money moved. Keep a retried attempt for reconciliation.
          if (!retry) {
            try {
              localStorage.removeItem(storageKey);
              setAttempt(null);
            } catch {
              /* Keep recovery locked. */
            }
          }
          setError(`${result.blocked}${retry ? ' Then retry the saved refund.' : ''}`);
          return;
        }
      }
      await history.refetch({ throwOnError: true });
      localStorage.removeItem(storageKey);
      setAttempt(null);
      resetReturn();
      setAmount('');
      setMessage(
        next.kind === 'return'
          ? 'Return recorded. Enter your PIN again and choose an original tender to refund.'
          : next.kind === 'returnRefund'
            ? `Return recorded and refunded${refundedMinor === undefined ? '' : `: PKR ${formatMinor(refundedMinor)}`}. Loyalty tender refunds restore redeemed points. Reprint the receipt below.`
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

  function confirmReturn(choice: 'RESTOCK' | 'QUARANTINE') {
    if (!canConfirmReturn(choice) || !line || !reason) return;
    // The clicked outcome is the explicit confirmation; there is no default submit.
    setDisposition(choice);
    const input = {
      branchId,
      saleLineId: line.id,
      lotId: lotId || undefined,
      canonicalUnits: units,
      disposition: choice,
      quarantineLocationId: choice === 'QUARANTINE' ? location : undefined,
      reason,
      integrityDecision,
      idempotencyKey: browserUuid(),
    };
    void execute(
      returnTenderId === 'none'
        ? { kind: 'return', saleId, input }
        : {
            kind: 'returnRefund',
            saleId,
            input: {
              ...input,
              refund: {
                originalTenderId: returnTenderId,
                deviceId: deviceId(),
                businessDate: businessDate().toISOString(),
                // The untouched prefill refunds the return's exact server-side value.
                amountMinor:
                  returnAmount === null && returnValueMinor <= returnTenderRemaining
                    ? undefined
                    : returnAmountMinor,
                manualCashFallback: returnManualRequired && returnManual,
              },
            },
          },
      witness,
      managerPin
    );
  }

  const witnessFields = (
    <section
      aria-label="Controlled medicine return witness"
      className="space-y-3 rounded-md border border-border-subtle p-3"
    >
      <p className="text-sm text-text-muted">
        Controlled medicine. A different pharmacist must witness this return with a fresh PIN. The
        PIN is never saved on this device.
      </p>
      <Label htmlFor="return-witness">Witnessing pharmacist</Label>
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
        <option value="">Select pharmacist</option>
        {pharmacists.data?.map((staff) => (
          <option key={staff.id} value={staff.id}>
            {staff.name}
          </option>
        ))}
      </select>
      {pharmacists.isLoading ? (
        <p role="status">Loading pharmacists…</p>
      ) : pharmacists.isError ? (
        <p role="alert">
          {counterErrorMessage(pharmacists.error)}{' '}
          <Button
            size="touch"
            type="button"
            variant="outline"
            onClick={() => void pharmacists.refetch()}
          >
            Reload pharmacists
          </Button>
        </p>
      ) : pharmacists.data && pharmacists.data.length === 0 ? (
        <p role="status">
          No independent pharmacist with an active staff PIN is available. Ask your administrator to
          configure one.
        </p>
      ) : null}
      <Label htmlFor="return-witness-pin">Witness PIN</Label>
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

  const managerPinField = (
    <div className="space-y-2">
      <Label htmlFor="refund-manager-pin">Your manager or owner PIN</Label>
      <Input
        id="refund-manager-pin"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={8}
        className="h-11"
        aria-describedby="refund-manager-pin-hint"
        disabled={busy || !online || !ready}
        value={managerPin}
        onChange={(event) => setManagerPin(event.target.value.replace(/\D/g, ''))}
      />
      <p id="refund-manager-pin-hint" className="text-sm text-text-muted">
        Required for every return and refund. If you set up an authenticator for approvals, enter
        its 6-digit code instead. Neither is ever saved on this device.
      </p>
    </div>
  );

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

  const quantitySummary = line
    ? perSold > 1
      ? `${units} base units (${Math.floor(units / perSold)} ${Math.floor(units / perSold) === 1 ? soldNoun : soldPlural}${units % perSold ? ` + ${units % perSold} loose` : ''})`
      : `${units} ${units === 1 ? soldNoun : soldPlural}`
    : '';

  return (
    <div className="space-y-4">
      {!online && <p role="alert">Offline. Returns and refunds require a connection.</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {attempt &&
        (refundAuthorized ? (
          managerPinField
        ) : (
          <p role="note" className="text-sm text-text-muted">
            This saved {attemptLabel[attempt.kind]} is kept for reconciliation. A manager or owner
            must retry it with their PIN.
          </p>
        ))}
      {attempt && (
        <Button
          className="h-11"
          onClick={() => void execute(attempt, witness, managerPin)}
          disabled={
            busy ||
            !online ||
            !ready ||
            // A saved return waits for its line details so a controlled line gets a witness.
            (attempt.kind !== 'refund' && (!data || !witnessReady)) ||
            !refundAuthorized ||
            !managerPinReady
          }
        >
          Retry saved {attemptLabel[attempt.kind]}
        </Button>
      )}
      {attempt && attempt.kind !== 'refund' && witnessRequired && witnessFields}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSearched({ value: parseReceiptNumber(number) });
          setEditedSinceSearch(false);
          setSaleId('');
          resetReturn();
          setTenderId('');
        }}
      >
        <div>
          <Label htmlFor="return-receipt">Receipt number</Label>
          <Input
            id="return-receipt"
            type="text"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            maxLength={40}
            required
            aria-invalid={showInvalid}
            aria-describedby={
              showInvalid ? 'return-receipt-error return-receipt-hint' : 'return-receipt-hint'
            }
            value={number}
            disabled={locked}
            onChange={(event) => {
              setNumber(event.target.value);
              // The explanation describes the submitted text; results stay hidden until a new search.
              setEditedSinceSearch(true);
            }}
            className="h-11"
          />
        </div>
        <Button
          type="submit"
          variant="outline"
          className="h-11"
          disabled={locked || !number.trim()}
        >
          Find receipt
        </Button>
        <p id="return-receipt-hint" className="w-full text-sm text-text-muted">
          Scan the receipt or type the number printed on it, for example 1042 or QA-1042.
        </p>
        {showInvalid && (
          <p id="return-receipt-error" className="w-full text-sm text-destructive">
            Enter a receipt number made of digits, for example 1042 or QA-1042. Negative numbers and
            zero are not receipt numbers.
          </p>
        )}
      </form>
      {lookup.isFetching && !!searched?.value && <p role="status">Looking up receipt…</p>}
      {!unparsed && lookup.isError && (
        <p role="alert">
          {counterErrorMessage(lookup.error)}{' '}
          <Button size="touch" variant="outline" onClick={() => void lookup.refetch()}>
            Retry lookup
          </Button>
        </p>
      )}
      {(showInvalid || (!!searched?.value && lookup.isSuccess && lookup.data.length === 0)) && (
        <p role="status">Receipt not found</p>
      )}
      {!unparsed && !!lookup.data?.length && (
        <div className="space-y-2">
          {lookup.data.length > 1 && (
            <p>Choose the matching date and counter. Receipt numbers can repeat.</p>
          )}
          {lookup.data.map((row) => (
            <Button
              key={row.id}
              variant="outline"
              className="h-auto min-h-11 w-full whitespace-normal"
              disabled={locked || row.branchId !== branchId}
              aria-pressed={row.id === saleId}
              onClick={() => {
                setSaleId(row.id);
                resetReturn();
                setTenderId('');
              }}
            >
              Receipt {row.receiptNumber} · {row.businessDate?.toISOString().slice(0, 10)} ·{' '}
              {row.counterLabel ?? 'Counter'} · {row.visibilityAnchor.name}
              {row.branchId !== branchId && ' · Switch to this branch to record a return.'}
            </Button>
          ))}
        </div>
      )}
      {saleId && history.isFetching && <p role="status">Loading return history…</p>}
      {saleId && history.isError && (
        <p role="alert">
          {counterErrorMessage(history.error)}{' '}
          <Button size="touch" variant="outline" onClick={() => void history.refetch()}>
            Reload history
          </Button>
        </p>
      )}
      {data && !refundAuthorized && (
        <p role="note" className="text-sm text-text-muted">
          Returns and refunds need a manager or owner. Ask one to record this return and refund it
          with their PIN.
        </p>
      )}
      {data && (
        <>
          {refundAuthorized && (
            <form
              aria-label="Return and refund"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                // Enter or a programmatic submit cannot pick a stock outcome.
              }}
            >
              <fieldset
                disabled={locked || stale}
                className="space-y-3 rounded-lg border border-border-subtle p-4"
              >
                <legend className="px-1 font-semibold">Return and refund</legend>
                <p className="text-sm text-text-muted">
                  Choose a reason, enter your PIN, then choose Restock or Keep aside to confirm.
                </p>
                <Label htmlFor="return-line">Sold line</Label>
                <select
                  id="return-line"
                  className={selectClass}
                  value={lineId}
                  onChange={(event) => {
                    setLineId(event.target.value);
                    setWitnessStaffId('');
                    setWitnessPin('');
                    setLotId('');
                    setQuantity(null);
                    setReason('');
                    setDisposition('');
                    setReturnAmount(null);
                  }}
                >
                  <option value="">Choose a line</option>
                  {data.lines.map((row) => (
                    <option
                      key={row.id}
                      value={row.id}
                      disabled={row.returnedUnits === row.canonicalUnits}
                    >
                      {row.name} · {formatSoldQuantity(row)} ·{' '}
                      {row.canonicalUnits - row.returnedUnits} units returnable
                    </option>
                  ))}
                </select>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="return-units">Return quantity ({soldPlural})</Label>
                    <Input
                      id="return-units"
                      className="h-11"
                      type="number"
                      inputMode="numeric"
                      min="0"
                      max={Math.floor(maximumUnits / perSold)}
                      step="1"
                      aria-invalid={!!line && !unitsValid}
                      aria-describedby="return-units-hint"
                      value={quantityInput.sold}
                      onChange={(event) => {
                        setQuantity({ ...quantityInput, sold: event.target.value });
                        setReturnAmount(null);
                      }}
                    />
                  </div>
                  {perSold > 1 && (
                    <div className="space-y-2">
                      <Label htmlFor="return-loose">Plus loose units</Label>
                      <Input
                        id="return-loose"
                        className="h-11"
                        type="number"
                        inputMode="numeric"
                        min="0"
                        max={perSold - 1}
                        step="1"
                        aria-invalid={!!line && !unitsValid}
                        aria-describedby="return-units-hint"
                        value={quantityInput.loose}
                        onChange={(event) => {
                          setQuantity({ ...quantityInput, loose: event.target.value });
                          setReturnAmount(null);
                        }}
                      />
                    </div>
                  )}
                </div>
                <p id="return-units-hint" className="text-sm text-text-muted" aria-live="polite">
                  {!line
                    ? 'Choose the sold line to return.'
                    : unitsValid
                      ? `Returning ${quantitySummary}.`
                      : `Enter between 1 and ${maximumUnits} base units.`}{' '}
                  {line &&
                    perSold > 1 &&
                    `One sold ${soldNoun} contains ${line.canonicalUnitsPerSaleUnit} base units.`}
                </p>
                <Label htmlFor="return-lot">Returned lot / batch</Label>
                <select
                  id="return-lot"
                  className={selectClass}
                  value={lotId}
                  onChange={(event) => {
                    setLotId(event.target.value);
                    setQuantity(null);
                    setReason('');
                    setDisposition('');
                    setReturnAmount(null);
                  }}
                >
                  <option value="">
                    Can&apos;t tell which batch → keep aside (don&apos;t resell)
                  </option>
                  {line?.lots.map((lot) => (
                    <option key={lot.lotId} value={lot.lotId} disabled={lot.returnableUnits <= 0}>
                      {batchPhrase(lot.batchNumber)}
                      {lot.expiresAt
                        ? ` · ${formatLotExpiry(lot.expiresAt, (value) => `expires ${value.toISOString().slice(0, 10)}`)}`
                        : ''}{' '}
                      · {lot.returnableUnits} units remaining
                      {lot.restockAllowed ? '' : ' · keep aside only'}
                    </option>
                  ))}
                </select>
                {!lotId && (
                  <p className="text-sm text-text-muted">
                    Stock from an unknown batch must be kept aside for pharmacist review. Don’t
                    resell it; no batch receives available stock.
                  </p>
                )}
                <ChoiceGroup
                  id="return-reason"
                  label="Reason"
                  value={reason}
                  options={REASONS.map(([value, label]) => ({ value, label }))}
                  onChange={(next) => {
                    setReason(next);
                    setRefundReason(next);
                  }}
                />
                {lotId && !selectedLot?.restockAllowed && (
                  <p className="text-sm text-text-muted">
                    This batch cannot be restocked. Keep it aside for review.
                  </p>
                )}
                <Label htmlFor="return-location">Keep-aside (quarantine) location</Label>
                <p className="text-sm text-text-muted">
                  Used only for Keep aside. Restock goes back to the verified batch’s original
                  shelf.
                </p>
                <select
                  id="return-location"
                  className={selectClass}
                  value={location}
                  onChange={(event) => setLocation(event.target.value)}
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
                    No keep-aside (quarantine) location is configured for this branch. Ask a
                    supervisor to configure one.
                  </p>
                )}
                <Label htmlFor="return-integrity">
                  Inspection and integrity decision (optional)
                </Label>
                <Input
                  id="return-integrity"
                  className="h-11"
                  placeholder={integrityDecision}
                  value={integrity}
                  onChange={(event) => setIntegrity(event.target.value)}
                />
                <p className="text-sm text-text-muted">
                  Restock only inspected medicine with acceptable storage and intact packaging.
                  Expired or recalled lots are refused by the server.
                </p>
                <Label htmlFor="return-refund-tender">Refund to</Label>
                <select
                  id="return-refund-tender"
                  className={selectClass}
                  value={returnTenderId}
                  onChange={(event) => {
                    setReturnTender(event.target.value);
                    setReturnAmount(null);
                    setReturnManual(false);
                  }}
                >
                  <option value="">Choose tender</option>
                  {data.tenders.map((row) => (
                    <option
                      key={row.id}
                      value={row.id}
                      disabled={row.refundedMinor >= row.amountMinor}
                    >
                      {row.prepaid ? 'Prepaid balance' : row.type} · PKR{' '}
                      {formatMinor(row.amountMinor - row.refundedMinor)} remaining
                    </option>
                  ))}
                  <option value="none">No refund now — record the return only</option>
                </select>
                {refundNow && (
                  <>
                    <Label htmlFor="return-refund-amount">Refund for this return (PKR)</Label>
                    <Input
                      id="return-refund-amount"
                      className="h-11"
                      inputMode="decimal"
                      aria-describedby="return-refund-amount-hint"
                      aria-invalid={
                        returnAmount !== null &&
                        !(returnAmountMinor > 0 && returnAmountMinor <= returnRefundMax)
                      }
                      disabled={quoted === undefined}
                      value={
                        returnAmount ?? (quoted === undefined ? '' : formatMinor(returnRefundMax))
                      }
                      onChange={(event) => setReturnAmount(event.target.value)}
                    />
                    <p id="return-refund-amount-hint" className="text-sm text-text-muted">
                      {quoted !== undefined
                        ? `Prefilled from the returned quantity. You can lower it, up to PKR ${formatMinor(returnRefundMax)}. Loyalty refunds restore redeemed points.`
                        : quote.isError
                          ? `${counterErrorMessage(quote.error)} The refund cannot be priced yet.`
                          : line && unitsValid
                            ? 'Pricing the returned quantity…'
                            : 'Enter the quantity to price the refund.'}
                    </p>
                    {quote.isError && (
                      <Button
                        size="touch"
                        type="button"
                        variant="outline"
                        onClick={() => void quote.refetch()}
                      >
                        Reprice refund
                      </Button>
                    )}
                    {returnTender?.prepaid && <p className="text-sm">{PREPAID_REFUND_NOTE}</p>}
                    {returnManualRequired && (
                      <label className="flex min-h-11 items-start gap-2">
                        <input
                          type="checkbox"
                          checked={returnManual}
                          onChange={(event) => setReturnManual(event.target.checked)}
                        />
                        No provider refund adapter is configured. Issue CASH from this drawer;
                        manual reversal required. I will reconcile the original provider separately.
                      </label>
                    )}
                  </>
                )}
                {!attempt && witnessRequired && witnessFields}
                {/* DEV-621: one PIN entry approves the next return or refund; it clears after each. */}
                {!attempt && managerPinField}
                {line && unitsValid && reason && (
                  <p className="text-sm text-text-muted">
                    Choose a stock outcome below to record {quantitySummary} of {line.name} as
                    inspected
                    {returnTender && returnAmountMinor > 0
                      ? ` and refund PKR ${formatMinor(returnAmountMinor)} to ${returnTender.prepaid ? 'the prepaid balance' : returnTender.type}`
                      : ''}
                    .
                  </p>
                )}
                <ChoiceGroup<'RESTOCK' | 'QUARANTINE'>
                  id="return-disposition"
                  label="What happens to the stock?"
                  value={disposition}
                  options={[
                    {
                      value: 'RESTOCK',
                      label: 'Restock — back on the shelf for sale',
                      disabled: !canConfirmReturn('RESTOCK'),
                    },
                    {
                      value: 'QUARANTINE',
                      label: "Keep aside — don't resell",
                      disabled: !canConfirmReturn('QUARANTINE'),
                    },
                  ]}
                  confirmation={
                    returnTenderId === 'none' ? 'Record return' : 'Confirm return & refund'
                  }
                  onChange={confirmReturn}
                />
              </fieldset>
            </form>
          )}
          {refundAuthorized && (data.refundableMinor > 0 || !!tenderId) && (
            <fieldset
              disabled={locked || stale}
              className="space-y-3 rounded-lg border border-border-subtle p-4"
            >
              <legend className="px-1 font-semibold">Refund returned value awaiting refund</legend>
              <p>Returned value awaiting refund: PKR {formatMinor(data.refundableMinor)}</p>
              <ChoiceGroup
                id="refund-reason"
                label="Refund reason"
                value={refundReason}
                options={REASONS.map(([value, label]) => ({ value, label }))}
                onChange={setRefundReason}
              />
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
                  <option
                    key={row.id}
                    value={row.id}
                    disabled={row.refundedMinor >= row.amountMinor}
                  >
                    {row.prepaid ? 'Prepaid balance' : row.type} · PKR{' '}
                    {formatMinor(row.amountMinor - row.refundedMinor)} remaining
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
                Refund up to PKR {formatMinor(available)} on this tender. Repeat with another
                original tender for a mixed payment. Loyalty refunds restore redeemed points.
              </p>
              {tender?.prepaid && <p className="text-sm">{PREPAID_REFUND_NOTE}</p>}
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
                  !tender ||
                  !refundReason ||
                  !Number.isSafeInteger(amountMinor) ||
                  amountMinor <= 0 ||
                  amountMinor > available ||
                  (manualRequired && !manual) ||
                  !managerPinReady
                }
                onClick={() =>
                  void execute(
                    {
                      kind: 'refund',
                      saleId,
                      input: {
                        branchId,
                        originalTenderId: tenderId,
                        amountMinor,
                        deviceId: deviceId(),
                        businessDate: businessDate().toISOString(),
                        reason: refundReason,
                        idempotencyKey: browserUuid(),
                        manualCashFallback: manualRequired && manual,
                      },
                    },
                    undefined,
                    managerPin
                  )
                }
              >
                Confirm refund
              </Button>
            </fieldset>
          )}
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
              <Button size="touch" variant="outline" onClick={() => void receipt.refetch()}>
                Reload receipt
              </Button>
            )}
          </section>
        </>
      )}
    </div>
  );
}
