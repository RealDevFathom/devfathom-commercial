'use client';

import { useDeferredValue, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { browserUuid } from '@/lib/browser-uuid';
import { counterErrorMessage } from '@/lib/pharmacy/counter-messages';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import {
  KHATA_TENDER_LABELS,
  khataPaymentSlipLines,
  parseMajorToMinor,
  type KhataPaymentSlipSource,
} from '@/lib/pharmacy/khata-payment-slip';
import { trpc } from '@/lib/trpc';

type Props = {
  branchId: string;
  organizationId: string;
  accountId: string;
  deviceId: () => string;
  businessDate: () => Date;
};

const TENDERS = ['CASH', 'BANK_TRANSFER', 'RAAST', 'JAZZCASH', 'EASYPAISA'] as const;
type Tender = (typeof TENDERS)[number];

type AttemptPayload = {
  branchId: string;
  familyAccountId: string;
  amountMinor: number;
  tender: Tender;
  deviceId?: string;
  payerReference?: string;
};

/**
 * A payment sent without a confirmed answer. It is kept apart from the editable form
 * and survives dialog close and page reload: if the server committed but the response
 * was lost, only resending this exact payload with this key can find out, and the
 * server then replays instead of taking the money twice. New payments wait until it
 * is resolved.
 */
type UnresolvedAttempt = {
  key: string;
  payload: AttemptPayload;
  businessDate: string;
  accountName: string;
  startedAt: string;
};

function isUnresolvedAttempt(value: unknown): value is UnresolvedAttempt {
  if (typeof value !== 'object' || value === null) return false;
  const attempt = value as Partial<UnresolvedAttempt>;
  const payload = attempt.payload as Partial<AttemptPayload> | undefined;
  return (
    typeof attempt.key === 'string' &&
    typeof attempt.businessDate === 'string' &&
    typeof attempt.accountName === 'string' &&
    typeof attempt.startedAt === 'string' &&
    typeof payload?.branchId === 'string' &&
    typeof payload.familyAccountId === 'string' &&
    Number.isSafeInteger(payload.amountMinor) &&
    (TENDERS as readonly unknown[]).includes(payload.tender)
  );
}

function readStoredAttempt(storageKey: string): UnresolvedAttempt | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    return isUnresolvedAttempt(parsed) ? parsed : null;
  } catch {
    // Storage may be unavailable; the in-memory attempt still covers this page.
    return null;
  }
}

function writeStoredAttempt(storageKey: string, attempt: UnresolvedAttempt | null) {
  try {
    if (attempt) localStorage.setItem(storageKey, JSON.stringify(attempt));
    else localStorage.removeItem(storageKey);
  } catch {
    // Best effort, as above.
  }
}

/** The server answered with a refusal, so its transaction rolled back and nothing was taken. */
function serverRefused(cause: unknown) {
  const status = (cause as { data?: { httpStatus?: unknown } } | null)?.data?.httpStatus;
  return typeof status === 'number' && status >= 400 && status < 500;
}

/** The counter device id lives in browser storage; reading it can throw. */
function safeDeviceId(read: () => string): string | null {
  try {
    return read();
  } catch {
    return null;
  }
}

type KhataPaymentSession = {
  unresolved: UnresolvedAttempt | null;
  setUnresolved: (attempt: UnresolvedAttempt | null) => void;
  slip: (KhataPaymentSlipSource & { replayed?: boolean }) | null;
  setSlip: (slip: (KhataPaymentSlipSource & { replayed?: boolean }) | null) => void;
  pending: boolean;
  setPending: (pending: boolean) => void;
};

function attemptStorageKey({ organizationId, accountId, branchId }: Props) {
  return `pharmacy-khata-payment:${organizationId}:${accountId}:${branchId}`;
}

function useKhataPaymentSession(storageKey: string): KhataPaymentSession {
  const [unresolved, setUnresolvedState] = useState<UnresolvedAttempt | null>(() =>
    typeof window === 'undefined' ? null : readStoredAttempt(storageKey)
  );
  const [slip, setSlip] = useState<KhataPaymentSession['slip']>(null);
  const [pending, setPending] = useState(false);
  const setUnresolved = (attempt: UnresolvedAttempt | null) => {
    writeStoredAttempt(storageKey, attempt);
    setUnresolvedState(attempt);
  };
  return { unresolved, setUnresolved, slip, setSlip, pending, setPending };
}

const selectClass =
  'h-11 w-full rounded-md border border-input bg-surface-card px-3 text-text-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50';

/** K4 (DEV-731): receive money against a khata account, outside any bill. */
export function CounterKhataPaymentPanel(props: Props) {
  const [open, setOpen] = useState(false);
  const session = useKhataPaymentSession(attemptStorageKey(props));
  return (
    <>
      <Button variant="outline" className="h-11" onClick={() => setOpen(true)}>
        Khata payment
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          // A payment in flight keeps the dialog open until the server answers.
          if (!next && session.pending) return;
          setOpen(next);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
          <DialogTitle>Khata payment</DialogTitle>
          <DialogDescription>
            Receive money against a khata account. Cash goes into this counter&apos;s open drawer.
          </DialogDescription>
          {open && (
            <KhataPaymentForm
              key={`${props.organizationId}:${props.accountId}:${props.branchId}`}
              {...props}
              session={session}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function KhataPaymentForm({
  session: parentSession,
  ...props
}: Props & { session?: KhataPaymentSession }) {
  const { branchId, deviceId, businessDate } = props;
  const localSession = useKhataPaymentSession(attemptStorageKey(props));
  const { unresolved, setUnresolved, slip, setSlip, pending, setPending } =
    parentSession ?? localSession;
  const device = safeDeviceId(deviceId);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [tender, setTender] = useState<Tender>('CASH');
  const [payerReference, setPayerReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const accounts = trpc.pharmacySales.khataPaymentAccounts.useQuery({
    branchId,
    query: deferredQuery,
  });
  const drawer = trpc.pharmacySales.drawerStatus.useQuery(
    { branchId, deviceId: device ?? '' },
    { enabled: device !== null }
  );
  const record = trpc.pharmacySales.recordKhataPayment.useMutation();

  const selected = accounts.data?.find((row) => row.id === selectedId) ?? null;
  const amountMinor = parseMajorToMinor(amount);
  const openDrawerId = drawer.data?.openDrawer?.id ?? null;
  const cash = tender === 'CASH';
  const referenceValid = cash || payerReference.trim().length >= 4;
  const overBalance = selected !== null && amountMinor > selected.balanceMinor;
  const blocker = unresolved
    ? 'Retry the previous payment above before taking a new one.'
    : !selected
      ? 'Choose the khata account.'
      : selected.balanceMinor <= 0
        ? 'This account owes nothing.'
        : amountMinor <= 0
          ? 'Enter the amount received.'
          : overBalance
            ? `The account owes PKR ${formatMinor(selected.balanceMinor)}. Enter that amount or less.`
            : cash && !device
              ? 'This browser cannot keep a counter id, so it cannot take cash. Use a non-cash tender or another counter.'
              : cash && !openDrawerId
                ? drawer.isLoading
                  ? 'Checking the cash drawer…'
                  : 'Open the cash drawer for this counter before taking cash.'
                : !referenceValid
                  ? 'Enter the transfer or wallet reference (at least 4 characters).'
                  : null;

  async function send(attempt: UnresolvedAttempt) {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await record.mutateAsync({
        ...attempt.payload,
        businessDate: new Date(attempt.businessDate),
        idempotencyKey: attempt.key,
      });
      setUnresolved(null);
      setSlip(result);
      if (result.replayed)
        setNotice(
          'This payment was already recorded. No new money was taken: give back any cash received twice.'
        );
      setAmount('');
      setPayerReference('');
      void accounts.refetch();
    } catch (cause) {
      // Only a server refusal proves nothing was recorded; any other failure stays
      // unresolved so the next step is a retry of this exact payment.
      if (serverRefused(cause)) setUnresolved(null);
      setError(counterErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function submit() {
    if (!selected || blocker || pending || unresolved) return;
    const attempt: UnresolvedAttempt = {
      key: `khata-payment:${browserUuid()}`,
      payload: {
        branchId,
        familyAccountId: selected.id,
        amountMinor,
        tender,
        ...(cash ? { deviceId: device! } : { payerReference: payerReference.trim() }),
      },
      businessDate: businessDate().toISOString(),
      accountName: selected.displayName,
      startedAt: new Date().toISOString(),
    };
    setUnresolved(attempt);
    await send(attempt);
  }

  function printSlip() {
    if (!slip) return;
    try {
      const popup = window.open('', '_blank', 'popup,width=480,height=720');
      if (!popup) throw new Error('Allow pop-ups to print this slip.');
      popup.opener = null;
      popup.document.open();
      popup.document.write('<!doctype html><title>Khata payment</title><body></body>');
      popup.document.close();
      const text = popup.document.createElement('pre');
      text.textContent = khataPaymentSlipLines(slip).join('\n');
      popup.document.body.append(text);
      popup.focus();
      popup.print();
      setNotice('Browser print dialog requested. Paper delivery is not confirmed.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Slip could not print.');
    }
  }

  if (slip)
    return (
      <section className="grid gap-3" aria-label="Khata payment recorded">
        <p role="status" className="text-sm text-success">
          {slip.currency} {formatMinor(slip.amountMinor)} received from {slip.accountName}.
          Reference {slip.receiptReference}.
        </p>
        <pre className="rounded-[var(--radius-sm)] border border-border-subtle bg-surface-sunken p-3 font-mono text-xs whitespace-pre-wrap text-text-body">
          {khataPaymentSlipLines(slip).join('\n')}
        </pre>
        {notice ? (
          <p className={`text-sm ${slip.replayed ? 'text-warning' : 'text-text-muted'}`}>
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button className="h-11" onClick={printSlip}>
            Print slip
          </Button>
          <Button
            variant="outline"
            className="h-11"
            onClick={() => {
              setSlip(null);
              setNotice(null);
              setError(null);
            }}
          >
            Another payment
          </Button>
        </div>
      </section>
    );

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {unresolved ? (
        <section
          aria-label="Unconfirmed khata payment"
          className="grid gap-2 rounded-[var(--radius-sm)] border border-warning bg-warning/10 p-3 text-sm text-text-body"
        >
          <p>
            A payment of PKR {formatMinor(unresolved.payload.amountMinor)} from{' '}
            {unresolved.accountName} ({KHATA_TENDER_LABELS[unresolved.payload.tender]}) has no
            confirmed result. Retry it to find out whether it was recorded. A retry never takes the
            money twice.
          </p>
          <Button
            type="button"
            className="h-11"
            disabled={pending}
            onClick={() => void send(unresolved)}
          >
            {pending ? 'Checking…' : 'Retry previous payment'}
          </Button>
        </section>
      ) : null}
      <div className="grid gap-1">
        <Label htmlFor="khata-payment-search">Find account</Label>
        <Input
          id="khata-payment-search"
          className="h-11"
          placeholder="Account name or last 4 phone digits"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div role="radiogroup" aria-label="Khata accounts" className="grid gap-1">
        {accounts.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {counterErrorMessage(accounts.error)}
          </p>
        ) : accounts.isLoading ? (
          <p className="text-sm text-text-muted">Loading khata accounts…</p>
        ) : !accounts.data?.length ? (
          <p className="text-sm text-text-muted">No active khata account matches this search.</p>
        ) : (
          accounts.data.map((row) => (
            <button
              key={row.id}
              type="button"
              role="radio"
              aria-checked={row.id === selectedId}
              onClick={() => setSelectedId(row.id)}
              className={`flex min-h-11 items-center justify-between gap-3 rounded-[var(--radius-sm)] border px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${row.id === selectedId ? 'border-border-strong bg-surface-sunken text-text-strong' : 'border-border-subtle text-text-body hover:bg-surface-sunken'}`}
            >
              <span>
                {row.displayName}
                {row.phoneLast4 ? (
                  <span className="ml-2 font-mono text-xs text-text-muted">
                    ···{row.phoneLast4}
                  </span>
                ) : null}
              </span>
              <span className="font-mono text-xs tabular-nums">
                Owes PKR {formatMinor(row.balanceMinor)}
              </span>
            </button>
          ))
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1">
          <Label htmlFor="khata-payment-amount">Amount received (PKR)</Label>
          <Input
            id="khata-payment-amount"
            className="h-11"
            inputMode="decimal"
            value={amount}
            aria-invalid={amount !== '' && (amountMinor <= 0 || overBalance)}
            onChange={(event) => setAmount(event.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="khata-payment-tender">Tender</Label>
          <select
            id="khata-payment-tender"
            className={selectClass}
            value={tender}
            onChange={(event) => setTender(event.target.value as Tender)}
          >
            {TENDERS.map((type) => (
              <option key={type} value={type}>
                {KHATA_TENDER_LABELS[type]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {cash ? null : (
        <div className="grid gap-1">
          <Label htmlFor="khata-payment-reference">Transfer or wallet reference</Label>
          <Input
            id="khata-payment-reference"
            className="h-11"
            maxLength={40}
            value={payerReference}
            onChange={(event) => setPayerReference(event.target.value)}
          />
        </div>
      )}
      {blocker ? <p className="text-sm text-text-muted">{blocker}</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="h-11" disabled={pending || blocker !== null}>
        {pending ? 'Recording…' : 'Record payment'}
      </Button>
    </form>
  );
}
