'use client';

import { browserUuid } from '@/lib/browser-uuid';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { signIn, useSession } from 'next-auth/react';
import { useEntitlements } from '@/components/entitlements-provider';
import { evaluateSessionUser } from '@/lib/auth/session-state';
import { isModuleGranted } from '@/lib/module-catalog';
import {
  clearTenderAttempt,
  persistTenderAttempt,
  readTenderAttempt,
  tenderAttemptStorageKey,
  TENDER_STORAGE_MESSAGE,
  type TenderAttempt,
  type TenderAttemptScope,
  type TenderDraft,
} from './tender-attempt-storage';

import {
  COUNTER_OVERRIDE_APPROVAL_POLICY,
  CounterCartPanel,
  CounterLotOverride,
  type CounterLotOverrideValue,
} from './counter-cart';
import { CounterKeymapLegend } from './counter-keymap-legend';
import {
  CounterReceiptView,
  type CounterReceiptPresentationResult,
  type CounterReceiptSettlement,
} from './counter-receipt-view';
import { CounterReturnPanel } from './counter-return-panel';
import { CounterRxPanel } from './counter-rx-panel';
import { CounterSearchResults } from './counter-search-results';
import { CounterSubstituteProposals } from './counter-substitute-proposals';
import {
  CounterTenderPanel,
  type CounterTenderType,
  type CounterTenderResult,
  type CounterTenderBillState,
} from './counter-tender-panel';
import { CounterUnitToggle } from './counter-unit-toggle';
import { CounterUpsellSuggestions } from './counter-upsell-suggestions';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import type { CounterCart, CounterSearchRow } from '@/lib/pharmacy/counter';
import {
  counterAlertsFor,
  hasBlockingAlert,
  type CounterAlertLine,
} from '@/lib/pharmacy/counter-alerts';
import {
  COUNTER_ACTION_LABELS,
  formatBinding,
  matchCounterAction,
  resolveCounterKeymap,
  shouldHandleCounterKey,
  type CounterAction,
  type CounterKeymapPresetKey,
} from '@/lib/pharmacy/counter-keymap';
import { COUNTER_ERROR_MESSAGES, counterErrorMessage } from '@/lib/pharmacy/counter-messages';
import { PaymentSandboxPanel } from './payment-sandbox-panel';
import { refreshCounterQueries } from '@/lib/pharmacy/counter-query-refresh';
import { previewSaleLine, type SaleUnitKind } from '@/lib/pharmacy/counter-pricing';
import { formatMinor, type CounterReceiptLocale } from '@/lib/pharmacy/counter-receipt';
import {
  buildCounterBrowserReceipt,
  printCounterBrowserReceipt,
  reserveCounterBrowserPrint,
  type CounterBrowserPrintReservation,
  type CounterReceiptFormat,
} from '@/lib/pharmacy/counter-browser-print';
import { workspaceToday } from '@/lib/timezone';
import { trpc } from '@/lib/trpc';

type Notice = {
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  message: string;
  inventoryBranchId?: string;
};

type ReceiptIntent = {
  saleId: string;
  branchId: string;
  receiptNumber: number | null;
  autoPrint: boolean;
  printReservation?: CounterBrowserPrintReservation;
};

/**
 * A stable per-browser identifier for the drawer session and receipt sequence.
 *
 * The counter is a workspace page rather than an enrolled terminal, so there is
 * no device record to borrow. Receipt numbers are per (branch, device), so the
 * id must survive a reload — a fresh id every load would restart the sequence
 * and hand two bills the same receipt number.
 *
 * Read on demand rather than held in state: `localStorage` does not exist
 * during the server render, and mirroring it into React state would only add a
 * cascading render to reach the same value.
 */
function counterDeviceId(): string {
  const key = 'devfathom.pharmacy.counter.device';
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const created = `counter-${browserUuid()}`;
  window.localStorage.setItem(key, created);
  return created;
}

const subscribeToNothing = () => () => {};
/** `null` when storage is unavailable: the tender path reports that case itself. */
function readCounterDeviceId(): string | null {
  try {
    return counterDeviceId();
  } catch {
    return null;
  }
}
/**
 * The device id as render-time state: `null` on the server render (there is no
 * storage), the stable browser id on the client. Lets the drawer status query
 * key on the device without a setState-in-effect round trip.
 */
function useCounterDeviceId(): string | null {
  return useSyncExternalStore(subscribeToNothing, readCounterDeviceId, () => null);
}

/**
 * Today in the workspace's zone, as the date-only value the settlement tables
 * store: the day the day close opens on, whatever zone this device is set to.
 * `workspaceToday` reads a missing or refused zone as UTC, as the close does.
 */
function businessDate(timeZone: string | null | undefined): Date {
  return new Date(`${workspaceToday(timeZone)}T00:00:00.000Z`);
}

/**
 * UX rule 11: the counter never shows the operator a raw reason code. The
 * mapping itself lives in `counter-messages` so it can be tested without the
 * console's client-side dependencies.
 */
const messageFrom = counterErrorMessage;

function hasValidBill(
  cart: CounterCart | null | undefined,
  saleId: string | null
): cart is CounterCart {
  return Boolean(
    saleId &&
    cart?.saleId === saleId &&
    Number.isSafeInteger(cart.totals.netMinor) &&
    cart.totals.netMinor >= 0 &&
    Number.isSafeInteger(cart.totals.tenderedMinor) &&
    cart.totals.tenderedMinor >= 0 &&
    cart.totals.tenderedMinor <= cart.totals.netMinor
  );
}

function tenderAcknowledgement(value: unknown): value is {
  tenderId: string;
  settled: boolean;
  remainingMinor: number;
  receiptNumber: number | null;
} {
  if (!value || typeof value !== 'object') return false;
  return (
    'tenderId' in value &&
    typeof value.tenderId === 'string' &&
    value.tenderId.length > 0 &&
    'remainingMinor' in value &&
    typeof value.remainingMinor === 'number' &&
    Number.isSafeInteger(value.remainingMinor) &&
    value.remainingMinor >= 0 &&
    'settled' in value &&
    typeof value.settled === 'boolean' &&
    value.settled === (value.remainingMinor === 0) &&
    'receiptNumber' in value &&
    (value.settled
      ? typeof value.receiptNumber === 'number' &&
        Number.isSafeInteger(value.receiptNumber) &&
        value.receiptNumber > 0
      : value.receiptNumber === null)
  );
}

function tenderRejected(error: unknown): boolean {
  // These server refusals roll back the transaction. Transport, timeout and
  // internal failures cannot prove that no money moved.
  if (!(error instanceof Error) || !('data' in error)) return false;
  const data = error.data;
  return Boolean(
    data &&
    typeof data === 'object' &&
    'code' in data &&
    ['BAD_REQUEST', 'FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND', 'CONFLICT'].includes(
      String(data.code)
    )
  );
}

const UNKNOWN_TENDER_MESSAGE =
  'Payment outcome is unknown. The original attempt is saved in this browser. Check payment outcome before taking more money. Refreshing the bill will not retry the payment.';

type ConsoleProps = { initialSaleId?: string | null; initialBranchId?: string };

function counterSelectionPreview(
  row: CounterSearchRow | null,
  option: CounterSearchRow['saleUnits'][number] | null,
  quantity: number
) {
  if (!row || !option || row.printedMrpMinor === null || row.unitsPerPack === null) return null;
  try {
    return previewSaleLine({
      option,
      quantity,
      printedMrpMinor: row.printedMrpMinor,
      unitsPerPack: row.unitsPerPack,
      roundingIncrementMinor: row.roundingIncrementMinor,
      availableUnits: row.onHandUnits,
    });
  } catch {
    return null;
  }
}

export function PharmacyCounterConsole(props: ConsoleProps = {}) {
  const { data: session, status } = useSession();
  const entitlements = useEntitlements();
  const user = session?.user;
  // Remount on account/tenant changes so neither drafts nor an in-flight read's
  // response can become another operator's recovery UI. Server remains authority.
  if (
    status !== 'authenticated' ||
    !evaluateSessionUser(user).ok ||
    !user?.id ||
    !user.organizationId ||
    user.organizationId !== entitlements.organizationId ||
    !isModuleGranted('pharmacy-counter', entitlements.enabledModules)
  ) {
    return (
      <SectionCard title="Counter unavailable">
        <p role="status" className="text-sm text-text-body">
          {status === 'loading'
            ? 'Checking counter access…'
            : 'Sign in with an authorized pharmacy account to open this counter.'}
        </p>
      </SectionCard>
    );
  }
  return (
    <ScopedPharmacyCounterConsole
      {...props}
      key={JSON.stringify([user.organizationId, user.id])}
      organizationId={user.organizationId}
      accountId={user.id}
      evidenceAuthorized={user.role === 'ADMIN'}
      safetyLicensed={isModuleGranted('pharmacy-safety', entitlements.enabledModules)}
      accountEmail={user.email}
    />
  );
}

/**
 * PH-POS counter — POS-01, POS-02, POS-08 and POS-09 in one keyboard-first
 * surface.
 *
 * The whole bill is composable without a pointer: the scan field holds focus
 * for the life of the bill, the F-key map reaches every workflow, and the
 * prescription panel sits beside the cart so an authorization check never
 * navigates away from a half-composed sale.
 */
function ScopedPharmacyCounterConsole({
  initialSaleId = null,
  initialBranchId = '',
  organizationId,
  accountId,
  evidenceAuthorized = false,
  safetyLicensed,
  accountEmail,
}: ConsoleProps & {
  organizationId: string;
  accountId: string;
  evidenceAuthorized?: boolean;
  /** Pharmacy Safety owns the approving-pharmacist list; without it that read is refused. */
  safetyLicensed: boolean;
  accountEmail: string;
}) {
  const utils = trpc.useUtils();

  const [selectedBranchId, setSelectedBranchId] = useState(initialBranchId);
  const [query, setQuery] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState({ text: '', query: '', branchId: '' });
  const submittedQuery = submittedSearch.query;
  const scannerRevision = useRef(0);
  const scannerInFlight = useRef<{ text: string; branchId: string; revision: number } | null>(
    null
  );
  const [activeRow, setActiveRow] = useState<CounterSearchRow | null>(null);
  const [saleUnit, setSaleUnit] = useState<SaleUnitKind | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [lotOverride, setLotOverride] = useState<CounterLotOverrideValue | null>(null);
  const [saleId, setSaleId] = useState<string | null>(initialSaleId);
  const [heldSaleId, setHeldSaleId] = useState<string | null>(null);
  const [patientQuery, setPatientQuery] = useState('');
  const [submittedPatientQuery, setSubmittedPatientQuery] = useState('');
  const [controlledAuth, setControlledAuth] = useState({
    prescriptionLineId: '',
    staffProfileId: '',
    pin: '',
    rxSerialWritten: false,
    emergency: false,
    prescriberName: '',
    prescriberRegNo: '',
    refSerial: '',
  });
  const pharmacistsQuery = trpc.pharmacySafety.controlledPharmacists.useQuery(undefined, {
    enabled: safetyLicensed,
  });
  const [patientId, setPatientId] = useState<string | null>(null);
  const [patientAddressDraft, setPatientAddressDraft] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [redeemPoints, setRedeemPoints] = useState(0);
  const [receiptLocale, setReceiptLocale] = useState<CounterReceiptLocale>('en');
  const [receiptFormat, setReceiptFormat] = useState<CounterReceiptFormat>('THERMAL');
  const [receiptRenders, setReceiptRenders] = useState(0);
  const [autoPrint, setAutoPrint] = useState(false);
  const [receiptSettlement, setReceiptSettlement] = useState<CounterReceiptSettlement | null>(null);
  const receiptIntent = useRef<ReceiptIntent | null>(null);
  const autoPrintRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [tenderOutcome, setTenderOutcome] = useState<CounterTenderResult | null>(null);
  const [tenderReadRequired, setTenderReadRequired] = useState(false);
  const [refreshingTenderBill, setRefreshingTenderBill] = useState(false);
  const tenderInFlight = useRef(false);
  const [recoveryBranch, setRecoveryBranch] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [attempt, setAttempt] = useState<TenderAttempt | null>(null);
  const attemptRef = useRef<TenderAttempt | null>(null);
  const [restoredAttempt, setRestoredAttempt] = useState<TenderAttempt | null>(null);
  const [checkingOutcome, setCheckingOutcome] = useState(false);
  const outcomeInFlight = useRef(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const rxPanelRef = useRef<HTMLDivElement>(null);
  const tenderRef = useRef<HTMLDivElement>(null);

  // ── Data ──────────────────────────────────────────────────────────────────

  const branchesQuery = trpc.pharmacySales.counterBranches.useQuery(undefined, {
    staleTime: 60_000,
  });
  const branches = useMemo(() => branchesQuery.data?.branches ?? [], [branchesQuery.data]);
  // Every drawer, tender and loyalty write is stamped with the workspace's day.
  const workspaceZone = branchesQuery.data?.timezone;
  const todayBusinessDate = useCallback(() => businessDate(workspaceZone), [workspaceZone]);

  // Derived, not mirrored into state: the default branch is simply "the first
  // one" until the operator picks another, so an effect would only add a render.
  const branchId = selectedBranchId || (branches[0]?.id ?? '');
  const recoveryScope = useMemo<TenderAttemptScope>(
    () => ({ organizationId, accountId, branchId }),
    [organizationId, accountId, branchId]
  );
  const branchAuthorized =
    branchesQuery.isSuccess &&
    !branchesQuery.isError &&
    branches.some((branch) => branch.id === branchId);

  useEffect(
    () => () => {
      scannerRevision.current += 1;
    },
    [branchAuthorized, branchId]
  );

  const discardReceiptIntent = useCallback(() => {
    receiptIntent.current?.printReservation?.cancel();
    receiptIntent.current = null;
  }, []);

  // A reserved window belongs only to this mounted operator/branch session.
  useEffect(() => discardReceiptIntent, [branchAuthorized, branchId, discardReceiptIntent]);

  const receiptPresented = useCallback(
    (result: CounterReceiptPresentationResult) => {
      const intent = receiptIntent.current;
      if (intent?.saleId !== result.saleId || intent.receiptNumber !== result.receiptNumber) return;
      discardReceiptIntent();
      setReceiptSettlement(null);
      if (result.printStatus === 'dialog-requested') setReceiptRenders((count) => count + 1);
    },
    [discardReceiptIntent]
  );

  useEffect(() => {
    if (!branchAuthorized) return;
    const discover = () => {
      let saved = readTenderAttempt(recoveryScope);
      // A normal reload has no sale/branch URL. Inspect only keys for branches
      // returned by this account's authorized query; never enumerate storage.
      if (
        saved.status === 'empty' &&
        !attemptRef.current &&
        !initialBranchId &&
        !selectedBranchId
      ) {
        for (const branch of branches) {
          if (branch.id === branchId) continue;
          const candidate = readTenderAttempt({ ...recoveryScope, branchId: branch.id });
          if (candidate.status !== 'empty') {
            saved = candidate;
            break;
          }
        }
      }
      setRecoveryBranch(branchId);
      if (saved.status === 'blocked') {
        setStorageError(true);
        return;
      }
      // An external deletion never resolves a mounted uncertain payment.
      if (saved.status === 'empty' && attemptRef.current) return;
      setStorageError(false);
      if (saved.status === 'pending') {
        if (attemptRef.current) return;
        attemptRef.current = saved.attempt;
        setAttempt(saved.attempt);
        setRestoredAttempt(saved.attempt);
        setSelectedBranchId(saved.attempt.input.branchId);
        setSaleId(saved.attempt.input.saleId);
        setTenderOutcome({ status: 'unknown', message: UNKNOWN_TENDER_MESSAGE });
        setTenderReadRequired(true);
      }
    };
    discover();
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === tenderAttemptStorageKey(recoveryScope)) discover();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [branchAuthorized, branchId, branches, initialBranchId, recoveryScope, selectedBranchId]);

  const keymapQuery = trpc.pharmacySales.counterKeymap.useQuery(undefined, { staleTime: 300_000 });
  const keymap = keymapQuery.data ?? resolveCounterKeymap({ preset: 'devfathom' });
  const saveKeymap = trpc.pharmacySales.counterSaveKeymap.useMutation({
    onSuccess: () => {
      void utils.pharmacySales.counterKeymap.invalidate();
      setNotice({ tone: 'success', message: 'Keymap saved for this operator.' });
    },
    onError: (error) => setNotice({ tone: 'danger', message: messageFrom(error) }),
  });

  const trimmedQuery = query.trim();
  const scannerQuery = trimmedQuery.startsWith(']d2') || trimmedQuery.startsWith('(01)');
  const searchCurrent =
    branchAuthorized &&
    trimmedQuery.length >= 2 &&
    submittedSearch.text === trimmedQuery &&
    submittedSearch.branchId === branchId;

  useEffect(() => {
    if (!branchAuthorized || trimmedQuery.length < 2 || scannerQuery || searchCurrent) return;
    const timer = window.setTimeout(() => {
      setSubmittedSearch({ text: trimmedQuery, query: trimmedQuery, branchId });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [branchAuthorized, branchId, scannerQuery, searchCurrent, trimmedQuery]);

  const searchQuery = trpc.pharmacySales.counterSearch.useQuery(
    { branchId, query: submittedQuery },
    { enabled: searchCurrent && submittedQuery.length >= 2, staleTime: 10_000 }
  );

  const cartQuery = trpc.pharmacySales.counterCart.useQuery(
    { branchId, saleId: saleId ?? '' },
    { enabled: Boolean(branchId && saleId), staleTime: 30_000 }
  );

  // POS-07: one OPEN drawer per counter device. The header offers "Open drawer"
  // only once the server has said this device has none; while one is open it
  // shows the drawer instead, so a second open is never offered.
  const deviceId = useCounterDeviceId();
  const drawerQuery = trpc.pharmacySales.drawerStatus.useQuery(
    { branchId, deviceId: deviceId ?? '' },
    { enabled: Boolean(branchAuthorized && branchId && deviceId), staleTime: 30_000 }
  );
  const openDrawerSession = drawerQuery.data?.openDrawer ?? null;
  const drawerStatusKnown = drawerQuery.isSuccess || drawerQuery.isError;

  const receiptQuery = trpc.pharmacySales.counterReceipt.useQuery(
    { branchId, saleId: saleId ?? '' },
    { enabled: Boolean(branchId && saleId) && cartQuery.data?.status === 'COMPLETED' }
  );

  // Owner-only stills: a disabled query still returns cached data, so cached
  // images are dropped (not just hidden) once owner eligibility is revoked. A
  // failed read (access lost mid-session) withholds stills until a fresh read
  // succeeds; resetting there would refetch the active query in a loop.
  const evidenceEligible =
    evidenceAuthorized && Boolean(branchId && saleId) && cartQuery.data?.status === 'COMPLETED';
  const evidenceQuery = trpc.pharmacySales.counterEvidence.useQuery(
    { branchId, saleId: saleId ?? '' },
    { enabled: evidenceEligible, retry: false }
  );
  useEffect(() => {
    if (!evidenceAuthorized) void utils.pharmacySales.counterEvidence.reset();
  }, [evidenceAuthorized, utils]);

  const patientsQuery = trpc.pharmacyPrescriptions.counterPatients.useQuery(
    { query: submittedPatientQuery },
    { enabled: submittedPatientQuery.trim().length >= 2 && patientId === null }
  );

  const patientPanelQuery = trpc.pharmacyPrescriptions.counterPatientPanel.useQuery(
    { patientId: patientId ?? '' },
    { enabled: patientId !== null }
  );
  const lotOptionsQuery = trpc.pharmacySales.counterLotOptions.useQuery(
    { branchId, medicineId: activeRow?.medicineId ?? '' },
    { enabled: Boolean(branchId && activeRow) && lotOverride !== null }
  );
  const customerQuery = trpc.pharmacySales.customerSnapshot.useQuery(
    { branchId, customerId: customerId ?? '' },
    { enabled: Boolean(branchId && customerId) }
  );

  // ── Mutations ─────────────────────────────────────────────────────────────

  const createSale = trpc.pharmacySales.create.useMutation();
  const addLine = trpc.pharmacySales.addLine.useMutation();
  const transition = trpc.pharmacySales.transition.useMutation();
  const tender = trpc.pharmacySales.tender.useMutation({ retry: false });
  const manualSettings = trpc.pharmacySales.manualPaymentSettings.useQuery(
    { branchId }, { enabled: Boolean(branchId) }
  );
  const openDrawer = trpc.pharmacySales.openDrawer.useMutation();
  const captureDemand = trpc.pharmacySales.captureDemand.useMutation();
  const declineSubstitute = trpc.pharmacySales.declineSubstitute.useMutation();
  const linkCustomer = trpc.pharmacySales.linkCustomer.useMutation();
  const redeemLoyalty = trpc.pharmacySales.redeemPoints.useMutation();
  const authenticatePack = trpc.pharmacySales.authenticatePack.useMutation();

  const refreshCart = useCallback(async () => {
    await refreshCounterQueries(utils.pharmacySales);
  }, [utils]);

  const setActiveSale = useCallback(
    (nextSaleId: string | null) => {
      discardReceiptIntent();
      setReceiptSettlement(null);
      setSaleId(nextSaleId);
      setReceiptRenders(0);
      setCustomerId(null);
      setRedeemPoints(0);
      setTenderOutcome(null);
      setTenderReadRequired(false);
      setRestoredAttempt(null);
    },
    [discardReceiptIntent]
  );

  // ── Derived state ─────────────────────────────────────────────────────────

  const cart = cartQuery.data ?? null;
  const patient = patientPanelQuery.data ?? null;
  const patientAddress = patientAddressDraft ?? patient?.address ?? '';

  const selectedOption = useMemo(
    () => activeRow?.saleUnits.find((option) => option.kind === saleUnit) ?? null,
    [activeRow, saleUnit]
  );

  const preview = useMemo(
    () => counterSelectionPreview(activeRow, selectedOption, quantity),
    [activeRow, quantity, selectedOption]
  );

  const requestedCanonicalUnits = selectedOption
    ? selectedOption.canonicalUnitsPerSaleUnit * quantity
    : activeRow?.saleUnits.length === 0
      ? quantity
      : null;
  const shortfallUnits =
    activeRow &&
    requestedCanonicalUnits !== null &&
    Number.isSafeInteger(requestedCanonicalUnits) &&
    requestedCanonicalUnits > 0
      ? Math.max(0, requestedCanonicalUnits - activeRow.onHandUnits)
      : 0;
  const substituteInput =
    activeRow &&
    selectedOption &&
    requestedCanonicalUnits !== null &&
    activeRow.onHandUnits < requestedCanonicalUnits
      ? {
          branchId,
          medicineId: activeRow.medicineId,
          presentationId: activeRow.presentationId,
          quantityCanonicalUnits: requestedCanonicalUnits,
          ...(preview ? { referencePriceMinor: preview.unitPriceMinor } : {}),
        }
      : null;
  const substitutesQuery = trpc.pharmacySales.substituteProposals.useQuery(
    substituteInput ?? {
      branchId,
      medicineId: '',
      presentationId: '',
      quantityCanonicalUnits: 1,
    },
    { enabled: substituteInput !== null }
  );

  /**
   * POS-09 alerts for the composed bill.
   *
   * Built from the cart the server returned plus the prescription panel, so an
   * alert always describes a line that really exists and an authorization that
   * really was signed.
   */
  const alerts = useMemo(() => {
    const lines: CounterAlertLine[] = (cart?.lines ?? []).map((line) => {
      const prescriptionLine = patient?.prescriptions
        .flatMap((prescription) => prescription.lines.map((entry) => ({ prescription, entry })))
        .find(({ entry }) => entry.medicineId === line.medicineId);
      return {
        ref: line.saleLineId,
        medicine: {
          medicineId: line.medicineId,
          displayName: line.medicineName,
          rx: line.rx,
          controlled: line.controlled,
          restricted: line.restricted,
          highAlert: line.highAlert,
          lasa: line.lasa,
          coldChain: line.coldChain,
          activeIngredients: line.activeIngredients ?? [],
        },
        blocked: [],
        emergencySupply: line.emergencySupply ?? false,
        prescription: prescriptionLine
          ? {
              id: prescriptionLine.entry.prescriptionLineId,
              verified: prescriptionLine.entry.verified,
              expiresAt: new Date(prescriptionLine.prescription.validUntil),
              remainingAuthorizedUnits:
                prescriptionLine.entry.remainingAuthorizedUnits +
                (line.controlled && prescriptionLine.entry.verified ? line.canonicalUnits : 0),
            }
          : null,
        requestedCanonicalUnits: line.canonicalUnits,
        nearestSafeExpiry: line.allocations[0] ? new Date(line.allocations[0].expiresAt) : null,
        discountMinor: line.discountMinor,
      };
    });
    return counterAlertsFor(lines, { at: new Date() });
  }, [cart, patient]);

  const blocked = hasBlockingAlert(alerts);
  const currentBill = hasValidBill(cart, saleId);
  const balanceMinor = currentBill ? cart.totals.netMinor - cart.totals.tenderedMinor : null;
  const unknownTender = tenderOutcome?.status === 'unknown';
  const recoveryReady = branchAuthorized && recoveryBranch === branchId && !storageError;
  const billState: CounterTenderBillState =
    !saleId || !branchId
      ? 'idle'
      : storageError
        ? 'error'
        : !recoveryReady || cartQuery.isFetching || cartQuery.isLoading || refreshingTenderBill
          ? 'loading'
          : cartQuery.isError || unknownTender
            ? 'error'
            : tenderReadRequired || cartQuery.isStale || cartQuery.isPlaceholderData
              ? 'stale'
              : !cartQuery.isSuccess || !currentBill || cart.lines.length === 0
                ? 'unavailable'
                : cart.status === 'COMPLETED' &&
                    balanceMinor === 0 &&
                    Number.isSafeInteger(cart.receiptNumber) &&
                    (cart.receiptNumber ?? 0) > 0
                  ? 'settled'
                  : cart.status === 'OPEN' && balanceMinor !== null && balanceMinor > 0
                    ? 'ready'
                    : 'unavailable';
  const busy =
    pending !== null ||
    tenderReadRequired ||
    unknownTender ||
    refreshingTenderBill ||
    !recoveryReady ||
    attempt !== null ||
    checkingOutcome;
  const lineCount = cart?.lines.length ?? 0;

  const refreshTenderBill = useCallback(
    async (resolution = tenderOutcome?.status) => {
      if (
        !branchAuthorized ||
        !saleId ||
        tenderInFlight.current ||
        refreshingTenderBill ||
        (outcomeInFlight.current && resolution !== 'accepted')
      )
        return false;
      setRefreshingTenderBill(true);
      let confirmed: CounterReceiptSettlement | null = null;
      try {
        if (!attemptRef.current) {
          const saved = readTenderAttempt(recoveryScope);
          if (saved.status === 'blocked') {
            setStorageError(true);
            return false;
          }
          if (saved.status === 'pending') {
            attemptRef.current = saved.attempt;
            setAttempt(saved.attempt);
            setRestoredAttempt(saved.attempt);
            setSaleId(saved.attempt.input.saleId);
            setTenderOutcome({ status: 'unknown', message: UNKNOWN_TENDER_MESSAGE });
            setTenderReadRequired(true);
            return false;
          }
          setStorageError(false);
        }
        await utils.pharmacySales.counterCart.cancel();
        // invalidate() alone can resolve after a failed read. Inspect an explicit
        // refetch before permitting another money movement.
        const read = await cartQuery.refetch({ throwOnError: true });
        if (!read.isSuccess || !hasValidBill(read.data, saleId)) {
          setTenderReadRequired(true);
          return false;
        }
        await utils.pharmacySales.counterReceipt.invalidate();
        if (read.data.status === 'COMPLETED') {
          const receipt = await receiptQuery.refetch({ throwOnError: true });
          if (
            !receipt.isSuccess ||
            receipt.data?.saleId !== saleId ||
            receipt.data.receiptNumber !== read.data.receiptNumber
          )
            throw new Error('Receipt unavailable');
          const intent = receiptIntent.current;
          if (
            resolution === 'accepted' &&
            intent?.saleId === saleId &&
            intent.branchId === branchId &&
            intent.receiptNumber !== null &&
            intent.receiptNumber === read.data.receiptNumber &&
            read.data.totals.netMinor === read.data.totals.tenderedMinor &&
            read.data.lines.length > 0
          ) {
            buildCounterBrowserReceipt(receipt.data, receiptLocale, receiptFormat);
            confirmed = {
              status: 'confirmed',
              saleId,
              receiptNumber: intent.receiptNumber,
              autoPrint: intent.autoPrint,
              printReservation: intent.printReservation,
            };
          }
        }
        if (attemptRef.current && (resolution === 'accepted' || resolution === 'rejected')) {
          try {
            clearTenderAttempt(attemptRef.current);
            attemptRef.current = null;
            setAttempt(null);
            setStorageError(false);
          } catch {
            setStorageError(true);
            setTenderReadRequired(true);
            return false;
          }
        }
        setTenderReadRequired(false);
        if (confirmed) setReceiptSettlement(confirmed);
        return true;
      } catch {
        setTenderReadRequired(true);
        return false;
      } finally {
        if (!confirmed || attemptRef.current) {
          // A failed read may later reveal the new receipt, but needs a fresh
          // manual print gesture. Never keep a blank popup through recovery.
          const intent = receiptIntent.current;
          intent?.printReservation?.cancel();
          if (intent) {
            intent.printReservation = undefined;
            intent.autoPrint = false;
          }
        }
        setRefreshingTenderBill(false);
      }
    },
    [
      branchAuthorized,
      branchId,
      cartQuery,
      receiptFormat,
      receiptLocale,
      receiptQuery,
      recoveryScope,
      refreshingTenderBill,
      saleId,
      tenderOutcome?.status,
      utils,
    ]
  );

  // ── Actions ───────────────────────────────────────────────────────────────

  const focusSearch = useCallback(() => {
    searchRef.current?.focus();
    searchRef.current?.select();
  }, []);

  const runSearch = useCallback(
    async (submittedQuery?: string) => {
      if (!branchAuthorized || busy) return;
      const trimmed = (submittedQuery ?? query).trim();
      if (trimmed.length < 2) {
        setNotice({ tone: 'warning', message: 'Type at least two characters to search.' });
        return;
      }
      const revision = ++scannerRevision.current;
      const looksLikeGs1 = trimmed.startsWith(']d2') || trimmed.startsWith('(01)');
      if (!looksLikeGs1) {
        setSubmittedSearch({ text: trimmed, query: trimmed, branchId });
        return { query: trimmed, revision, blocked: false };
      }
      setPending('authenticatePack');
      try {
        const verdict = await authenticatePack.mutateAsync({ branchId, payload: trimmed });
        if (revision !== scannerRevision.current) return;
        setSubmittedSearch({ text: trimmed, query: verdict.parsed?.gtin ?? trimmed, branchId });
        setNotice({
          tone:
            verdict.status === 'VERIFIED'
              ? 'success'
              : verdict.status === 'BLOCKED_RECALL'
                ? 'danger'
                : 'warning',
          message: verdict.explanation,
        });
        return {
          query: verdict.parsed?.gtin ?? trimmed,
          revision,
          blocked: verdict.status === 'BLOCKED_RECALL',
        };
      } catch (error) {
        if (revision !== scannerRevision.current) return;
        setNotice({ tone: 'danger', message: messageFrom(error) });
      } finally {
        setPending(null);
      }
    },
    [authenticatePack, branchAuthorized, branchId, busy, query]
  );

  const stageRow = useCallback((row: CounterSearchRow) => {
    setActiveRow(row);
    setQuantity(1);
    setSaleUnit(row.saleUnits[0]?.kind ?? null);
    setLotOverride(null);
  }, []);

  const ensureSale = useCallback(async () => {
    if (saleId) return saleId;
    const created = await createSale.mutateAsync({ branchId, quotation: false });
    setActiveSale(created.id);
    return created.id;
  }, [branchId, createSale, saleId, setActiveSale]);

  const addToCart = useCallback(
    async (scannedRow?: CounterSearchRow, scanRevision?: number) => {
      const scanIsCurrent = () =>
        scanRevision === undefined || scanRevision === scannerRevision.current;
      if (!scanIsCurrent()) return;
      const row = scannedRow ?? activeRow;
      const option = scannedRow ? (scannedRow.saleUnits[0] ?? null) : selectedOption;
      const units = scannedRow ? 1 : quantity;
      const selectionPreview = scannedRow ? counterSelectionPreview(row, option, units) : preview;
      const batchOverride = scannedRow ? null : lotOverride;
      if (!row || !option || !selectionPreview || busy) return;
      if (!selectionPreview.sufficient) {
        setNotice({
          tone: 'warning',
          message: `Only ${selectionPreview.availableUnits} safe units are on hand. Reduce the quantity or capture the shortfall.`,
        });
        return;
      }
      const overrideLotId = batchOverride?.inventoryLotId ?? null;
      if (overrideLotId && !batchOverride?.reason.trim()) {
        setNotice({ tone: 'warning', message: 'Enter a reason before selling a non-FEFO batch.' });
        return;
      }
      setPending('addToCart');
      setNotice(null);
      try {
        const activeSaleId = await ensureSale();
        // Creating a bill can outlive this scan or the mounted counter.
        if (!scanIsCurrent()) return;
        const controlled = row.restriction.controlled;
        const addressOk = patientAddress.trim().length >= 3;
        const prescriptionOk =
          controlledAuth.emergency || Boolean(controlledAuth.prescriptionLineId);
        const emergencyOk =
          !controlledAuth.emergency || controlledAuth.prescriberName.trim().length > 0;
        if (
          controlled &&
          (!patient ||
            !addressOk ||
            !prescriptionOk ||
            !emergencyOk ||
            !controlledAuth.staffProfileId ||
            !/^\d{4,8}$/.test(controlledAuth.pin) ||
            !navigator.onLine)
        ) {
          setNotice({
            tone: 'warning',
            message:
              'Controlled medicine needs the patient address, a pharmacist PIN, and a prescription or an emergency prescriber. Connect online, then complete the authorization panel.',
          });
          rxPanelRef.current?.focus();
          return;
        }
        const refSerial = Number(controlledAuth.refSerial);
        const added = await addLine.mutateAsync({
          controlledAuthorization:
            controlled && patient
              ? {
                  patientId: patient.patientId,
                  patientAddress: patientAddress.trim(),
                  staffProfileId: controlledAuth.staffProfileId,
                  pin: controlledAuth.pin,
                  rxSerialWritten: controlledAuth.rxSerialWritten,
                  emergency: controlledAuth.emergency,
                  prescriptionLineId: controlledAuth.prescriptionLineId || undefined,
                  prescriberName: controlledAuth.prescriberName.trim() || undefined,
                  prescriberRegNo: controlledAuth.prescriberRegNo.trim() || undefined,
                  refSerial: Number.isInteger(refSerial) && refSerial > 0 ? refSerial : undefined,
                }
              : undefined,
          branchId,
          saleId: activeSaleId,
          medicineId: row.medicineId,
          presentationId: row.presentationId,
          packLevelId: option.packLevelId,
          saleUnit: option.kind,
          quantity: units,
          canonicalUnitsPerSaleUnit: option.canonicalUnitsPerSaleUnit,
          // A stable key per (sale, medicine, unit, quantity) so a double-press of
          // the add chord cannot post the same line twice.
          idempotencyKey: `counter:${activeSaleId}:${row.medicineId}:${option.packLevelId}:${option.kind}:${units}${overrideLotId ? `:${overrideLotId}` : ''}`,
          ...(overrideLotId && batchOverride
            ? {
                override: {
                  inventoryLotId: overrideLotId,
                  reason: batchOverride.reason.trim(),
                  approvalPolicy: COUNTER_OVERRIDE_APPROVAL_POLICY,
                },
              }
            : {}),
        });
        if ('blocked' in added) {
          setNotice({ tone: 'warning', message: added.blocked });
          return;
        }
        await refreshCart();
        await utils.pharmacyPrescriptions.counterPatientPanel.invalidate();
        await utils.pharmacySafety.controlledRegister.invalidate();
        await utils.pharmacySales.counterSearch.invalidate();
        setLotOverride(null);
        setNotice({
          tone: 'success',
          message: `${units} × ${row.displayName} added${overrideLotId ? ' with a recorded batch override' : ''}.`,
        });
        setQuery('');
        focusSearch();
      } catch (error) {
        const message = messageFrom(error);
        setNotice({
          tone: 'danger',
          message,
          ...(message === COUNTER_ERROR_MESSAGES.INVALID_ARRANGEMENT
            ? { inventoryBranchId: branchId }
            : {}),
        });
      } finally {
        setControlledAuth((value) => ({ ...value, pin: '' }));
        setPending(null);
      }
    },
    [
      activeRow,
      addLine,
      controlledAuth,
      patient,
      patientAddress,
      branchId,
      busy,
      ensureSale,
      focusSearch,
      lotOverride,
      preview,
      quantity,
      refreshCart,
      selectedOption,
      utils,
    ]
  );

  // Authentication belongs to this scan; other pending actions must still block its add.
  const barcodeBusy = useRef(false);
  useEffect(() => {
    barcodeBusy.current = busy && pending !== 'authenticatePack';
  }, [busy, pending]);

  const addBarcode = useCallback(
    async (submittedQuery?: string) => {
      const scan = { text: (submittedQuery ?? query).trim(), branchId, revision: -1 };
      const inFlight = scannerInFlight.current;
      // A lock only suppresses duplicates of a scan that is still live; a branch switch or
      // other invalidation bumps the revision so the operator's retry is not swallowed.
      if (
        busy ||
        (inFlight?.text === scan.text &&
          inFlight.branchId === scan.branchId &&
          inFlight.revision === scannerRevision.current)
      )
        return;
      scannerInFlight.current = scan;
      let revision: number | undefined;
      try {
        const searching = runSearch(submittedQuery);
        // runSearch claims its revision synchronously, before its first await.
        scan.revision = scannerRevision.current;
        const search = await searching;
        if (!search || search.blocked) return;
        revision = search.revision;
        const result = await utils.pharmacySales.counterSearch.fetch(
          { branchId, query: search.query },
          { staleTime: 10_000 }
        );
        if (revision !== scannerRevision.current || result.rows.length !== 1 || barcodeBusy.current)
          return;
        const row = result.rows[0]!;
        const restage =
          activeRow?.medicineId !== row.medicineId || saleUnit !== (row.saleUnits[0]?.kind ?? null);
        if (restage) stageRow(row);
        const scanPreview = restage
          ? counterSelectionPreview(row, row.saleUnits[0] ?? null, 1)
          : preview;
        if (scanPreview?.sufficient) {
          await addToCart(restage ? row : undefined, revision);
        }
      } catch (error) {
        if (revision === scannerRevision.current)
          setNotice({ tone: 'danger', message: messageFrom(error) });
      } finally {
        if (scannerInFlight.current === scan) scannerInFlight.current = null;
      }
    },
    [activeRow, addToCart, branchId, busy, preview, query, runSearch, saleUnit, stageRow, utils]
  );

  const runTransition = useCallback(
    async (action: 'hold' | 'resume' | 'void', reason?: string) => {
      const target = action === 'resume' ? heldSaleId : saleId;
      if (!target || busy) return;
      setPending(action);
      setNotice(null);
      try {
        await transition.mutateAsync({
          branchId,
          saleId: target,
          action,
          reason,
        });
        if (action === 'hold') {
          setHeldSaleId(target);
          setActiveSale(null);
        }
        if (action === 'resume') {
          setActiveSale(target);
          setHeldSaleId(null);
        }
        if (action === 'void') {
          setActiveSale(null);
        }
        await refreshCart();
        setNotice({ tone: 'success', message: `Bill ${action === 'void' ? 'voided' : action}.` });
        focusSearch();
      } catch (error) {
        setNotice({ tone: 'danger', message: messageFrom(error) });
      } finally {
        setPending(null);
      }
    },
    [branchId, busy, focusSearch, heldSaleId, refreshCart, saleId, setActiveSale, transition]
  );

  const loadKhataAccounts = useCallback(async () => {
    if (!saleId) return [];
    return utils.client.pharmacySales.khataAccounts.query({ branchId, saleId });
  }, [branchId, saleId, utils]);
  const reauthenticateOwner = useCallback(
    async (password: string, totp: string) => {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: accountEmail, password }),
      });
      let result;
      if (response.status === 404) {
        result = await signIn('credentials', {
          email: accountEmail,
          password,
          totp,
          redirect: false,
        });
      } else {
        if (!response.ok) throw new Error('Owner re-authentication failed');
        const body = (await response.json()) as {
          organizations?: Array<{ id: string; ssoEnforced?: boolean }>;
        };
        if (!body.organizations?.some((row) => row.id === organizationId && !row.ssoEnforced))
          throw new Error('Current workspace is not eligible');
        result = await signIn('login-intent', { organizationId, totp, redirect: false });
      }
      if (!result?.ok || result.error) throw new Error('Owner re-authentication failed');
    },
    [accountEmail, organizationId]
  );
  const printKhataStatement = useCallback(
    async (familyAccountId: string) => {
      if (!saleId) throw new Error('Open a bill');
      const popup = window.open('', '_blank', 'popup,width=640,height=720');
      if (!popup) throw new Error('Allow pop-ups');
      popup.opener = null;
      try {
        const statement = await utils.client.pharmacySales.khataStatement.query({
          branchId,
          saleId,
          familyAccountId,
        });
        popup.document.title = 'Family Khata statement';
        const pre = popup.document.createElement('pre');
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.overflowWrap = 'anywhere';
        // Plain text allowlist: never copy the counter DOM, clinical data or notes.
        pre.textContent = [
          'Family Khata statement',
          statement.account.displayName,
          `As of ${statement.generatedAt.toISOString()}`,
          `Balance PKR ${(statement.account.balanceMinor / 100).toFixed(2)}`,
          `Limit PKR ${(statement.account.creditLimitMinor / 100).toFixed(2)}`,
          statement.truncated
            ? 'Latest 1,000 entries shown; balance includes the full ledger.'
            : 'All ledger entries shown.',
          ...statement.entries.map(
            (row) =>
              `${row.occurredAt.toISOString()}  ${row.kind}  PKR ${(row.amountMinor / 100).toFixed(2)}`
          ),
        ].join('\n');
        popup.document.body.replaceChildren(pre);
        popup.focus();
        popup.print();
      } catch (error) {
        popup.close();
        throw error;
      }
    },
    [branchId, saleId, utils]
  );

  const takePayment = useCallback(
    async (
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
    ): Promise<CounterTenderResult> => {
      if (
        !saleId ||
        busy ||
        blocked ||
        billState !== 'ready' ||
        tenderInFlight.current ||
        attemptRef.current
      ) {
        return {
          status: 'rejected',
          message: 'Payment was not sent. Load a valid bill and resolve any safety block first.',
        };
      }
      tenderInFlight.current = true;
      setPending('tender');
      setTenderOutcome(null);
      setTenderReadRequired(true);
      discardReceiptIntent();
      setReceiptSettlement(null);
      let dispatched = false;
      let outcome: CounterTenderResult;
      try {
        const saved = readTenderAttempt(recoveryScope);
        if (saved.status !== 'empty') {
          setStorageError(true);
          throw new Error(TENDER_STORAGE_MESSAGE);
        }
        const payload: TenderAttempt['input'] = {
          branchId,
          saleId,
          deviceId: counterDeviceId(),
          businessDate: todayBusinessDate(),
          type: input.type,
          amountMinor: input.amountMinor,
          ...(input.cashReceivedMinor !== undefined
            ? { cashReceivedMinor: input.cashReceivedMinor }
            : {}),
          idempotencyKey: input.familyAccountId || input.payerName !== undefined
            ? `counter-tender:${saleId}:${input.type}:${browserUuid()}`
            : `counter-tender:${saleId}:${input.type}:${input.amountMinor}`,
          ...(input.familyAccountId
            ? { familyAccountId: input.familyAccountId, ownerOverride: input.ownerOverride }
            : {}),
          ...(input.providerRef !== undefined ? { providerRef: input.providerRef } : {}),
          ...(input.payerName !== undefined ? { payerName: input.payerName } : {}),
          ...(input.referenceSkipped !== undefined ? { referenceSkipped: input.referenceSkipped } : {}),
        };
        const original: TenderAttempt = { version: 1, scope: recoveryScope, input: payload, draft };
        // Persistence and read-back must succeed before any money write starts.
        persistTenderAttempt(original);
        attemptRef.current = original;
        setAttempt(original);
        const intent: ReceiptIntent = {
          saleId,
          branchId,
          receiptNumber: null,
          autoPrint,
          // Still inside the native payment gesture: no await precedes this.
          printReservation: autoPrint ? reserveCounterBrowserPrint() : undefined,
        };
        receiptIntent.current = intent;
        dispatched = true;
        const result = await tender.mutateAsync(payload);
        outcome = tenderAcknowledgement(result)
          ? { status: 'accepted', message: 'Payment recorded.' }
          : { status: 'unknown', message: UNKNOWN_TENDER_MESSAGE };
        if (receiptIntent.current === intent) {
          if (tenderAcknowledgement(result) && result.settled && result.replayed === false) {
            intent.receiptNumber = result.receiptNumber;
          } else {
            discardReceiptIntent();
          }
        }
      } catch (error) {
        discardReceiptIntent();
        if (!dispatched) setStorageError(true);
        outcome =
          !dispatched || tenderRejected(error)
            ? { status: 'rejected', message: `Payment was not accepted. ${messageFrom(error)}` }
            : { status: 'unknown', message: UNKNOWN_TENDER_MESSAGE };
      }
      setTenderOutcome(outcome);
      tenderInFlight.current = false;
      if (outcome.status === 'rejected' && dispatched && attemptRef.current) {
        try {
          clearTenderAttempt(attemptRef.current);
          attemptRef.current = null;
          setAttempt(null);
        } catch {
          setStorageError(true);
        }
      }
      // An acknowledged write stays accepted even if the follow-up read fails.
      // Unknown writes are never replayed or inferred from aggregate balances.
      if (outcome.status === 'accepted') await refreshTenderBill('accepted');
      setPending(null);
      return outcome;
    },
    [
      autoPrint,
      billState,
      blocked,
      branchId,
      busy,
      discardReceiptIntent,
      recoveryScope,
      refreshTenderBill,
      saleId,
      tender,
      todayBusinessDate,
    ]
  );

  const checkPaymentOutcome = useCallback(async (): Promise<CounterTenderResult> => {
    const original = attemptRef.current;
    if (
      !original ||
      !branchAuthorized ||
      original.input.saleId !== saleId ||
      tenderInFlight.current ||
      outcomeInFlight.current
    ) {
      return tenderOutcome ?? { status: 'unknown', message: UNKNOWN_TENDER_MESSAGE };
    }
    outcomeInFlight.current = true;
    setCheckingOutcome(true);
    let outcome: CounterTenderResult = { status: 'unknown', message: UNKNOWN_TENDER_MESSAGE };
    try {
      // Use the actual typed read procedure, bypassing query-cache replay. The
      // original device, full Date, optional cash and key are never regenerated.
      const result = await utils.client.pharmacySales.tenderOutcome.query(original.input);
      if (
        result.status === 'ACCEPTED' &&
        result.replayUnsafe === true &&
        tenderAcknowledgement(result.result)
      ) {
        outcome = { status: 'accepted', message: 'Payment recorded.' };
        setTenderOutcome(outcome);
        setTenderReadRequired(true);
        // This acknowledgement is historical; only fresh bill/receipt reads
        // may establish today's balance and unlock the next payment.
        await refreshTenderBill('accepted');
      } else {
        outcome = {
          status: 'unknown',
          message:
            'Payment is still unconfirmed. Keep the saved attempt and ask a supervisor to investigate before taking more money. Checking again will not send a payment.',
        };
      }
    } catch {
      outcome = {
        status: 'unknown',
        message:
          'Payment outcome could not be checked. Check your connection and account access, then check again. The saved attempt is still locked; no payment was sent by this check.',
      };
    } finally {
      setTenderOutcome(outcome);
      outcomeInFlight.current = false;
      setCheckingOutcome(false);
    }
    return outcome;
  }, [branchAuthorized, refreshTenderBill, saleId, tenderOutcome, utils]);

  const attachCustomer = useCallback(async () => {
    if (!patient || busy) return;
    setPending('customer');
    try {
      const activeSaleId = await ensureSale();
      const phoneLast4 = patient.phone?.replace(/\D/g, '').slice(-4);
      const linked = await linkCustomer.mutateAsync({
        branchId,
        saleId: activeSaleId,
        patientId: patient.patientId,
        displayName: patient.displayName,
        ...(phoneLast4?.length === 4 ? { phoneLast4 } : {}),
      });
      setCustomerId(linked.id);
      setNotice({ tone: 'success', message: 'Loyalty customer linked to this bill.' });
    } catch (error) {
      setNotice({ tone: 'warning', message: messageFrom(error) });
    } finally {
      setPending(null);
    }
  }, [branchId, busy, ensureSale, linkCustomer, patient]);

  const redeemCustomerPoints = useCallback(async () => {
    if (!saleId || redeemPoints <= 0 || busy) return;
    setPending('redeem');
    try {
      const result = await redeemLoyalty.mutateAsync({
        branchId,
        saleId,
        points: redeemPoints,
        deviceId: counterDeviceId(),
        businessDate: todayBusinessDate(),
        idempotencyKey: `counter-loyalty:${saleId}:${browserUuid()}`,
      });
      await Promise.all([refreshCart(), customerQuery.refetch()]);
      setNotice({
        tone: 'success',
        message: `${result.points} points added as a loyalty tender.`,
      });
    } catch (error) {
      setNotice({ tone: 'warning', message: messageFrom(error) });
    } finally {
      setPending(null);
    }
  }, [
    branchId,
    busy,
    customerQuery,
    redeemLoyalty,
    redeemPoints,
    refreshCart,
    saleId,
    todayBusinessDate,
  ]);

  const captureShortfall = useCallback(async () => {
    if (busy || !branchAuthorized) return;
    const requested = activeRow?.displayName ?? query.trim();
    if (!requested) {
      setNotice({ tone: 'warning', message: 'Search for the medicine first, then capture it.' });
      return;
    }
    const capturedUnits = activeRow ? shortfallUnits : quantity;
    if (!Number.isSafeInteger(capturedUnits) || capturedUnits <= 0) {
      setNotice({ tone: 'warning', message: 'There is no stock shortfall to capture.' });
      return;
    }
    setPending('captureDemand');
    setNotice(null);
    try {
      await captureDemand.mutateAsync({
        branchId,
        ...(saleId ? { saleId } : {}),
        ...(activeRow ? { requestedMedicineId: activeRow.medicineId } : {}),
        requestedText: requested,
        saleUnit: 'UNIT',
        quantity: capturedUnits,
        reason: activeRow ? 'STOCKOUT' : 'NOT_CARRIED',
        inventoryRuleSnapshot: {
          query: query.trim(),
          requestedQuantity: quantity,
          requestedSaleUnit: saleUnit ?? 'UNIT',
          canonicalUnitsPerSaleUnit: selectedOption?.canonicalUnitsPerSaleUnit ?? 1,
          requestedCanonicalUnits: requestedCanonicalUnits ?? quantity,
          shortfallCanonicalUnits: capturedUnits,
          onHandUnits: activeRow?.onHandUnits ?? 0,
          blocked: activeRow?.blocked ?? [],
          capturedAt: new Date().toISOString(),
        },
      });
      setNotice({
        tone: 'success',
        message: `Captured ${capturedUnits} canonical units of unfulfilled demand for ${requested}.`,
      });
      focusSearch();
    } catch (error) {
      setNotice({ tone: 'danger', message: messageFrom(error) });
    } finally {
      setPending(null);
    }
  }, [
    activeRow,
    branchAuthorized,
    branchId,
    busy,
    captureDemand,
    focusSearch,
    query,
    quantity,
    saleId,
    saleUnit,
    selectedOption,
    requestedCanonicalUnits,
    shortfallUnits,
  ]);

  const declineVisibleSubstitutes = useCallback(async () => {
    if (!activeRow || busy) return;
    setPending('declineSubstitute');
    try {
      await declineSubstitute.mutateAsync({
        branchId,
        ...(saleId ? { saleId } : {}),
        requestedMedicineId: activeRow.medicineId,
        requestedText: activeRow.displayName,
        strength: activeRow.strength ?? undefined,
        form: activeRow.dosageForm ?? undefined,
        presentation: activeRow.presentation,
        saleUnit: saleUnit ?? 'UNIT',
        quantity,
        inventoryRuleSnapshot: {
          proposalCount: substitutesQuery.data?.length ?? 0,
          capturedAt: new Date().toISOString(),
        },
      });
      setNotice({ tone: 'success', message: 'Demand closed: substitute declined.' });
    } catch (error) {
      setNotice({ tone: 'danger', message: messageFrom(error) });
    } finally {
      setPending(null);
    }
  }, [
    activeRow,
    branchId,
    busy,
    declineSubstitute,
    quantity,
    saleId,
    saleUnit,
    substitutesQuery.data,
  ]);

  const printReceipt = useCallback(() => {
    const receipt = receiptQuery.data;
    if (
      !receipt ||
      receipt.saleId !== saleId ||
      receipt.receiptNumber !== cart?.receiptNumber ||
      billState !== 'settled' ||
      receiptQuery.isFetching ||
      receiptQuery.isError
    ) {
      setNotice({ tone: 'danger', message: 'Load the settled receipt before printing.' });
      return;
    }
    discardReceiptIntent();
    setReceiptSettlement(null);
    try {
      printCounterBrowserReceipt(receipt, receiptLocale, receiptFormat, receiptRenders > 0);
      setReceiptRenders((count) => count + 1);
      setNotice({
        tone: 'success',
        message:
          'Browser print dialog requested. Select the matching paper size and OS printer. Physical printing is not confirmed.',
      });
    } catch (error) {
      setNotice({ tone: 'danger', message: messageFrom(error) });
    }
  }, [
    billState,
    cart?.receiptNumber,
    discardReceiptIntent,
    receiptFormat,
    receiptLocale,
    receiptQuery.data,
    receiptQuery.isError,
    receiptQuery.isFetching,
    receiptRenders,
    saleId,
  ]);

  // ── POS-01 keyboard map ───────────────────────────────────────────────────

  const runAction = useCallback(
    (action: CounterAction) => {
      switch (action) {
        case 'focusSearch':
          focusSearch();
          return;
        case 'selectPackUnit':
        case 'selectStripUnit':
        case 'selectLooseUnit': {
          const kind: SaleUnitKind =
            action === 'selectPackUnit' ? 'PACK' : action === 'selectStripUnit' ? 'STRIP' : 'UNIT';
          if (activeRow?.saleUnits.some((option) => option.kind === kind)) {
            setSaleUnit(kind);
          } else {
            setNotice({
              tone: 'warning',
              message: `This medicine is not sold by ${kind.toLowerCase()}.`,
            });
          }
          return;
        }
        case 'addToCart':
          void addToCart();
          return;
        case 'holdSale':
          void runTransition('hold');
          return;
        case 'resumeSale':
          void runTransition('resume');
          return;
        case 'openTender':
          tenderRef.current?.focus();
          return;
        case 'printReceipt':
          printReceipt();
          return;
        case 'focusPrescriptionPanel':
          rxPanelRef.current?.focus();
          return;
        case 'captureDemand':
          void captureShortfall();
          return;
        case 'voidSale':
          void runTransition('void', 'Voided from the counter.');
          return;
      }
    },
    [activeRow, addToCart, captureShortfall, focusSearch, printReceipt, runTransition]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Native tender controls own Enter/Space; the counter's Enter shortcut
      // must not also add a staged medicine when payment is activated.
      if (
        (event.key === 'Enter' || event.key === ' ') &&
        event.target instanceof Node &&
        (tenderRef.current?.contains(event.target) || event.target === autoPrintRef.current)
      )
        return;
      if (!shouldHandleCounterKey(event, document.querySelector('[role="dialog"]') !== null))
        return;
      const action = matchCounterAction(keymap.bindings, event);
      if (!action) return;
      // Claim the chord before the browser or a focused control can act on it,
      // so F9 reaches the tender panel rather than a browser default.
      event.preventDefault();
      runAction(action);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [keymap.bindings, runAction]);

  /**
   * Persistent scan focus (POS-01): the field regains focus after every action.
   * Keyed on `busy`, not `pending`: the field mounts disabled until tender
   * recovery is ready, so `autoFocus` alone cannot land on it.
   */
  useEffect(() => {
    if (!busy && document.activeElement === document.body) focusSearch();
  }, [busy, focusSearch]);

  const chordFor = useCallback(
    (kind: SaleUnitKind) =>
      formatBinding(
        keymap.bindings[
          kind === 'PACK'
            ? 'selectPackUnit'
            : kind === 'STRIP'
              ? 'selectStripUnit'
              : 'selectLooseUnit'
        ]
      ),
    [keymap.bindings]
  );

  // ── Render ────────────────────────────────────────────────────────────────

  if (branchesQuery.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Pharmacy" heading="Counter" description="Loading this workspace." />
        <SectionCard title="Loading">
          <p className="text-sm text-text-muted" role="status">
            Loading branches…
          </p>
        </SectionCard>
      </div>
    );
  }

  if (branchesQuery.isError) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Pharmacy"
          heading="Counter"
          description="This counter is unavailable."
        />
        <SectionCard title="Branches unavailable">
          <div className="space-y-3" role="alert">
            <p className="text-sm text-destructive">{messageFrom(branchesQuery.error)}</p>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => void branchesQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        </SectionCard>
      </div>
    );
  }

  if (branches.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Pharmacy"
          heading="Counter"
          description="No active branch is configured yet."
        />
        {/*
          UX rule 13: a precondition is a checklist with links, not a sentence.
          Name each gate the counter needs and link it to the page that clears
          it, so the operator is never told what is missing without being told
          where to go. Branch administration lives on the organization console;
          this lane owns the counter, not that surface, so it links there rather
          than duplicating it.
        */}
        <SectionCard title="Before this counter can sell">
          <div className="space-y-3">
            <p className="text-sm text-text-body">
              A counter dispenses from one active pharmacy branch. Two things must exist first:
            </p>
            <ul className="space-y-2 text-sm text-text-body">
              <li className="flex flex-wrap items-baseline gap-x-2">
                <span aria-hidden="true" className="text-text-muted">
                  1.
                </span>
                <span>An active pharmacy branch for this organization.</span>
                <Link
                  href="/organization"
                  className="font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Organization administration
                </Link>
              </li>
              <li className="flex flex-wrap items-baseline gap-x-2">
                <span aria-hidden="true" className="text-text-muted">
                  2.
                </span>
                <span>A stock location on that branch holding dispensable batches.</span>
                <Link
                  href="/organization"
                  className="font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Organization administration
                </Link>
              </li>
            </ul>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => void branchesQuery.refetch()}
            >
              Check again
            </Button>
          </div>
        </SectionCard>
      </div>
    );
  }

  if (!branchAuthorized) {
    return (
      <SectionCard title="Counter unavailable">
        <p role="alert" className="text-sm text-text-body">
          This branch could not be verified for your account. Restore branch access before opening a
          saved payment.
        </p>
      </SectionCard>
    );
  }

  return (
    <div className="pos-calm flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-2 py-1">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold leading-5 text-text-strong">Counter</h1>
          <p className="text-xs text-text-muted">
            {formatBinding(keymap.bindings.focusSearch)} search · Enter add ·{' '}
            {formatBinding(keymap.bindings.openTender)} pay
          </p>
        </div>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
          <CounterReturnPanel
            branchId={branchId}
            organizationId={organizationId}
            accountId={accountId}
            deviceId={counterDeviceId}
            businessDate={todayBusinessDate}
          />
          <Link
            className={buttonVariants({
              variant: 'outline',
              className: 'h-8 shadow-none hover:translate-y-0 active:translate-y-0',
            })}
            href="/pharmacy/orders"
          >
            Customer orders
          </Link>
          {/*
              UX rule 1: never show the operator an identifier the application
              already knows. A sale id fragment names nothing a pharmacist can
              act on; the receipt number is the only bill identity that exists
              in the real world, and it exists only once the bill is settled.
              Before that, describe the bill by what it holds.
            */}
          <StatusPill
            status={saleId ? 'open' : 'idle'}
            tone={saleId ? 'info' : 'neutral'}
            label={
              cart?.receiptNumber
                ? `Receipt ${cart.receiptNumber}`
                : saleId
                  ? `Bill open · ${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`
                  : 'No open bill'
            }
          />
          {heldSaleId ? <StatusPill status="held" tone="warning" label="1 held" /> : null}
          {blocked ? <StatusPill status="blocked" tone="danger" label="Safety block" /> : null}
          {openDrawerSession ? (
            <StatusPill status="drawer-open" tone="success" label="Drawer open" />
          ) : (
            <Button
              type="button"
              variant="outline"
              className="h-8 shadow-none hover:translate-y-0 active:translate-y-0"
              disabled={busy || !drawerStatusKnown}
              onClick={() => {
                setPending('drawer');
                openDrawer
                  .mutateAsync({
                    branchId,
                    deviceId: counterDeviceId(),
                    businessDate: todayBusinessDate(),
                    openingFloatMinor: 0,
                  })
                  .then(() =>
                    setNotice({
                      tone: 'success',
                      message: 'Cash drawer opened for this counter.',
                    })
                  )
                  .catch((error: unknown) =>
                    setNotice({ tone: 'warning', message: messageFrom(error) })
                  )
                  // Either way the server now holds the truth about this device's drawer.
                  .finally(() => {
                    setPending(null);
                    void utils.pharmacySales.drawerStatus.invalidate();
                  });
              }}
            >
              Open drawer
            </Button>
          )}
        </div>
      </header>

      <div className="flex min-h-8 shrink-0 items-center px-2">
        {notice ? (
          <div
            role={notice.tone === 'success' ? 'status' : 'alert'}
            aria-live="polite"
            className={`flex items-center gap-3 rounded-lg border p-3 ${
              notice.tone === 'danger'
                ? 'border-destructive/30 bg-destructive/10'
                : notice.tone === 'warning'
                  ? 'border-warning/30 bg-warning/10'
                  : notice.tone === 'success'
                    ? 'border-success/30 bg-success/10'
                    : 'border-border-subtle bg-surface-sunken'
            }`}
          >
            <StatusPill status={notice.tone} tone={notice.tone} />
            <div className="min-w-0 space-y-2 text-sm">
              <p className="text-text-body">{notice.message}</p>
              {notice.inventoryBranchId ? (
                <Link
                  href={`/pharmacy/inventory?branch=${encodeURIComponent(notice.inventoryBranchId)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  prefetch={false}
                  className={buttonVariants({
                    variant: 'outline',
                    className: 'h-auto min-h-11 whitespace-normal',
                  })}
                >
                  Open Inventory to review pack breaking (new tab)
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div
        role="region"
        aria-label="Counter workspace"
        tabIndex={0}
        className="grid min-h-0 flex-1 auto-rows-max grid-cols-1 gap-2 overflow-y-auto p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 md:auto-rows-auto md:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] md:overflow-hidden"
      >
        <div
          role="region"
          aria-label="Sale entry"
          tabIndex={0}
          className="space-y-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 md:col-start-1 md:min-h-0 md:overflow-y-auto"
        >
          <SectionCard compact eyebrow="POS-02" title="Scan and search">
            <div className="space-y-2">
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="space-y-1.5">
                  <Label htmlFor="counter-search">Scan or search</Label>
                  <Input
                    id="counter-search"
                    ref={searchRef}
                    // POS-01: focus rests here for the whole bill, so F-keys stay live in this field.
                    data-counter-scan=""
                    autoFocus
                    autoComplete="off"
                    value={query}
                    disabled={busy}
                    placeholder="Brand, generic, ingredient, strength, form, barcode, alias"
                    aria-describedby="counter-search-help"
                    onChange={(event) => {
                      scannerRevision.current += 1;
                      setQuery(event.target.value);
                      setActiveRow(null);
                      setSaleUnit(null);
                      setQuantity(1);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      const trimmed = event.currentTarget.value.trim();
                      const barcode =
                        /^\d{6,}$/.test(trimmed) ||
                        trimmed.startsWith(']d2') ||
                        trimmed.startsWith('(01)');
                      if (barcode) {
                        void addBarcode(trimmed);
                        return;
                      }
                      if (activeRow) {
                        void addToCart();
                        return;
                      }
                      void runSearch();
                    }}
                    className="h-9"
                  />
                  <p id="counter-search-help" className="text-xs text-text-muted">
                    {formatBinding(keymap.bindings.focusSearch)} focuses search. Enter adds the
                    selected medicine, or a barcode. {formatBinding(keymap.bindings.openTender)}{' '}
                    opens pay.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="counter-branch">Branch</Label>
                  <select
                    id="counter-branch"
                    value={branchId}
                    disabled={busy}
                    onChange={(event) => {
                      scannerRevision.current += 1;
                      setSelectedBranchId(event.target.value);
                      setActiveRow(null);
                      setActiveSale(null);
                      setHeldSaleId(null);
                    }}
                    className="h-9 w-full rounded-md border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                  >
                    {branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name} · {branch.code}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <CounterSearchResults
                rows={
                  searchCurrent && !searchQuery.isPlaceholderData
                    ? (searchQuery.data?.rows ?? [])
                    : []
                }
                state={
                  !branchAuthorized || trimmedQuery.length < 2 || (scannerQuery && !searchCurrent)
                    ? 'idle'
                    : !searchCurrent || searchQuery.isFetching || searchQuery.isPlaceholderData
                      ? 'loading'
                      : searchQuery.isError
                        ? 'error'
                        : 'ready'
                }
                query={trimmedQuery}
                disabled={busy || !branchAuthorized}
                activeMedicineId={activeRow?.medicineId ?? null}
                error={searchQuery.error ? messageFrom(searchQuery.error) : null}
                onSelect={stageRow}
                onCaptureDemand={() => void captureShortfall()}
                onRetry={() => {
                  if (searchCurrent) void searchQuery.refetch();
                }}
              />
            </div>
          </SectionCard>

          {substituteInput ? (
            <SectionCard compact eyebrow="AI-05 · RX-04" title="Exact substitute suggestions">
              <CounterSubstituteProposals
                proposals={substitutesQuery.data ?? []}
                state={
                  substitutesQuery.isLoading
                    ? 'loading'
                    : substitutesQuery.isError
                      ? 'error'
                      : 'ready'
                }
                prescriptionOnly={activeRow?.restriction.rx ?? false}
                error={substitutesQuery.error ? messageFrom(substitutesQuery.error) : null}
                disabled={busy}
                onChoose={(proposal) => {
                  setQuery(proposal.displayName);
                  setSubmittedSearch({
                    text: proposal.displayName,
                    query: proposal.displayName,
                    branchId,
                  });
                  setActiveRow(null);
                }}
                onDecline={() => void declineVisibleSubstitutes()}
                onRetry={() => void substitutesQuery.refetch()}
              />
            </SectionCard>
          ) : null}

          <CounterUpsellSuggestions
            branchId={branchId}
            medicineIds={currentBill ? cart.lines.map((line) => line.medicineId) : []}
            disabled={busy || !branchAuthorized}
            onChoose={(suggestion) => {
              setQuery(suggestion.displayName);
              setSubmittedSearch({
                text: suggestion.displayName,
                query: suggestion.displayName,
                branchId,
              });
              setActiveRow(null);
            }}
          />

          <SectionCard
            compact
            eyebrow="POS-03"
            title="Sale unit and quantity"
            actions={
              <Button
                type="button"
                className="h-9 shadow-none hover:translate-y-0 active:translate-y-0"
                disabled={busy || !activeRow || !preview?.sufficient}
                onClick={() => void addToCart()}
              >
                {pending === 'addToCart'
                  ? 'Adding…'
                  : `Add to cart (${formatBinding(keymap.bindings.addToCart)})`}
              </Button>
            }
          >
            {activeRow ? (
              <div className="space-y-2">
                <CounterUnitToggle
                  options={activeRow.saleUnits}
                  selected={saleUnit}
                  quantity={quantity}
                  preview={preview}
                  disabled={busy}
                  onSelect={setSaleUnit}
                  onQuantityChange={setQuantity}
                  chordFor={chordFor}
                />
                {activeRow.saleUnits.length === 0 ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="counter-demand-units">Requested canonical units</Label>
                    <Input
                      id="counter-demand-units"
                      type="number"
                      min={1}
                      step={1}
                      className="h-11 w-32"
                      value={quantity}
                      disabled={busy}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        setQuantity(Number.isSafeInteger(next) && next > 0 ? next : 1);
                      }}
                    />
                  </div>
                ) : null}
                {shortfallUnits > 0 ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto min-h-11 whitespace-normal"
                    disabled={busy || !branchAuthorized}
                    onClick={() => void captureShortfall()}
                  >
                    {pending === 'captureDemand'
                      ? 'Capturing…'
                      : `Capture shortfall: ${shortfallUnits} canonical units`}
                  </Button>
                ) : null}
                <CounterLotOverride
                  value={lotOverride}
                  lots={lotOptionsQuery.data ?? []}
                  state={
                    lotOptionsQuery.isError
                      ? 'error'
                      : lotOptionsQuery.isSuccess
                        ? 'ready'
                        : 'loading'
                  }
                  error={lotOptionsQuery.error ? messageFrom(lotOptionsQuery.error) : null}
                  disabled={busy}
                  onChange={setLotOverride}
                  onRetry={() => void lotOptionsQuery.refetch()}
                />
              </div>
            ) : (
              <p className="text-sm text-text-muted">
                Select a search result to choose its sale unit.
              </p>
            )}
          </SectionCard>

          <SectionCard compact eyebrow="POS-01" title="Workflow map">
            <CounterKeymapLegend
              keymap={keymap}
              saving={saveKeymap.isPending}
              disabled={busy}
              onPresetChange={(preset: CounterKeymapPresetKey) =>
                saveKeymap.mutate({ preset, overrides: {} })
              }
            />
          </SectionCard>
        </div>

        <div
          role="region"
          aria-label="Cart, tender and receipt"
          tabIndex={0}
          className="flex flex-col gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 md:col-start-2 md:row-span-2 md:min-h-0 md:overflow-y-auto"
        >
          <SectionCard
            compact
            className="shrink-0"
            eyebrow="POS-03"
            title="Cart and FEFO allocation"
            actions={
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 shadow-none hover:translate-y-0 active:translate-y-0"
                  disabled={busy || !saleId}
                  onClick={() => void runTransition('hold')}
                >
                  Hold
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 shadow-none hover:translate-y-0 active:translate-y-0"
                  disabled={busy || !heldSaleId}
                  onClick={() => void runTransition('resume')}
                >
                  Resume
                </Button>
              </div>
            }
          >
            <CounterCartPanel
              cart={cart}
              state={
                !saleId
                  ? 'idle'
                  : cartQuery.isLoading
                    ? 'loading'
                    : cartQuery.isError
                      ? 'error'
                      : 'ready'
              }
              error={cartQuery.error ? messageFrom(cartQuery.error) : null}
              onRetry={() => void refreshTenderBill()}
            />
          </SectionCard>

          <SectionCard compact className="shrink-0" eyebrow="POS-05" title="Tender">
            <div className="mb-4 space-y-1">
              <Label htmlFor="counter-auto-print" className="flex min-h-11 items-center gap-3">
                <input
                  ref={autoPrintRef}
                  id="counter-auto-print"
                  type="checkbox"
                  checked={autoPrint}
                  disabled={busy}
                  onChange={(event) => setAutoPrint(event.target.checked)}
                  aria-describedby="counter-auto-print-help"
                  className="size-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                />
                Automatically open print dialog after payment
              </Label>
              <p id="counter-auto-print-help" className="text-xs text-text-muted">
                This counter session only. Requires a newly settled bill and issued receipt.
                Physical printing is not confirmed.
              </p>
            </div>
            {branchesQuery.data?.paymentSandboxAvailable && saleId ? (
              <PaymentSandboxPanel
                key={`${branchId}:${saleId}`}
                branchId={branchId}
                saleId={saleId}
                deviceId={counterDeviceId()}
                businessDate={todayBusinessDate()}
                disabled={busy || blocked}
                onRecorded={refreshCart}
              />
            ) : null}
            <CounterTenderPanel
              key={`${branchId}:${saleId ?? 'none'}:${restoredAttempt?.input.idempotencyKey ?? ''}`}
              ref={tenderRef}
              manualSettings={manualSettings.data?.settings}
              manualSettingsLoading={manualSettings.isLoading}
              manualSettingsError={manualSettings.isError}
              onReloadManualSettings={() => void manualSettings.refetch()}
              loadKhataAccounts={loadKhataAccounts}
              reauthenticateOwner={reauthenticateOwner}
              printKhataStatement={printKhataStatement}
              balanceMinor={balanceMinor}
              state={billState}
              blocked={blocked}
              pending={pending === 'tender'}
              disabled={busy || !saleId}
              initialDraft={
                restoredAttempt
                  ? { ...restoredAttempt.draft, type: restoredAttempt.input.type,
                    payerName: restoredAttempt.input.payerName, providerRef: restoredAttempt.input.providerRef,
                    referenceSkipped: restoredAttempt.input.referenceSkipped }
                  : undefined
              }
              recoveryOutcome={tenderOutcome}
              checkingOutcome={checkingOutcome}
              onCheckOutcome={
                attempt && tenderOutcome?.status === 'unknown' ? checkPaymentOutcome : undefined
              }
              error={
                storageError
                  ? TENDER_STORAGE_MESSAGE
                  : cartQuery.isError
                    ? 'This bill could not be read. Check your access and refresh this bill before taking payment.'
                    : tenderReadRequired && pending !== 'tender'
                      ? tenderOutcome?.status === 'accepted'
                        ? 'Payment recorded, but the bill refresh is incomplete. Refresh this bill before taking another payment.'
                        : 'Refresh this bill to verify its current state.'
                      : null
              }
              onRetry={() => void refreshTenderBill()}
              onTender={takePayment}
            />
          </SectionCard>

          <SectionCard
            compact
            className="shrink-0"
            eyebrow="POS-08"
            title="Receipt"
          >
            <CounterReceiptView
              branchId={branchId}
              receipt={
                billState === 'settled' &&
                !receiptQuery.isError &&
                !receiptQuery.isFetching &&
                receiptQuery.data?.saleId === saleId &&
                receiptQuery.data.receiptNumber === cart?.receiptNumber
                  ? receiptQuery.data
                  : null
              }
              state={
                billState !== 'settled'
                  ? 'idle'
                  : receiptQuery.isLoading
                    ? 'loading'
                    : receiptQuery.isError
                      ? 'error'
                      : 'ready'
              }
              evidence={evidenceEligible && !evidenceQuery.isError ? evidenceQuery.data : null}
              evidenceError={evidenceEligible && evidenceQuery.isError}
              evidenceRefreshing={evidenceQuery.isFetching}
              onEvidenceRefresh={evidenceEligible ? () => void evidenceQuery.refetch() : undefined}
              locale={receiptLocale}
              format={receiptFormat}
              reprint={receiptRenders > 0}
              printing={receiptQuery.isFetching}
              error={receiptQuery.error ? messageFrom(receiptQuery.error) : null}
              onLocaleChange={setReceiptLocale}
              onFormatChange={setReceiptFormat}
              onPrint={printReceipt}
              onRetry={() => void receiptQuery.refetch()}
              settlement={receiptSettlement}
              onSettlementPresented={receiptPresented}
            />
          </SectionCard>
        </div>

        <div
          role="region"
          aria-label="Customer and prescription"
          tabIndex={0}
          className="space-y-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 md:col-start-1 md:min-h-0 md:overflow-y-auto"
        >
          <SectionCard
            compact
            eyebrow="CRM-L01"
            title="Customer loyalty and khata"
            actions={
              <Button
                type="button"
                variant="outline"
                className="h-8 shadow-none hover:translate-y-0 active:translate-y-0"
                disabled={busy || !patient || !saleId}
                onClick={() => void attachCustomer()}
              >
                {pending === 'customer' ? 'Linking…' : 'Link selected patient'}
              </Button>
            }
          >
            {customerQuery.data ? (
              <div className="space-y-4 text-sm text-text-body">
                <div>
                  <p className="font-semibold text-text-strong">
                    {customerQuery.data.customer.displayName}
                  </p>
                  <p className="text-text-muted">
                    {customerQuery.data.pointsBalance} points · Khata{' '}
                    {formatMinor(customerQuery.data.creditBalanceMinor)} /{' '}
                    {formatMinor(customerQuery.data.customer.creditLimitMinor)}
                  </p>
                  <p className="text-text-muted">
                    Available credit {formatMinor(customerQuery.data.availableCreditMinor)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Label htmlFor="counter-redeem-points" className="sr-only">
                    Points to redeem
                  </Label>
                  <Input
                    id="counter-redeem-points"
                    type="number"
                    min={1}
                    step={1}
                    value={redeemPoints || ''}
                    disabled={busy || balanceMinor === null || balanceMinor <= 0}
                    onChange={(event) => setRedeemPoints(Number(event.target.value))}
                    placeholder="Points"
                    className="h-8"
                  />
                  <Button
                    type="button"
                    className="h-8 shadow-none hover:translate-y-0 active:translate-y-0"
                    disabled={
                      busy || redeemPoints <= 0 || balanceMinor === null || balanceMinor <= 0
                    }
                    onClick={() => void redeemCustomerPoints()}
                  >
                    Redeem
                  </Button>
                </div>
                <div>
                  <p className="font-mono text-xs uppercase tracking-wide text-text-muted">
                    Points ledger · latest 25 entries
                  </p>
                  <ul className="mt-2 space-y-2" aria-label="Points ledger">
                    {customerQuery.data.pointsHistory?.map((entry) => (
                      <li
                        key={entry.id}
                        className="flex flex-wrap justify-between gap-2 border-b border-border-subtle pb-2"
                      >
                        <span>
                          {entry.kind} · Receipt {entry.sale.receiptNumber ?? '—'} ·{' '}
                          {new Date(entry.occurredAt).toISOString().slice(0, 10)}
                        </span>
                        <span className="font-mono tabular-nums">
                          {entry.points > 0 ? '+' : ''}
                          {entry.points}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 font-mono text-xs uppercase tracking-wide text-text-muted">
                    Purchase history
                  </p>
                  {customerQuery.data.history.length ? (
                    <ul className="mt-2 space-y-2">
                      {customerQuery.data.history.map((sale) => (
                        <li
                          key={sale.saleId}
                          className="flex justify-between border-b border-border-subtle pb-2 tabular-nums"
                        >
                          <span>Receipt {sale.receiptNumber ?? '—'}</span>
                          <span>{formatMinor(sale.totalMinor)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-text-muted">No completed purchases at this branch.</p>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-text-muted">
                Select a patient, open a bill, then link. Current loyalty consent is required.
              </p>
            )}
          </SectionCard>
          <SectionCard
            compact
            eyebrow="POS-09"
            title="Prescription and patient"
            actions={
              <kbd className="rounded-[3px] border border-border-subtle bg-surface-sunken px-1.5 py-0.5 font-mono text-xs text-text-strong">
                {formatBinding(keymap.bindings.focusPrescriptionPanel)}
              </kbd>
            }
          >
            <CounterRxPanel
              ref={rxPanelRef}
              controlled={
                // QA-138: controlledPharmacists requires pharmacy:dispense/safety. A
                // FORBIDDEN read means this actor cannot dispense, so the controlled
                // authorization panel is not offered (the server refuses it anyway).
                // Without Pharmacy Safety the read is not made at all, with the same outcome.
                !safetyLicensed ||
                (pharmacistsQuery.error as { data?: { code?: string } } | null)?.data?.code ===
                  'FORBIDDEN'
                  ? undefined
                  : {
                      ...controlledAuth,
                      pharmacists: pharmacistsQuery.data ?? [],
                      loading: pharmacistsQuery.isLoading,
                      error: pharmacistsQuery.isError,
                      patientAddress,
                      onChange: (field, value) => {
                        if (field === 'patientAddress') {
                          setPatientAddressDraft(typeof value === 'string' ? value : '');
                          return;
                        }
                        setControlledAuth((current) => {
                          if (field === 'emergency' || field === 'rxSerialWritten') {
                            return { ...current, [field]: value === true };
                          }
                          if (typeof value !== 'string') return current;
                          return { ...current, [field]: value };
                        });
                      },
                    }
              }
              alerts={alerts}
              acknowledgementScope={saleId && branchId ? { branchId, saleId } : null}
              patient={patient}
              candidates={patientsQuery.data?.patients ?? []}
              query={patientQuery}
              state={
                patientPanelQuery.isError &&
                (patientPanelQuery.error?.data?.code === 'FORBIDDEN' ||
                  patientsQuery.error?.data?.code === 'FORBIDDEN')
                  ? 'denied'
                  : patientsQuery.isLoading || patientPanelQuery.isLoading
                    ? 'loading'
                    : patientsQuery.isError || patientPanelQuery.isError
                      ? 'error'
                      : submittedPatientQuery.trim().length >= 2
                        ? 'ready'
                        : 'idle'
              }
              error={
                patientsQuery.error
                  ? messageFrom(patientsQuery.error)
                  : patientPanelQuery.error
                    ? messageFrom(patientPanelQuery.error)
                    : null
              }
              disabled={busy}
              onQueryChange={setPatientQuery}
              onSearch={() => setSubmittedPatientQuery(patientQuery.trim())}
              onSelectPatient={(id) => {
                setPatientId(id);
                setPatientAddressDraft(null);
              }}
              onClearPatient={() => {
                setPatientId(null);
                setPatientAddressDraft(null);
                setSubmittedPatientQuery('');
                setPatientQuery('');
              }}
            />
          </SectionCard>
        </div>
      </div>

      <p className="sr-only" aria-live="polite">
        {COUNTER_ACTION_LABELS.focusSearch}: {formatBinding(keymap.bindings.focusSearch)}
      </p>
    </div>
  );
}
