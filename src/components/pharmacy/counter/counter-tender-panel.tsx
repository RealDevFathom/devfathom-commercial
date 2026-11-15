'use client';

import { forwardRef, useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { CounterChangeDue } from './counter-change-due';
import { StatusPill } from '@/components/ui/status-pill';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import type { TenderDraft } from './tender-attempt-storage';
import {
  isManualTender,
  MANUAL_CARD_APPROVAL_CODE,
  MANUAL_CARD_REFERENCE,
  manualCardCaptureSchema,
  manualTenderCaptureSchema,
  type ManualPaymentSettings,
} from '@/lib/pharmacy/manual-payments';
import { COUNTER_CASH_DRAWER_CLOSED_MESSAGE } from '@/lib/pharmacy/counter-messages';
import type { CounterCartTender } from '@/lib/pharmacy/counter';

/**
 * The tenders POS-05 recognises, in button order. `offer` decides which
 * buttons the counter shows: the four core tenders always, a manual wallet
 * only once loaded branch settings show it is enabled. DEV-713: Card is a
 * payment received on the shop's standalone terminal, so it needs no provider.
 * Wallet and legacy Credit are no longer offered; they stay here so a restored
 * attempt of either type still renders and can be resolved.
 */
const TENDER_TYPES = [
  { value: 'CASH', label: 'Cash', requiresAdapter: false, offer: 'always' },
  { value: 'CARD', label: 'Card', requiresAdapter: false, offer: 'always' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer', requiresAdapter: false, offer: 'always' },
  { value: 'KHATA', label: 'Khata', requiresAdapter: false, offer: 'always' },
  { value: 'JAZZCASH', label: 'JazzCash', requiresAdapter: false, offer: 'configured' },
  { value: 'EASYPAISA', label: 'Easypaisa', requiresAdapter: false, offer: 'configured' },
  { value: 'RAAST', label: 'Raast', requiresAdapter: false, offer: 'configured' },
  { value: 'WALLET', label: 'Wallet', requiresAdapter: true, offer: 'restore' },
  { value: 'CREDIT', label: 'Credit (legacy)', requiresAdapter: false, offer: 'restore' },
] as const;

export type CounterTenderType = (typeof TENDER_TYPES)[number]['value'];

export type CounterTenderResult = {
  status: 'accepted' | 'rejected' | 'unknown';
  message: string;
  /** Change from the accepted saved tender, independent of the current bill balance. */
  changeMinor?: number;
};

export type CounterTenderBillState =
  'idle' | 'loading' | 'error' | 'stale' | 'unavailable' | 'ready' | 'settled';

export type KhataAccount = {
  id: string;
  displayName: string;
  creditLimitMinor: number;
  balanceMinor: number;
};
export type KhataSignupInput =
  | { patientId: string; displayName: string; consentGranted: true }
  | { displayName: string; phone: string; consentGranted: true };
export type CounterTenderPanelProps = {
  /** #722: payments already recorded on this bill, in the order taken. */
  tenders?: readonly CounterCartTender[];
  /** Receipt total retained after the parent has verified this bill's settlement. */
  confirmedChangeMinor?: number;
  manualSettings?: ManualPaymentSettings;
  /**
   * This counter's cash drawer: `false` once the server reports none open,
   * `undefined` while unknown. Only cash needs the drawer, so a closed drawer
   * flags the Cash button and leaves every other tender usable.
   */
  drawerOpen?: boolean;
  manualSettingsLoading?: boolean;
  manualSettingsError?: boolean;
  onReloadManualSettings?: () => void;
  loadKhataAccounts?: () => Promise<KhataAccount[]>;
  reauthenticateOwner?: (password: string, totp: string) => Promise<void>;
  /** DEV-290: managers or owners who may approve an over-limit Khata charge with their PIN. */
  loadKhataApprovers?: () => Promise<KhataApprover[]>;
  printKhataStatement?: (familyAccountId: string) => Promise<void>;
  /** DEV-716: find or create the patient, record consent, link and open a 0-limit account. */
  signUpKhata?: (input: KhataSignupInput) => Promise<void>;
  /** The counter's selected patient, offered as the Khata payer. */
  khataSignupPatient?: { patientId: string; displayName: string } | null;
  /** Only a known, current bill has a balance; zero alone is not settlement. */
  balanceMinor: number | null;
  state: CounterTenderBillState;
  blocked: boolean;
  pending?: boolean;
  /** The payment request is held until the connection returns; it has not been sent. */
  queued?: boolean;
  disabled?: boolean;
  error?: string | null;
  initialDraft?: TenderDraft & {
    type: CounterTenderType;
    payerName?: string;
    providerRef?: string;
    referenceSkipped?: boolean;
    approvalCode?: string;
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
      overrideReason?: string;
      overLimitApproval?: { staffProfileId: string; pin: string };
      providerRef?: string;
      payerName?: string;
      referenceSkipped?: boolean;
      approvalCode?: string;
    },
    draft: TenderDraft
  ) => Promise<CounterTenderResult>;
};

/** DEV-290: a manager or owner the till may ask for an over-limit Khata PIN approval. */
export type KhataApprover = { id: string; name: string; self: boolean };
const APPROVER_PIN = /^\d{4,8}$/;

/** A typed money amount (up to two decimals) in minor units, or null when it is not one. */
export function parseAmountMinor(value: string): number | null {
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
      tenders = [],
      confirmedChangeMinor,
      state,
      blocked,
      pending = false,
      queued = false,
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
      loadKhataApprovers,
      printKhataStatement,
      signUpKhata,
      khataSignupPatient,
      manualSettings,
      manualSettingsLoading = false,
      manualSettingsError = false,
      onReloadManualSettings,
      drawerOpen,
    },
    ref
  ) {
    const [accounts, setAccounts] = useState<KhataAccount[]>([]);
    const [accountId, setAccountId] = useState('');
    const [khataLoading, setKhataLoading] = useState(false);
    const [khataError, setKhataError] = useState('');
    const [ownerOverride, setOwnerOverride] = useState(false);
    const [overrideReason, setOverrideReason] = useState('');
    const [password, setPassword] = useState('');
    // DEV-290: approve at this till with a manager's or owner's PIN, or re-enter my password.
    const [approvalMethod, setApprovalMethod] = useState<'PIN' | 'PASSWORD'>('PIN');
    const [approvers, setApprovers] = useState<KhataApprover[] | null>(null);
    const [approversError, setApproversError] = useState(false);
    const [approverId, setApproverId] = useState('');
    const [approverPin, setApproverPin] = useState('');
    const [totp, setTotp] = useState('');
    const [statementPending, setStatementPending] = useState(false);
    const [khataReload, setKhataReload] = useState(0);
    const [signupName, setSignupName] = useState('');
    const [signupPhone, setSignupPhone] = useState('');
    const [signupConsent, setSignupConsent] = useState(false);
    const [signupPending, setSignupPending] = useState(false);
    const [signupError, setSignupError] = useState('');
    const [providerRef, setProviderRef] = useState(initialDraft?.providerRef ?? '');
    const [payerName, setPayerName] = useState(initialDraft?.payerName ?? '');
    const [referenceSkipped, setReferenceSkipped] = useState(
      initialDraft?.referenceSkipped ?? false
    );
    const [approvalCode, setApprovalCode] = useState(initialDraft?.approvalCode ?? '');
    const [type, setType] = useState<CounterTenderType>(initialDraft?.type ?? 'CASH');
    const [amount, setAmount] = useState(initialDraft?.amount ?? '');
    const [cashReceived, setCashReceived] = useState(initialDraft?.cashReceived ?? '');
    const [submitting, setSubmitting] = useState(false);
    const [outcome, setOutcome] = useState<CounterTenderResult | null>(null);
    // An accepted callback may acknowledge a replay. Never sum acknowledgements;
    // the verified receipt supplies the authoritative total across split tenders.
    const [recordedChangeMinor, setRecordedChangeMinor] = useState<number | null>(null);
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
    const offered = TENDER_TYPES.filter(
      (entry) =>
        entry.value === type ||
        entry.offer === 'always' ||
        (entry.offer === 'configured' &&
          !manualSettingsLoading &&
          !manualSettingsError &&
          Boolean(manualSettings?.[entry.value]))
    );
    const cashDrawerClosed = drawerOpen === false;
    // DEV-713 (15 Nov decision): Wallet is its own tender, never taken as Card.
    // Each enabled wallet records its provider and transaction reference.
    const walletOptions = offered.filter((entry) => entry.offer === 'configured');
    const isKhata = type === 'KHATA' || type === 'CREDIT';
    const manual = isManualTender(type);
    const manualCard = type === 'CARD';
    const cardCapture = manualCard
      ? manualCardCaptureSchema.safeParse({ providerRef, approvalCode })
      : null;
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
          if (live)
            setKhataError('Khata accounts could not be loaded. Refresh the bill and retry.');
        })
        .finally(() => {
          if (live) setKhataLoading(false);
        });
      return () => {
        live = false;
      };
    }, [isKhata, loadKhataAccounts, khataReload]);
    const wantsApprovers = isKhata && ownerOverride && Boolean(loadKhataApprovers);
    useEffect(() => {
      if (!wantsApprovers) return;
      let current = true;
      setApprovers(null);
      setApproversError(false);
      void loadKhataApprovers!()
        .then((rows) => {
          if (!current) return;
          setApprovers(rows);
          setApproverId((selected) => (rows.some((row) => row.id === selected) ? selected : ''));
        })
        .catch(() => {
          if (current) setApproversError(true);
        });
      return () => {
        current = false;
      };
    }, [wantsApprovers, loadKhataApprovers]);
    const signupPatient = khataSignupPatient ?? null;
    const signupPatientId = signupPatient?.patientId ?? null;
    // Consent belongs to one person: a different payer must tick it again.
    useEffect(() => {
      setSignupConsent(false);
      setSignupError('');
    }, [signupPatientId]);
    const signupReady =
      editable &&
      !signupPending &&
      signupConsent &&
      (signupPatient !== null ||
        (signupName.trim() !== '' && /^\+?[\d\s-]{7,20}$/.test(signupPhone.trim())));

    async function submitKhataSignup() {
      if (!signUpKhata || !signupReady) return;
      setSignupPending(true);
      setSignupError('');
      try {
        await signUpKhata(
          signupPatient
            ? {
                patientId: signupPatient.patientId,
                displayName: signupPatient.displayName,
                consentGranted: true,
              }
            : { displayName: signupName.trim(), phone: signupPhone.trim(), consentGranted: true }
        );
        setSignupName('');
        setSignupPhone('');
        setSignupConsent(false);
        setKhataReload((value) => value + 1);
      } catch (error) {
        setSignupError(
          error instanceof Error && error.message
            ? error.message
            : 'Khata signup failed. Check the details and retry.'
        );
      } finally {
        setSignupPending(false);
      }
    }
    const submittable =
      editable &&
      !blocked &&
      !(type === 'CASH' && cashDrawerClosed) &&
      amountValid &&
      !cashShort &&
      !cashInvalid &&
      (!manual ||
        (!manualSettingsLoading &&
          !manualSettingsError &&
          Boolean(merchant) &&
          capture?.success === true &&
          (!referenceSkipped || merchant?.allowReferenceSkip === true))) &&
      (!manualCard || cardCapture?.success === true) &&
      (!isKhata ||
        (Boolean(account) &&
          !khataLoading &&
          (!overLimit ||
            (ownerOverride &&
              Boolean(overrideReason.trim()) &&
              (approvalMethod === 'PIN'
                ? Boolean(approverId) && APPROVER_PIN.test(approverPin)
                : Boolean(password) && Boolean(reauthenticateOwner))))));

    // DEV-41: a disabled Take payment button always says why, in cashier words.
    const disabledReason = submittable
      ? null
      : takingPayment
        ? null // The button and the payment status already say a payment is being taken.
        : unknown
          ? 'Check the payment outcome before taking more money.'
          : state === 'idle'
            ? 'Open a bill before taking payment.'
            : state === 'loading'
              ? 'Checking the bill balance…'
              : state === 'settled'
                ? 'This bill is already paid.'
                : state === 'stale' || state === 'error' || !balanceKnown
                  ? 'Refresh the bill to check the balance before taking payment.'
                  : state === 'unavailable'
                    ? 'This bill is not available for payment. Add items or resume the bill.'
                    : disabled
                      ? 'Wait for the current counter action to finish before taking payment.'
                      : blocked
                        ? 'Resolve the safety block in the prescription panel before taking payment.'
                        : type === 'CASH' && cashDrawerClosed
                          ? null // The Cash button already shows and describes the drawer reason.
                          : !amountValid
                            ? 'Enter an amount between 0.01 and the balance due.'
                            : cashInvalid
                              ? 'Enter a valid cash amount with at most two decimal places.'
                              : cashShort
                                ? 'Cash received is less than the amount tendered.'
                                : manual && manualSettingsLoading
                                  ? 'Loading merchant details…'
                                  : manual && (manualSettingsError || !merchant)
                                    ? 'Reload merchant details before taking payment.'
                                    : manual &&
                                        (!capture?.success ||
                                          (referenceSkipped && !merchant?.allowReferenceSkip))
                                      ? 'Enter the payer’s name and 4–6 transaction ID digits, or use the allowed reference skip.'
                                      : manualCard && !cardCapture?.success
                                        ? 'Enter the card reference and approval code from the terminal slip.'
                                        : khataLoading
                                          ? 'Loading Khata accounts…'
                                          : isKhata && !account
                                            ? 'Choose a family Khata account before taking payment.'
                                            : 'A manager or owner must approve the credit limit increase first.';

    async function submitTender() {
      if (!submittable || amountMinor === null || submissionRef.current) return;
      submissionRef.current = true;
      setSubmitting(true);
      setOutcome(null);
      try {
        const pinApproval =
          isKhata && overLimit && approvalMethod === 'PIN'
            ? { staffProfileId: approverId, pin: approverPin }
            : undefined;
        // The PIN is single-use evidence for this attempt: clear it whatever the outcome.
        setApproverPin('');
        if (isKhata && overLimit && !pinApproval) {
          try {
            await reauthenticateOwner!(password, totp);
          } catch {
            setOutcome({
              status: 'rejected',
              message:
                'Owner or manager re-authentication failed. Check password and authentication code.',
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
              ? {
                  familyAccountId: accountId,
                  ownerOverride: overLimit && ownerOverride,
                  ...(overLimit && ownerOverride ? { overrideReason: overrideReason.trim() } : {}),
                  ...(pinApproval ? { overLimitApproval: pinApproval } : {}),
                }
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
            ...(manualCard && cardCapture?.success ? cardCapture.data : {}),
          },
          { amount, cashReceived: type === 'CASH' ? cashReceived : '' }
        );
        setOutcome(result);
        if (result.status === 'accepted') {
          if (changeMinor !== null && changeMinor > 0) setRecordedChangeMinor(changeMinor);
          setAmount('');
          setCashReceived('');
          setProviderRef('');
          setPayerName('');
          setReferenceSkipped(false);
          setOverrideReason('');
          setApprovalCode('');
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
          if (result.changeMinor !== undefined && result.changeMinor > 0)
            setRecordedChangeMinor(result.changeMinor);
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

    const renderTenderButton = (entry: (typeof TENDER_TYPES)[number]) => {
      const active = entry.value === type;
      const drawerNote = entry.value === 'CASH' && cashDrawerClosed;
      return (
        <div key={entry.value} className="min-w-0 space-y-1">
          <Button
            type="button"
            size="touch"
            variant={active ? 'secondary' : 'outline'}
            className="w-full rounded-sm"
            aria-pressed={active}
            aria-describedby={drawerNote ? 'tender-cash-drawer' : undefined}
            disabled={!editable}
            onClick={() => {
              if (active) return;
              setType(entry.value);
              setProviderRef('');
              setPayerName('');
              setReferenceSkipped(false);
              setApprovalCode('');
            }}
          >
            {active ? <Check data-icon="inline-start" aria-hidden="true" /> : null}
            {entry.label}
          </Button>
          {drawerNote ? (
            <p id="tender-cash-drawer" className="text-xs text-destructive">
              {COUNTER_CASH_DRAWER_CLOSED_MESSAGE}
            </p>
          ) : null}
        </div>
      );
    };

    return (
      <div ref={ref} tabIndex={-1} className="min-w-0 space-y-5 focus-visible:outline-none">
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

        <CounterChangeDue minor={confirmedChangeMinor ?? recordedChangeMinor} />

        {tenders.length > 0 ? (
          <ol aria-label="Recorded tenders" className="space-y-2">
            {tenders.map((tender, index) => (
              <li
                key={tender.tenderId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-border-subtle bg-surface-card px-3 py-2 text-sm"
              >
                <span className="text-text-body">
                  {index + 1}.{' '}
                  {tender.type === 'CREDIT' || tender.type === 'KHATA'
                    ? 'Khata'
                    : (TENDER_TYPES.find((entry) => entry.value === tender.type)?.label ??
                      tender.type)}{' '}
                  · Recorded
                </span>
                <span className="font-mono tabular-nums text-text-strong">
                  {formatMinor(tender.amountMinor)}
                </span>
              </li>
            ))}
          </ol>
        ) : null}

        <p
          ref={statusRef}
          tabIndex={-1}
          id="tender-status"
          role="status"
          aria-live="polite"
          className="text-sm leading-relaxed text-text-body focus-visible:outline-ring"
        >
          {takingPayment
            ? queued
              ? 'Offline — this payment will be sent when the connection returns. Keep this bill open and do not take the money again.'
              : 'Taking payment… Keep this bill open.'
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
          <p id="tender-type-label" className="text-sm leading-none font-medium select-none">
            Payment method
          </p>
          <div
            role="group"
            aria-labelledby="tender-type-label"
            className="grid grid-cols-2 items-start gap-2 sm:grid-cols-3"
          >
            {offered.filter((entry) => entry.offer !== 'configured').map(renderTenderButton)}
            {walletOptions.length ? (
              <div
                role="group"
                aria-labelledby="tender-wallet-label"
                className="col-span-full space-y-1.5 border-t border-border-subtle pt-2"
              >
                <p id="tender-wallet-label" className="text-xs font-medium text-text-muted">
                  Wallet
                </p>
                <div className="grid grid-cols-2 items-start gap-2 sm:grid-cols-3">
                  {walletOptions.map(renderTenderButton)}
                </div>
              </div>
            ) : null}
          </div>
          {manualSettingsError && !manual ? (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-sm text-text-muted">
                Wallet merchant details could not be loaded, so JazzCash, Easypaisa and Raast are
                hidden.
              </p>
              {onReloadManualSettings ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 rounded-sm"
                  disabled={takingPayment || manualSettingsLoading}
                  onClick={onReloadManualSettings}
                >
                  Reload merchant details
                </Button>
              ) : null}
            </div>
          ) : null}
          {selected.requiresAdapter ? (
            <p className="text-sm text-text-muted">
              A payment provider must be connected before you can use this method. Ask your manager
              if it is unavailable.
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
            payment methods.
          </p>
          {state === 'ready' && amount.trim() !== '' && !amountValid ? (
            <p id="tender-amount-error" className="text-sm text-destructive" role="alert">
              Enter an amount between 0.01 and the balance due.
            </p>
          ) : null}
          {editable && amountValid && amountMinor! < balanceMinor! ? (
            <p className="text-sm text-text-body" aria-live="polite">
              {tenders.length > 0 ? `Tender ${tenders.length + 1}. ` : ''}Remaining after this
              tender{' '}
              <span className="font-mono tabular-nums text-text-strong">
                {formatMinor(balanceMinor! - amountMinor!)}
              </span>
            </p>
          ) : null}
        </div>

        {manualCard ? (
          <div className="space-y-3 rounded-md border border-border-default bg-surface-sunken p-4">
            <p className="text-sm text-text-muted">
              Take the card on the shop’s terminal first. Enter the details from the approved slip;
              you are recorded as the person who confirmed this payment. Take JazzCash, Easypaisa or
              Raast under Wallet, not Card.
            </p>
            <Label htmlFor="manual-card-reference">Card last 4 digits or terminal reference</Label>
            <Input
              id="manual-card-reference"
              className="min-h-11 font-mono"
              autoComplete="off"
              value={providerRef}
              maxLength={24}
              disabled={!editable}
              aria-invalid={providerRef !== '' && !MANUAL_CARD_REFERENCE.test(providerRef.trim())}
              aria-describedby="manual-card-help"
              onChange={(event) => setProviderRef(event.target.value)}
            />
            <Label htmlFor="manual-card-approval">Approval code</Label>
            <Input
              id="manual-card-approval"
              className="min-h-11 font-mono"
              autoComplete="off"
              value={approvalCode}
              maxLength={12}
              disabled={!editable}
              aria-invalid={
                approvalCode !== '' && !MANUAL_CARD_APPROVAL_CODE.test(approvalCode.trim())
              }
              aria-describedby="manual-card-help"
              onChange={(event) => setApprovalCode(event.target.value)}
            />
            <p id="manual-card-help" className="text-sm text-text-muted">
              Letters and digits only: 4–24 for the reference, 2–12 for the approval code. Never
              enter the full card number.
            </p>
          </div>
        ) : null}

        {manual ? (
          <div className="space-y-3 rounded-md border border-border-default bg-surface-sunken p-4">
            {manualSettingsLoading ? <p role="status">Loading merchant details…</p> : null}
            {manualSettingsError ? <p role="alert">Merchant details could not be loaded.</p> : null}
            {!manualSettingsLoading && !manualSettingsError && !merchant ? (
              <p role="alert">
                {type} is not enabled at this branch. Ask an administrator to enable it in Finance.
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
            {merchant ? (
              <>
                <p className="font-mono text-lg tabular-nums">
                  {amountMinor === null ? 'Enter amount' : `PKR ${formatMinor(amountMinor)}`}
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
                  Confirm receipt in the merchant bank or wallet account before taking payment; you
                  are recorded as the person who confirmed it.
                  {merchant.qrImageDataUrl
                    ? ' This QR is static; the payer enters the amount shown.'
                    : ''}
                </p>
                <Label htmlFor="manual-payer-name">Payer’s name</Label>
                <Input
                  id="manual-payer-name"
                  className="min-h-11"
                  value={payerName}
                  maxLength={100}
                  disabled={!editable}
                  onChange={(event) => setPayerName(event.target.value)}
                />
                <Label htmlFor="manual-provider-reference">Transaction ID (last 4–6 digits)</Label>
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
                    ? 'Reference explicitly skipped under branch policy.'
                    : 'Enter 4–6 digits from the payer’s transaction ID.'}
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
              signUpKhata ? (
                <div className="space-y-3">
                  <p className="text-sm text-text-body">
                    No Khata account on this bill. Sign the customer up to open one.
                  </p>
                  {signupPatient ? (
                    <p className="text-sm text-text-strong">Payer: {signupPatient.displayName}</p>
                  ) : (
                    <>
                      <Label htmlFor="khata-signup-name">Customer name</Label>
                      <Input
                        id="khata-signup-name"
                        className="h-11 rounded-sm"
                        autoComplete="off"
                        value={signupName}
                        maxLength={200}
                        disabled={!editable || signupPending}
                        onChange={(event) => {
                          setSignupName(event.target.value);
                          setSignupConsent(false);
                        }}
                      />
                      <Label htmlFor="khata-signup-phone">Phone</Label>
                      <Input
                        id="khata-signup-phone"
                        className="h-11 rounded-sm"
                        type="tel"
                        inputMode="tel"
                        autoComplete="off"
                        value={signupPhone}
                        maxLength={20}
                        disabled={!editable || signupPending}
                        onChange={(event) => {
                          setSignupPhone(event.target.value);
                          setSignupConsent(false);
                        }}
                      />
                    </>
                  )}
                  <Label className="flex min-h-11 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={signupConsent}
                      disabled={!editable || signupPending}
                      onChange={(event) => setSignupConsent(event.target.checked)}
                    />
                    Customer consents to a Khata account and loyalty record
                  </Label>
                  <p className="text-sm text-text-muted">
                    The credit limit starts at {formatMinor(0)}. An owner must authorize any higher
                    limit.
                  </p>
                  {signupError ? (
                    <p role="alert" className="text-sm text-destructive">
                      {signupError}
                    </p>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 rounded-sm"
                    disabled={!signupReady}
                    onClick={() => void submitKhataSignup()}
                  >
                    {signupPending ? 'Opening Khata…' : 'Open Khata account'}
                  </Button>
                </div>
              ) : (
                <p>Link a customer with an active family account before using Khata.</p>
              )
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
                  This charge exceeds the family credit limit. A manager or owner must give a reason
                  and approve raising the limit to{' '}
                  {formatMinor(account!.balanceMinor + amountMinor!)}.
                </p>
                <Label className="flex min-h-11 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={ownerOverride}
                    disabled={!editable}
                    onChange={(event) => setOwnerOverride(event.target.checked)}
                  />
                  Owner or manager: authorize limit increase
                </Label>
                {ownerOverride ? (
                  <>
                    <Label htmlFor="khata-override-reason">Reason for exceeding the limit</Label>
                    <Textarea
                      id="khata-override-reason"
                      required
                      maxLength={500}
                      value={overrideReason}
                      disabled={!editable}
                      onChange={(event) => setOverrideReason(event.target.value)}
                      className="min-h-11 rounded-sm"
                    />
                    <fieldset className="space-y-2">
                      <legend className="text-sm font-medium text-text-strong">Approval</legend>
                      <Label className="flex min-h-11 items-center gap-2">
                        <input
                          type="radio"
                          name="khata-approval-method"
                          checked={approvalMethod === 'PIN'}
                          disabled={!editable}
                          onChange={() => setApprovalMethod('PIN')}
                        />
                        Manager or owner PIN at this till
                      </Label>
                      {reauthenticateOwner ? (
                        <Label className="flex min-h-11 items-center gap-2">
                          <input
                            type="radio"
                            name="khata-approval-method"
                            checked={approvalMethod === 'PASSWORD'}
                            disabled={!editable}
                            onChange={() => setApprovalMethod('PASSWORD')}
                          />
                          I am the only owner or manager: re-enter my password
                        </Label>
                      ) : null}
                    </fieldset>
                    {approvalMethod === 'PIN' ? (
                      <>
                        <Label htmlFor="khata-approver">Approving manager or owner</Label>
                        <select
                          id="khata-approver"
                          className="h-11 w-full rounded-md border border-border-subtle bg-surface-raised px-3 focus-visible:outline-2 focus-visible:outline-ring"
                          disabled={!editable || approvers === null || approversError}
                          value={approverId}
                          onChange={(event) => {
                            setApproverId(event.target.value);
                            setApproverPin('');
                          }}
                        >
                          <option value="">Select manager or owner</option>
                          {(approvers ?? []).map((approver) => (
                            <option key={approver.id} value={approver.id}>
                              {approver.self ? `${approver.name} (you)` : approver.name}
                            </option>
                          ))}
                        </select>
                        {approversError ? (
                          <p role="alert" className="text-sm text-destructive">
                            Approvers could not be loaded. Untick and tick the approval box to
                            retry.
                          </p>
                        ) : approvers === null ? (
                          <p role="status">Loading approvers…</p>
                        ) : approvers.length === 0 ? (
                          <p role="status">
                            No manager or owner has an active staff PIN. Ask your administrator to
                            set one up.
                          </p>
                        ) : null}
                        <Label htmlFor="khata-approver-pin">Approver PIN</Label>
                        <Input
                          id="khata-approver-pin"
                          type="password"
                          inputMode="numeric"
                          autoComplete="off"
                          maxLength={8}
                          value={approverPin}
                          disabled={!editable || !approverId}
                          onChange={(event) =>
                            setApproverPin(event.target.value.replace(/\D/g, ''))
                          }
                          className="h-11 rounded-sm"
                        />
                      </>
                    ) : (
                      <>
                        <Label htmlFor="khata-password">Your password (current account)</Label>
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
                          Authentication or recovery code (if enabled)
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
                    )}
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

        {disabledReason ? (
          <p id="tender-disabled-reason" className="text-sm text-text-muted">
            {disabledReason}
          </p>
        ) : null}
        <Button
          type="button"
          className="min-h-12 w-full rounded-sm"
          disabled={!submittable}
          aria-describedby={[
            'tender-status tender-error',
            blocked ? 'tender-blocked' : '',
            type === 'CASH' && cashDrawerClosed ? 'tender-cash-drawer' : '',
            disabledReason ? 'tender-disabled-reason' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => void submitTender()}
        >
          {takingPayment ? 'Taking payment…' : 'Take payment'}
        </Button>
      </div>
    );
  }
);
