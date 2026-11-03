'use client';

import { forwardRef, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import type { TenderDraft } from './tender-attempt-storage';
import {
  isManualTender,
  manualTenderCaptureSchema,
  type ManualPaymentSettings,
} from '@/lib/pharmacy/manual-payments';

/** Counter-facing tenders. Integrated providers remain on their separate adapter path. */
const TENDER_TYPES = [
  { value: 'CASH', label: 'Cash', requiresAdapter: false },
  { value: 'CARD', label: 'Card', requiresAdapter: false },
  { value: 'BANK_TRANSFER', label: 'Bank transfer', requiresAdapter: false },
  { value: 'KHATA', label: 'Khata / credit', requiresAdapter: false },
  { value: 'RAAST', label: 'Raast', requiresAdapter: false },
  { value: 'JAZZCASH', label: 'JazzCash', requiresAdapter: false },
  { value: 'EASYPAISA', label: 'Easypaisa', requiresAdapter: false },
] as const;

// Historical attempts remain readable for outcome recovery, but cannot start new payments.
export type CounterTenderType = (typeof TENDER_TYPES)[number]['value'] | 'CREDIT' | 'WALLET';

export type CounterTenderResult = {
  status: 'accepted' | 'rejected' | 'unknown';
  message: string;
};

export type CounterTenderBillState =
  'idle' | 'loading' | 'error' | 'stale' | 'unavailable' | 'ready' | 'settled';

export type KhataAccount = {
  id: string;
  displayName: string;
  creditLimitMinor: number;
  balanceMinor: number;
};
export type CounterTenderPanelProps = {
  manualSettings?: ManualPaymentSettings;
  manualSettingsLoading?: boolean;
  manualSettingsError?: boolean;
  onReloadManualSettings?: () => void;
  loadKhataAccounts?: () => Promise<KhataAccount[]>;
  reauthenticateOwner?: (password: string, totp: string) => Promise<void>;
  printKhataStatement?: (familyAccountId: string) => Promise<void>;
  /** Only a known, current bill has a balance; zero alone is not settlement. */
  balanceMinor: number | null;
  state: CounterTenderBillState;
  blocked: boolean;
  pending?: boolean;
  disabled?: boolean;
  error?: string | null;
  initialDraft?: TenderDraft & {
    type: CounterTenderType;
    payerName?: string;
    providerRef?: string;
    approvalCode?: string;
    referenceSkipped?: boolean;
  };
  recoveryOutcome?: CounterTenderResult | null;
  checkingOutcome?: boolean;
  onCheckOutcome?: () => Promise<CounterTenderResult>;
  onRetry: () => void;
  onTender: (
    input: {
      type: CounterTenderType;
      amountMinor: number;
      cashReceivedMinor?: number;
      familyAccountId?: string;
      ownerOverride?: boolean;
      providerRef?: string;
      approvalCode?: string;
      payerName?: string;
      referenceSkipped?: boolean;
    },
    draft: TenderDraft
  ) => Promise<CounterTenderResult>;
};

function parseAmountMinor(value: string): number | null {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const major = Number.parseInt(match[1]!, 10);
  const fraction = Number.parseInt((match[2] ?? '0').padEnd(2, '0'), 10);
  const minor = major * 100 + fraction;
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * POS-05 tenders, from the counter.
 *
 * Two refusals are enforced here rather than left to the server round trip, so
 * the operator is told before they take money:
 *
 * - A bill carrying an unresolved SAFETY_BLOCK cannot be tendered at all.
 * - Cash tendered below the amount due is not change, it is a short payment.
 *
 * The server still enforces both. This only shortens the feedback loop; it is
 * not the authority.
 */
export const CounterTenderPanel = forwardRef<HTMLDivElement, CounterTenderPanelProps>(
  function CounterTenderPanel(
    {
      balanceMinor,
      state,
      blocked,
      pending = false,
      disabled = false,
      error,
      onRetry,
      onTender,
      initialDraft,
      recoveryOutcome,
      checkingOutcome = false,
      onCheckOutcome,
      loadKhataAccounts,
      reauthenticateOwner,
      printKhataStatement,
      manualSettings,
      manualSettingsLoading = false,
      manualSettingsError = false,
      onReloadManualSettings,
    },
    ref
  ) {
    const [accounts, setAccounts] = useState<KhataAccount[]>([]);
    const [accountId, setAccountId] = useState('');
    const [khataLoading, setKhataLoading] = useState(false);
    const [khataError, setKhataError] = useState('');
    const [ownerOverride, setOwnerOverride] = useState(false);
    const [password, setPassword] = useState('');
    const [totp, setTotp] = useState('');
    const [statementPending, setStatementPending] = useState(false);
    const [providerRef, setProviderRef] = useState(initialDraft?.providerRef ?? '');
    const [approvalCode, setApprovalCode] = useState(initialDraft?.approvalCode ?? '');
    const [payerName, setPayerName] = useState(initialDraft?.payerName ?? '');
    const [referenceSkipped, setReferenceSkipped] = useState(
      initialDraft?.referenceSkipped ?? false
    );
    const [type, setType] = useState<CounterTenderType>(initialDraft?.type ?? 'CASH');
    const [amount, setAmount] = useState(initialDraft?.amount ?? '');
    const [cashReceived, setCashReceived] = useState(initialDraft?.cashReceived ?? '');
    const [submitting, setSubmitting] = useState(false);
    const [outcome, setOutcome] = useState<CounterTenderResult | null>(null);
    const submissionRef = useRef(false);
    const checkRef = useRef(false);
    const statusRef = useRef<HTMLParagraphElement>(null);
    const takingPayment = pending || submitting;
    const displayedOutcome = recoveryOutcome ?? outcome;
    const unknown = displayedOutcome?.status === 'unknown';
    const balanceKnown =
      balanceMinor !== null && Number.isSafeInteger(balanceMinor) && balanceMinor >= 0;
    const editable = state === 'ready' && balanceKnown && !disabled && !takingPayment && !unknown;

    const amountMinor = amount.trim() === '' ? balanceMinor : parseAmountMinor(amount);
    const cashReceivedMinor = cashReceived.trim() === '' ? null : parseAmountMinor(cashReceived);
    const amountValid =
      balanceKnown && amountMinor !== null && amountMinor > 0 && amountMinor <= balanceMinor;
    const cashInvalid = type === 'CASH' && cashReceived.trim() !== '' && cashReceivedMinor === null;
    const cashShort =
      type === 'CASH' &&
      cashReceivedMinor !== null &&
      amountMinor !== null &&
      cashReceivedMinor < amountMinor;
    const changeMinor =
      type === 'CASH' && cashReceivedMinor !== null && amountMinor !== null && !cashShort
        ? cashReceivedMinor - amountMinor
        : null;
    const selected = TENDER_TYPES.find((entry) => entry.value === type) ?? TENDER_TYPES[0];
    const isKhata = type === 'KHATA' || type === 'CREDIT';
    const manual = isManualTender(type);
    const manualCard = type === 'CARD';
    const merchant = manual && type !== 'CARD' ? manualSettings?.[type] : undefined;
    const visibleTenderTypes = TENDER_TYPES.filter(
      (entry) =>
        !isManualTender(entry.value) ||
        entry.value === 'CARD' ||
        Boolean(manualSettings?.[entry.value])
    );
    useEffect(() => {
      if (editable && merchant && !merchant.allowReferenceSkip) setReferenceSkipped(false);
    }, [editable, merchant]);
    const capture = manual
      ? manualTenderCaptureSchema.safeParse({
          type,
          ...(manualCard ? { approvalCode } : { payerName }),
          ...(referenceSkipped ? { referenceSkipped: true } : { providerRef }),
        })
      : null;
    const account = accounts.find((row) => row.id === accountId);
    const overLimit = Boolean(
      account &&
      amountMinor !== null &&
      account.balanceMinor + amountMinor > account.creditLimitMinor
    );
    useEffect(() => {
      if (!isKhata || !loadKhataAccounts) return;
      let live = true;
      setKhataLoading(true);
      setKhataError('');
      setAccounts([]);
      void loadKhataAccounts()
        .then((rows) => {
          if (!live) return;
          setAccounts(rows);
          setAccountId(rows.length === 1 ? rows[0]!.id : '');
        })
        .catch(() => {
          if (live)
            setKhataError('Khata accounts could not be loaded. Refresh the bill and retry.');
        })
        .finally(() => {
          if (live) setKhataLoading(false);
        });
      return () => {
        live = false;
      };
    }, [isKhata, loadKhataAccounts]);
    const submittable =
      editable &&
      TENDER_TYPES.some((entry) => entry.value === type) &&
      !blocked &&
      amountValid &&
      !cashShort &&
      !cashInvalid &&
      (!manual ||
        (!manualSettingsLoading &&
          !manualSettingsError &&
          (manualCard || Boolean(merchant)) &&
          capture?.success === true &&
          (!referenceSkipped || merchant?.allowReferenceSkip === true))) &&
      (!isKhata ||
        (Boolean(account) &&
          !khataLoading &&
          (!overLimit || (ownerOverride && Boolean(password) && Boolean(reauthenticateOwner)))));

    async function submitTender() {
      if (!submittable || amountMinor === null || submissionRef.current) return;
      submissionRef.current = true;
      setSubmitting(true);
      setOutcome(null);
      try {
        if (isKhata && overLimit) {
          try {
            await reauthenticateOwner!(password, totp);
          } catch {
            setOutcome({
              status: 'rejected',
              message: 'Owner re-authentication failed. Check password and authentication code.',
            });
            return;
          } finally {
            setPassword('');
            setTotp('');
          }
        }
        const result = await onTender(
          {
            type,
            amountMinor,
            ...(isKhata
              ? { familyAccountId: accountId, ownerOverride: overLimit && ownerOverride }
              : {}),
            ...(type === 'CASH' && cashReceivedMinor !== null ? { cashReceivedMinor } : {}),
            ...(manual && capture?.success
              ? {
                  ...(capture.data.payerName ? { payerName: capture.data.payerName } : {}),
                  ...(capture.data.approvalCode ? { approvalCode: capture.data.approvalCode } : {}),
                  ...(capture.data.referenceSkipped
                    ? { referenceSkipped: true }
                    : { providerRef: capture.data.providerRef }),
                }
              : {}),
          },
          { amount, cashReceived: type === 'CASH' ? cashReceived : '' }
        );
        setOutcome(result);
        if (result.status === 'accepted') {
          setAmount('');
          setCashReceived('');
          setProviderRef('');
          setApprovalCode('');
          setPayerName('');
          setReferenceSkipped(false);
          if (isKhata && loadKhataAccounts) {
            try {
              setAccounts(await loadKhataAccounts());
            } catch {
              setAccounts([]);
              setKhataError('Payment recorded. Refresh the bill to reload the Khata ledger.');
            }
          }
        }
      } catch {
        setOutcome({
          status: 'unknown',
          message:
            'Payment outcome is unknown. Keep this bill open and ask a supervisor to check the payment before taking more money.',
        });
      } finally {
        submissionRef.current = false;
        setSubmitting(false);
      }
    }

    async function checkOutcome() {
      if (!onCheckOutcome || checkRef.current || checkingOutcome || takingPayment) return;
      checkRef.current = true;
      try {
        const result = await onCheckOutcome();
        setOutcome(result);
        if (result.status === 'accepted') {
          setAmount('');
          setCashReceived('');
          statusRef.current?.focus();
        }
      } catch {
        setOutcome({
          status: 'unknown',
          message:
            'Payment outcome could not be checked. Keep this bill open and check again before taking more money.',
        });
      } finally {
        checkRef.current = false;
      }
    }

    return (
      <div
        ref={ref}
        tabIndex={-1}
        className="min-w-0 space-y-5 focus-visible:outline-none"
        onKeyDown={(event) => {
          if (
            manual &&
            event.key === 'Enter' &&
            event.target instanceof HTMLInputElement &&
            event.target.type !== 'checkbox' &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            void submitTender();
          }
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border-subtle bg-surface-sunken p-4">
          <p className="space-y-2">
            <span className="block font-mono text-xs tracking-wide text-text-muted uppercase">
              Balance due
            </span>
            <span className="block text-3xl font-semibold tracking-tight tabular-nums text-text-strong">
              {balanceKnown && (state === 'ready' || state === 'settled') && !unknown
                ? formatMinor(balanceMinor)
                : 'Unavailable'}
            </span>
          </p>
          <div className="flex flex-col items-end gap-2">
            <span className="font-mono text-xs text-text-muted">PKR</span>
            {state === 'settled' && balanceMinor === 0 && !unknown && !takingPayment ? (
              <StatusPill status="settled" tone="success" label="Settled" />
            ) : null}
          </div>
        </div>

        <p
          ref={statusRef}
          tabIndex={-1}
          id="tender-status"
          role="status"
          aria-live="polite"
          className="text-sm leading-relaxed text-text-body focus-visible:outline-ring"
        >
          {takingPayment
            ? 'Taking payment… Keep this bill open.'
            : checkingOutcome
              ? 'Checking payment outcome… No payment is being sent.'
              : (displayedOutcome?.message ??
                (state === 'idle'
                  ? 'Open a bill before taking payment.'
                  : state === 'loading'
                    ? 'Checking the bill balance…'
                    : state === 'stale'
                      ? 'Refresh this bill to verify the balance before taking payment.'
                      : state === 'error'
                        ? 'The bill balance could not be verified. Retry the bill read before taking payment.'
                        : state === 'unavailable'
                          ? 'This bill is not available for payment.'
                          : ''))}
        </p>
        {onCheckOutcome ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 rounded-sm"
            disabled={checkingOutcome || takingPayment}
            aria-describedby="tender-status tender-error"
            onClick={() => void checkOutcome()}
          >
            {checkingOutcome ? 'Checking payment outcome…' : 'Check payment outcome'}
          </Button>
        ) : null}
        {!takingPayment && ['error', 'stale', 'unavailable'].includes(state) ? (
          <Button type="button" variant="outline" className="min-h-11 rounded-sm" onClick={onRetry}>
            Refresh bill
          </Button>
        ) : null}

        {blocked ? (
          <div
            id="tender-blocked"
            role="alert"
            className="space-y-2 rounded-md border border-destructive/20 bg-destructive/10 p-4 text-sm text-text-body"
          >
            <StatusPill status="blocked" tone="danger" label="Payment locked" />
            <p>
              This bill carries an unresolved safety block. Resolve it in the prescription panel
              before taking payment.
            </p>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="tender-type">Tender</Label>
          <select
            id="tender-type"
            value={type}
            disabled={!editable}
            onChange={(event) => {
              setType(event.target.value as CounterTenderType);
              setProviderRef('');
              setApprovalCode('');
              setPayerName('');
              setReferenceSkipped(false);
            }}
            className="h-11 w-full rounded-sm border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            {visibleTenderTypes.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
          {selected.requiresAdapter ? (
            <p className="text-sm text-text-muted">
              Requires a certified payment provider. Without one configured, the server refuses this
              tender rather than simulating an approval.
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="tender-amount">Amount</Label>
          <Input
            id="tender-amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder={balanceKnown ? formatMinor(balanceMinor) : undefined}
            value={amount}
            disabled={!editable}
            aria-invalid={state === 'ready' && amount.trim() !== '' && !amountValid}
            aria-describedby="tender-status tender-error tender-amount-help tender-amount-error"
            onChange={(event) => setAmount(event.target.value)}
            className="h-11 rounded-sm font-mono tabular-nums"
          />
          <p id="tender-amount-help" className="text-sm text-text-muted">
            Leave blank to pay the balance due. Enter a smaller amount to split payment across
            tenders.
          </p>
          {state === 'ready' && amount.trim() !== '' && !amountValid ? (
            <p id="tender-amount-error" className="text-sm text-destructive" role="alert">
              Enter an amount between 0.01 and the balance due.
            </p>
          ) : null}
        </div>

        {manual ? (
          <div className="space-y-3 rounded-md border border-border-default bg-surface-sunken p-4">
            {manualSettingsLoading ? <p role="status">Loading merchant details…</p> : null}
            {manualSettingsError ? <p role="alert">Merchant details could not be loaded.</p> : null}
            {!manualCard && !manualSettingsLoading && !manualSettingsError && !merchant ? (
              <p role="alert">
                {selected.label} is not set up for this branch. Ask the owner to enable it in
                Finance.
              </p>
            ) : null}
            {onReloadManualSettings ? (
              <Button
                variant="outline"
                className="min-h-11 rounded-sm"
                disabled={takingPayment || manualSettingsLoading}
                onClick={onReloadManualSettings}
              >
                Reload merchant details
              </Button>
            ) : null}
            {manualCard || merchant ? (
              <>
                <p className="font-mono text-lg tabular-nums">
                  {amountMinor === null ? 'Enter amount' : `PKR ${formatMinor(amountMinor)}`}
                </p>
                {merchant?.destination ? (
                  <p className="break-all text-sm text-text-strong">{merchant.destination}</p>
                ) : null}
                {merchant?.qrImageDataUrl ? (
                  <>
                    {/* Static embedded raster; no remote image requests or proxy. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={merchant.qrImageDataUrl}
                      alt={`${type} merchant QR`}
                      className="h-56 w-full rounded-sm bg-surface-card object-contain"
                    />
                  </>
                ) : null}
                <p className="text-sm text-text-muted">
                  {manualCard
                    ? 'Confirm the approved payment on the standalone terminal before recording it.'
                    : 'Confirm receipt in the merchant bank or wallet account before taking payment. Any configured QR is static; the payer enters the amount shown.'}
                </p>
                {!manualCard ? (
                  <>
                    <Label htmlFor="manual-payer-name">Payer’s name</Label>
                    <Input
                      id="manual-payer-name"
                      className="min-h-11"
                      value={payerName}
                      maxLength={100}
                      disabled={!editable}
                      onChange={(event) => setPayerName(event.target.value)}
                    />
                  </>
                ) : null}
                <Label htmlFor="manual-provider-reference">
                  {manualCard ? 'Terminal reference or card last 4 digits' : 'Transaction ID'}
                </Label>
                <Input
                  id="manual-provider-reference"
                  className="min-h-11"
                  inputMode="text"
                  value={providerRef}
                  maxLength={120}
                  disabled={!editable || referenceSkipped}
                  aria-invalid={
                    !referenceSkipped && providerRef !== '' && providerRef.trim().length < 4
                  }
                  aria-describedby="manual-reference-help"
                  onChange={(event) => setProviderRef(event.target.value)}
                />
                <p id="manual-reference-help" className="text-sm text-text-muted">
                  {referenceSkipped
                    ? 'Reference explicitly skipped under branch policy.'
                    : manualCard
                      ? 'Enter the terminal reference or the card’s last 4 digits.'
                      : 'Enter the payer’s transaction ID.'}
                </p>
                {manualCard ? (
                  <>
                    <Label htmlFor="manual-approval-code">Approval code</Label>
                    <Input
                      id="manual-approval-code"
                      className="min-h-11"
                      value={approvalCode}
                      maxLength={60}
                      disabled={!editable}
                      onChange={(event) => setApprovalCode(event.target.value)}
                    />
                  </>
                ) : null}
                {merchant?.allowReferenceSkip ? (
                  <Label className="flex min-h-11 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={referenceSkipped}
                      disabled={!editable}
                      onChange={(event) => {
                        setReferenceSkipped(event.target.checked);
                        setProviderRef('');
                      }}
                    />{' '}
                    Skip reference under branch policy
                  </Label>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        {isKhata ? (
          <div className="space-y-3 rounded-md border border-border-default bg-surface-sunken p-4">
            <Label htmlFor="khata-account">Family Khata account</Label>
            <select
              id="khata-account"
              className="h-11 w-full rounded-sm border border-border-default bg-surface-card px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
              value={accountId}
              disabled={!editable || khataLoading}
              onChange={(event) => {
                setAccountId(event.target.value);
                setOwnerOverride(false);
              }}
            >
              <option value="">Choose family account</option>
              {accounts.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.displayName}
                </option>
              ))}
            </select>
            {khataLoading ? <p role="status">Loading Khata ledger…</p> : null}
            {khataError ? <p role="alert">{khataError}</p> : null}
            {!khataLoading && !khataError && !accounts.length ? (
              <p>Link a customer with an active family account before using Khata.</p>
            ) : null}
            {account ? (
              <p className="text-sm text-text-body">
                Due on this bill’s business date. Ledger balance {formatMinor(account.balanceMinor)}{' '}
                · Limit {formatMinor(account.creditLimitMinor)}
              </p>
            ) : null}
            {overLimit ? (
              <>
                <p role="alert" className="text-sm text-destructive">
                  This charge exceeds the family credit limit. An owner must re-enter their password
                  to raise the limit to {formatMinor(account!.balanceMinor + amountMinor!)}.
                </p>
                <Label className="flex min-h-11 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={ownerOverride}
                    disabled={!editable}
                    onChange={(event) => setOwnerOverride(event.target.checked)}
                  />
                  Owner: authorize limit increase
                </Label>
                {ownerOverride ? (
                  <>
                    <Label htmlFor="khata-password">Owner password (current account)</Label>
                    <Input
                      id="khata-password"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      disabled={!editable}
                      onChange={(event) => setPassword(event.target.value)}
                      className="h-11 rounded-sm"
                    />
                    <Label htmlFor="khata-totp">Authentication or recovery code (if enabled)</Label>
                    <Input
                      id="khata-totp"
                      autoComplete="one-time-code"
                      value={totp}
                      disabled={!editable}
                      onChange={(event) => setTotp(event.target.value)}
                      className="h-11 rounded-sm"
                    />
                  </>
                ) : null}
              </>
            ) : null}
            <Button
              type="button"
              variant="outline"
              className="min-h-11 rounded-sm"
              disabled={
                !account || statementPending || takingPayment || unknown || !printKhataStatement
              }
              onClick={async () => {
                if (!account || !printKhataStatement) return;
                setStatementPending(true);
                try {
                  await printKhataStatement(account.id);
                  setKhataError('');
                } catch {
                  setKhataError(
                    'Statement unavailable. Allow pop-ups and retry after refreshing the bill.'
                  );
                } finally {
                  setStatementPending(false);
                }
              }}
            >
              {statementPending ? 'Loading statement…' : 'Print Khata statement'}
            </Button>
          </div>
        ) : null}

        {type === 'CASH' ? (
          <div className="space-y-1.5">
            <Label htmlFor="tender-cash-received">Cash received</Label>
            <Input
              id="tender-cash-received"
              inputMode="decimal"
              autoComplete="off"
              value={cashReceived}
              disabled={!editable}
              aria-invalid={cashShort || cashInvalid || undefined}
              aria-describedby="tender-status tender-error tender-cash-error"
              onChange={(event) => setCashReceived(event.target.value)}
              className="h-11 rounded-sm font-mono tabular-nums"
            />
            {cashInvalid ? (
              <p id="tender-cash-error" className="text-sm text-destructive" role="alert">
                Enter a valid cash amount with at most two decimal places.
              </p>
            ) : cashShort ? (
              <p id="tender-cash-error" className="text-sm text-destructive" role="alert">
                Cash received is less than the amount tendered.
              </p>
            ) : changeMinor !== null ? (
              <p
                className="flex flex-wrap items-center justify-between gap-2 rounded-sm bg-surface-sunken px-4 py-3 text-sm text-text-body"
                aria-live="polite"
              >
                <span>Change</span>
                <span className="font-mono text-lg tabular-nums text-text-strong">
                  {formatMinor(changeMinor)}
                </span>
              </p>
            ) : null}
          </div>
        ) : null}

        <p
          id="tender-error"
          className="text-sm text-destructive empty:hidden"
          role={error ? 'alert' : undefined}
        >
          {error}
        </p>

        <Button
          type="button"
          className="min-h-12 w-full rounded-sm"
          disabled={!submittable}
          aria-describedby={
            blocked ? 'tender-status tender-error tender-blocked' : 'tender-status tender-error'
          }
          onClick={() => void submitTender()}
        >
          {takingPayment ? 'Taking payment…' : 'Take payment'}
        </Button>
      </div>
    );
  }
);
