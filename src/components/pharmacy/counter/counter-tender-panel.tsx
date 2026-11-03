'use client';

import { useTranslations } from 'next-intl';
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

/** The tenders POS-05 recognises. Card and wallet need a certified adapter. */
const TENDER_TYPES = [
  { value: 'CASH', requiresAdapter: false },
  { value: 'CARD', requiresAdapter: true },
  { value: 'BANK_TRANSFER', requiresAdapter: false },
  { value: 'WALLET', requiresAdapter: true },
  { value: 'KHATA', requiresAdapter: false },
  { value: 'CREDIT', requiresAdapter: false },
  { value: 'RAAST', requiresAdapter: false },
  { value: 'JAZZCASH', requiresAdapter: false },
  { value: 'EASYPAISA', requiresAdapter: false },
] as const;

export type CounterTenderType = (typeof TENDER_TYPES)[number]['value'];

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
    const ct = useTranslations('CounterText');
    const [accounts, setAccounts] = useState<KhataAccount[]>([]);
    const [accountId, setAccountId] = useState('');
    const [khataLoading, setKhataLoading] = useState(false);
    const [khataError, setKhataError] = useState('');
    const [ownerOverride, setOwnerOverride] = useState(false);
    const [password, setPassword] = useState('');
    const [totp, setTotp] = useState('');
    const [statementPending, setStatementPending] = useState(false);
    const [providerRef, setProviderRef] = useState(initialDraft?.providerRef ?? '');
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
    const selected = TENDER_TYPES.find((entry) => entry.value === type)!;
    const isKhata = type === 'KHATA' || type === 'CREDIT';
    const manual = isManualTender(type);
    const merchant = manual ? manualSettings?.[type] : undefined;
    useEffect(() => {
      if (editable && merchant && !merchant.allowReferenceSkip) setReferenceSkipped(false);
    }, [editable, merchant]);
    const capture = manual
      ? manualTenderCaptureSchema.safeParse({
          type,
          payerName,
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
          if (live) setKhataError(ct('khataAccountsCouldNotBeLoadedRefreshTheBill'));
        })
        .finally(() => {
          if (live) setKhataLoading(false);
        });
      return () => {
        live = false;
      };
    }, [isKhata, loadKhataAccounts, ct]);
    const submittable =
      editable &&
      !blocked &&
      amountValid &&
      !cashShort &&
      !cashInvalid &&
      (!manual ||
        (!manualSettingsLoading &&
          !manualSettingsError &&
          Boolean(merchant) &&
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
              message: ct('ownerReAuthenticationFailedCheckPasswordAndAuthenticationCode'),
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
                  payerName: capture.data.payerName,
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
          setPayerName('');
          setReferenceSkipped(false);
          if (isKhata && loadKhataAccounts) {
            try {
              setAccounts(await loadKhataAccounts());
            } catch {
              setAccounts([]);
              setKhataError(ct('paymentRecordedRefreshTheBillToReloadTheKhata'));
            }
          }
        }
      } catch {
        setOutcome({
          status: 'unknown',
          message: ct('paymentOutcomeIsUnknownKeepThisBillOpenAnd'),
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
          message: ct('paymentOutcomeCouldNotBeCheckedKeepThisBill'),
        });
      } finally {
        checkRef.current = false;
      }
    }

    return (
      <div ref={ref} tabIndex={-1} className="min-w-0 space-y-5 focus-visible:outline-none">
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border-subtle bg-surface-sunken p-4">
          <p className="space-y-2">
            <span className="block font-mono text-xs tracking-wide text-text-muted uppercase">
              {ct('balanceDue')}
            </span>
            <span className="block text-3xl font-semibold tracking-tight tabular-nums text-text-strong">
              {balanceKnown && (state === 'ready' || state === 'settled') && !unknown
                ? formatMinor(balanceMinor)
                : ct('unavailable')}
            </span>
          </p>
          <div className="flex flex-col items-end gap-2">
            <span className="font-mono text-xs text-text-muted">PKR</span>
            {state === 'settled' && balanceMinor === 0 && !unknown && !takingPayment ? (
              <StatusPill status="settled" tone="success" label={ct('settled')} />
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
            ? ct('takingPaymentKeepThisBillOpen')
            : checkingOutcome
              ? ct('checkingPaymentOutcomeNoPaymentIsBeingSent')
              : (displayedOutcome?.message ??
                (state === 'idle'
                  ? ct('openABillBeforeTakingPayment')
                  : state === 'loading'
                    ? ct('checkingTheBillBalance')
                    : state === 'stale'
                      ? ct('refreshThisBillToVerifyTheBalanceBeforeTaking')
                      : state === 'error'
                        ? ct('theBillBalanceCouldNotBeVerifiedRetryThe')
                        : state === 'unavailable'
                          ? ct('thisBillIsNotAvailableForPayment')
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
            {checkingOutcome ? ct('checkingPaymentOutcome') : ct('checkPaymentOutcome')}
          </Button>
        ) : null}
        {!takingPayment && ['error', 'stale', 'unavailable'].includes(state) ? (
          <Button type="button" variant="outline" className="min-h-11 rounded-sm" onClick={onRetry}>
            {ct('refreshBill')}
          </Button>
        ) : null}

        {blocked ? (
          <div
            id="tender-blocked"
            role="alert"
            className="space-y-2 rounded-md border border-destructive/20 bg-destructive/10 p-4 text-sm text-text-body"
          >
            <StatusPill status="blocked" tone="danger" label={ct('paymentLocked')} />
            <p>{ct('thisBillCarriesAnUnresolvedSafetyBlockResolveIt2')}</p>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="tender-type">{ct('tender')}</Label>
          <select
            id="tender-type"
            value={type}
            disabled={!editable}
            onChange={(event) => {
              setType(event.target.value as CounterTenderType);
              setProviderRef('');
              setPayerName('');
              setReferenceSkipped(false);
            }}
            className="h-11 w-full rounded-sm border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            {TENDER_TYPES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {ct(`tenderTypes.${entry.value}`)}
              </option>
            ))}
          </select>
          {selected.requiresAdapter ? (
            <p className="text-sm text-text-muted">
              {ct('requiresACertifiedPaymentProviderWithoutOneConfiguredThe')}
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="tender-amount">{ct('amount')}</Label>
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
            {ct('leaveBlankToPayTheBalanceDueEnterA')}
          </p>
          {state === 'ready' && amount.trim() !== '' && !amountValid ? (
            <p id="tender-amount-error" className="text-sm text-destructive" role="alert">
              {ct('enterAnAmountBetween001AndTheBalance')}
            </p>
          ) : null}
        </div>

        {manual ? (
          <div className="space-y-3 rounded-md border border-border-default bg-surface-sunken p-4">
            {manualSettingsLoading ? <p role="status">{ct('loadingMerchantDetails')}</p> : null}
            {manualSettingsError ? (
              <p role="alert">{ct('merchantDetailsCouldNotBeLoaded')}</p>
            ) : null}
            {!manualSettingsLoading && !manualSettingsError && !merchant ? (
              <p role="alert">
                {ct('thisBranchHasNoMerchantDetailsFor')}
                {type}
                {ct('askAnAdministratorToConfigureThemInFinance')}
              </p>
            ) : null}
            {onReloadManualSettings ? (
              <Button
                variant="outline"
                className="min-h-11 rounded-sm"
                disabled={takingPayment || manualSettingsLoading}
                onClick={onReloadManualSettings}
              >
                {ct('reloadMerchantDetails')}
              </Button>
            ) : null}
            {merchant ? (
              <>
                <p className="font-mono text-lg tabular-nums">
                  {amountMinor === null
                    ? ct('enterAmount')
                    : ct('pkrValue0', { value0: formatMinor(amountMinor) })}
                </p>
                {merchant.destination ? (
                  <p className="break-all text-sm text-text-strong">{merchant.destination}</p>
                ) : null}
                {merchant.qrImageDataUrl ? (
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
                  {ct('confirmReceiptInTheMerchantBankOrWalletAccount')}
                </p>
                <Label htmlFor="manual-payer-name">{ct('payerSName')}</Label>
                <Input
                  id="manual-payer-name"
                  className="min-h-11"
                  value={payerName}
                  maxLength={100}
                  disabled={!editable}
                  onChange={(event) => setPayerName(event.target.value)}
                />
                <Label htmlFor="manual-provider-reference">{ct('transactionIDLast46Digits')}</Label>
                <Input
                  id="manual-provider-reference"
                  className="min-h-11"
                  inputMode="numeric"
                  value={providerRef}
                  maxLength={6}
                  disabled={!editable || referenceSkipped}
                  aria-invalid={
                    !referenceSkipped && providerRef !== '' && !/^\d{4,6}$/.test(providerRef)
                  }
                  aria-describedby="manual-reference-help"
                  onChange={(event) => setProviderRef(event.target.value)}
                />
                <p id="manual-reference-help" className="text-sm text-text-muted">
                  {referenceSkipped
                    ? ct('referenceExplicitlySkippedUnderBranchPolicy')
                    : ct('enter46DigitsFromThePayerSTransaction')}
                </p>
                {merchant.allowReferenceSkip ? (
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
                    {ct('skipReferenceUnderBranchPolicy')}
                  </Label>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        {isKhata ? (
          <div className="space-y-3 rounded-md border border-border-default bg-surface-sunken p-4">
            <Label htmlFor="khata-account">{ct('familyKhataAccount')}</Label>
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
              <option value="">{ct('chooseFamilyAccount')}</option>
              {accounts.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.displayName}
                </option>
              ))}
            </select>
            {khataLoading ? <p role="status">{ct('loadingKhataLedger')}</p> : null}
            {khataError ? <p role="alert">{khataError}</p> : null}
            {!khataLoading && !khataError && !accounts.length ? (
              <p>{ct('linkACustomerWithAnActiveFamilyAccountBefore')}</p>
            ) : null}
            {account ? (
              <p className="text-sm text-text-body">
                {ct('dueOnThisBillSBusinessDateLedgerBalance')}
                {formatMinor(account.balanceMinor)} {ct('limit')}
                {formatMinor(account.creditLimitMinor)}
              </p>
            ) : null}
            {overLimit ? (
              <>
                <p role="alert" className="text-sm text-destructive">
                  {ct('thisChargeExceedsTheFamilyCreditLimitAnOwner')}
                  {formatMinor(account!.balanceMinor + amountMinor!)}.
                </p>
                <Label className="flex min-h-11 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={ownerOverride}
                    disabled={!editable}
                    onChange={(event) => setOwnerOverride(event.target.checked)}
                  />
                  {ct('ownerAuthorizeLimitIncrease')}
                </Label>
                {ownerOverride ? (
                  <>
                    <Label htmlFor="khata-password">{ct('ownerPasswordCurrentAccount')}</Label>
                    <Input
                      id="khata-password"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      disabled={!editable}
                      onChange={(event) => setPassword(event.target.value)}
                      className="h-11 rounded-sm"
                    />
                    <Label htmlFor="khata-totp">
                      {ct('authenticationOrRecoveryCodeIfEnabled')}
                    </Label>
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
                  setKhataError(ct('statementUnavailableAllowPopUpsAndRetryAfterRefreshing'));
                } finally {
                  setStatementPending(false);
                }
              }}
            >
              {statementPending ? ct('loadingStatement') : ct('printKhataStatement')}
            </Button>
          </div>
        ) : null}

        {type === 'CASH' ? (
          <div className="space-y-1.5">
            <Label htmlFor="tender-cash-received">{ct('cashReceived')}</Label>
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
                {ct('enterAValidCashAmountWithAtMostTwo')}
              </p>
            ) : cashShort ? (
              <p id="tender-cash-error" className="text-sm text-destructive" role="alert">
                {ct('cashReceivedIsLessThanTheAmountTendered')}
              </p>
            ) : changeMinor !== null ? (
              <p
                className="flex flex-wrap items-center justify-between gap-2 rounded-sm bg-surface-sunken px-4 py-3 text-sm text-text-body"
                aria-live="polite"
              >
                <span>{ct('change')}</span>
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
          {takingPayment ? ct('takingPayment') : ct('takePayment')}
        </Button>
      </div>
    );
  }
);
