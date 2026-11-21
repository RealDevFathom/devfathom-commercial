'use client';

import { browserUuid } from '@/lib/browser-uuid';
import {
  enrolledCounterDeviceId,
  subscribeCounterEnrolment,
} from '@/lib/pharmacy/counter-device-store';
import { CounterCatalogueCache } from '@/lib/pharmacy/counter-catalogue-cache';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
  type KeyboardEventHandler,
} from 'react';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import Link from 'next/link';
import { flushSync } from 'react-dom';
import {
  CircleCheck,
  Ellipsis,
  ScanBarcode,
  ShieldCheck,
  Star,
  UserRound,
  WifiOff,
} from 'lucide-react';
import { signIn, useSession } from 'next-auth/react';
import { useEntitlements } from '@/components/entitlements-provider';
import { evaluateSessionUser } from '@/lib/auth/session-state';
import { isModuleGranted } from '@/lib/module-catalog';
import {
  clearTenderAttempt,
  freshTenderKey,
  persistTenderAttempt,
  readTenderAttempt,
  tenderAttemptStorageKey,
  TENDER_STORAGE_MESSAGE,
  type TenderAttempt,
  type TenderAttemptScope,
  type TenderDraft,
} from './tender-attempt-storage';

import {
  CounterCartPanel,
  CounterLotOverride,
  type CounterLineChange,
  type CounterLotOverrideValue,
} from './counter-cart';
import { CounterChangeDue } from './counter-change-due';
import { CounterKeymapLegend } from './counter-keymap-legend';
import { CounterActionBar, CounterFrame, CounterFrameContent } from './counter-frame';
import { CounterOpenDrawerStep } from './counter-open-drawer-step';
import { CounterSaleReadiness, CounterSetupNextStep } from './counter-sale-readiness';
import { clearCounterReadinessOkay } from '@/lib/pharmacy/counter-readiness-okay';
import { CounterDrawerOperator } from './counter-drawer-operator';
import { CounterCashShiftPanel } from './counter-cash-shift-panel';
import { CounterOpenBills, type CounterOpenBill } from './counter-open-bills';
import { CounterPackApprovalDialog } from './counter-pack-approval-dialog';
import { ApprovalSecretKindContext } from './counter-approval-copy';
import { useApprovalSecretKind } from '@/components/pharmacy/own-approval-copy';
import type { CounterApprovalPin } from '@/lib/pharmacy/counter-line-approval';
import { CounterVoidDialog } from './counter-void-dialog';
import type { SaleVoidReason } from '@/lib/pharmacy/sale-void-reasons';
import { readActiveBill, rememberActiveBill, type ActiveBillScope } from './active-bill-storage';
import { CounterLostSaleChips, type LostSaleChoice } from './counter-lost-sale-chips';
import {
  CounterReceiptView,
  type CounterReceiptPresentationResult,
  type CounterReceiptSettlement,
} from './counter-receipt-view';
import { CounterCardTerminalPanel } from './counter-card-terminal-panel';
import { CounterKhataPaymentPanel } from './counter-khata-payment-panel';
import { CounterReturnPanel } from './counter-return-panel';
import { CounterRxPanel } from './counter-rx-panel';
import { CounterRxSelfSign } from './counter-rx-self-sign';
import { CounterSearchResults } from './counter-search-results';
import { CounterScanInput } from './counter-scan-input';
import { CounterVoucherEntry, type CounterHeldVoucher } from './counter-voucher';
import { CounterBillDiscountEntry } from './counter-bill-discount';
import {
  CounterDiscountEntry,
  counterDiscountMinor,
  describeCounterDiscount,
  type CounterHeldDiscount,
} from './counter-discount';
import { CounterSkeleton } from './counter-skeleton';
import { CounterSubstituteProposals } from './counter-substitute-proposals';
import {
  CounterTenderPanel,
  type CounterTenderType,
  type CounterTenderResult,
  type CounterTenderBillState,
  type KhataSignupInput,
} from './counter-tender-panel';
import type { CounterTenderDiscardInput } from './counter-tender-discard';
import { CounterUnitToggle } from './counter-unit-toggle';
import { CounterUpsellSuggestions } from './counter-upsell-suggestions';
import { useBrowserOnline } from './use-browser-online';
import { useCounterEnrolment, useCounterOffline } from './use-counter-offline';
import {
  CounterOfflineBannerDetail,
  CounterOfflineOnly,
  CounterOfflinePanel,
} from './counter-offline-panel';
import { OfflineQueue } from './counter-offline-sale';
import { CounterSalesToReconcile } from './counter-sales-to-reconcile';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { Eyebrow } from '@/components/ui/eyebrow';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Dialog, DialogPortal, DialogOverlay, DialogDescription } from '@/components/ui/dialog';
import {
  COUNTER_SHEET_BACKDROP,
  CounterSheetFooter,
  CounterSheetHeader,
  counterSheetClassName,
  type CounterSheetVariant,
} from './counter-sheet';
import type { CounterCart, CounterCartLine, CounterSearchRow } from '@/lib/pharmacy/counter';
import { counterLabelScanDecision } from '@/lib/pharmacy/counter-label-scan';
import {
  counterMedicineDisplayName,
  counterMedicineGenericName,
} from '@/lib/pharmacy/counter-display-name';
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
import {
  COUNTER_DISCOUNT_APPROVAL_REQUIRED,
  COUNTER_DISCOUNT_NOTICES,
  COUNTER_ERROR_MESSAGES,
  counterBillMovedOn,
  counterErrorMessage,
  counterDrawerErrorMessage,
  counterErrorTone,
  counterPaymentErrorMessage,
  counterSaleErrorMessage,
  TENDER_ATTEMPT_DISCARDED,
} from '@/lib/pharmacy/counter-messages';
import {
  looksLikeLoyaltyCardCode,
  normalizeLoyaltyCardCode,
} from '@/lib/pharmacy/loyalty-card-code';
import {
  ASK_OWNER_OR_MANAGER,
  BRANCH_NOT_ASSIGNED,
  COUNTER_NO_ASSIGNED_BRANCH_MESSAGE,
  counterSetupAdvice,
  counterSetupReason,
  type CounterSetupAdvice,
} from '@/lib/pharmacy/counter-setup';
import { CounterSignOut } from './counter-sign-out';
import { refreshCounterQueries } from '@/lib/pharmacy/counter-query-refresh';
import {
  counterUnitNoun,
  plural,
  looseSaleUnitOption,
  onHandInSaleUnitLabel,
  preferredSaleUnitOption,
  previewSaleLine,
  type SaleUnitKind,
  type SaleUnitOption,
} from '@/lib/pharmacy/counter-pricing';
import {
  formatMinor,
  formatShortExpiry,
  sindhCashMemoSelected,
  type CounterReceipt,
  type CounterReceiptLocale,
} from '@/lib/pharmacy/counter-receipt';
import {
  assertCounterBrowserPrintReady,
  buildCounterBrowserReceipt,
  counterFormatFromLayout,
  printCounterBrowserReceipt,
  reserveCounterBrowserPrint,
  type CounterBrowserPrintReservation,
  type CounterReceiptFormat,
} from '@/lib/pharmacy/counter-browser-print';
import {
  closePrintWindow,
  createPrintDocument,
  openPrintWindow,
  sendToPrintWindow,
  serializePrintDocument,
} from '@/lib/browser-print/print-window';
import {
  pharmacyBusinessDate,
  pharmacyCalendarDay,
  type PharmacyDayClock,
} from '@/lib/pharmacy/business-day';
import { counterLabel } from '@/lib/pharmacy/counter-label';
import { trpc } from '@/lib/trpc';

type Notice = {
  tone: 'success' | 'info' | 'warning' | 'danger' | 'neutral';
  message: string;
  /** DEV-910: stays on screen until the cashier dismisses it. */
  persistent?: boolean;
  inventoryBranchId?: string;
  /** DEV-860: a sale refused for a setup gap carries its fix link or whom to ask. */
  setup?: CounterSetupAdvice;
};

type ReceiptIntent = {
  saleId: string;
  branchId: string;
  receiptNumber: number | null;
  autoPrint: boolean;
  printReservation?: CounterBrowserPrintReservation;
};

/**
 * A stable per-browser identifier for the drawer session and the counter label.
 *
 * The counter is a workspace page rather than an enrolled terminal, so there is
 * no device record to borrow. Receipt numbers come from one sequence per branch
 * (DEV-637), so this id never decides a number; it must still survive a reload so
 * the drawer session and the counter printed on the receipt stay the same.
 *
 * Read on demand rather than held in state: `localStorage` does not exist
 * during the server render, and mirroring it into React state would only add a
 * cascading render to reach the same value.
 */
function counterDeviceId(scope?: { organizationId: string; branchId: string }): string {
  // DEV-957: once this computer is enrolled as a counter of this branch, its
  // drawer, receipt runway and offline document all use the enrolled device id.
  // An unenrolled browser (or another branch) keeps the per-browser id below.
  const enrolled = scope ? enrolledCounterDeviceId(scope) : null;
  if (enrolled) return enrolled;
  const key = 'devfathom.pharmacy.counter.device';
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const created = `counter-${browserUuid()}`;
  window.localStorage.setItem(key, created);
  return created;
}

const subscribeToNothing = () => () => {};
/** `null` when storage is unavailable: the tender path reports that case itself. */
function readCounterDeviceId(scope?: { organizationId: string; branchId: string }): string | null {
  try {
    return counterDeviceId(scope);
  } catch {
    return null;
  }
}
/**
 * The device id as render-time state: `null` on the server render (there is no
 * storage), the stable browser id on the client. Lets the drawer status query
 * key on the device without a setState-in-effect round trip.
 */
function useCounterDeviceId(scope: { organizationId: string; branchId: string }): string | null {
  const { organizationId, branchId } = scope;
  const read = useCallback(
    () => readCounterDeviceId({ organizationId, branchId }),
    [organizationId, branchId]
  );
  return useSyncExternalStore(subscribeCounterEnrolment, read, () => null);
}
const hydratedOnClient = () => true;
const notHydratedOnServer = () => false;
/** `false` on the server render and during hydration, `true` once on the client. */
function useHydrated(): boolean {
  return useSyncExternalStore(subscribeToNothing, hydratedOnClient, notHydratedOnServer);
}

/**
 * Today's business day on the branch's clock (the workspace's zone and, DEV-958A, the
 * branch's "day ends at" hour), as the date-only value the settlement tables store: the
 * day the day close opens on, whatever zone this device is set to. A missing or refused
 * zone reads as UTC, as the close does.
 */
function businessDate(clock: PharmacyDayClock): Date {
  return pharmacyBusinessDate(clock);
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

/**
 * DEV-712: a bill the server will never add another line or payment to. A scan
 * against it opens the next bill instead of failing with INVALID_STATE.
 */
function billClosed(cart: CounterCart | null | undefined, saleId: string | null): boolean {
  return Boolean(
    saleId && cart?.saleId === saleId && (cart.status === 'COMPLETED' || cart.status === 'VOID')
  );
}

const EMPTY_CONTROLLED_AUTH = {
  prescriptionLineId: '',
  staffProfileId: '',
  pin: '',
  rxSerialWritten: false,
  emergency: false,
  prescriberName: '',
  prescriberRegNo: '',
  refSerial: '',
};

type ControlledAuthField = keyof typeof EMPTY_CONTROLLED_AUTH;

/**
 * DEV-712: keep only the authorization fields the operator edited after the
 * bill closed — including one re-entered with the same value. Every other
 * field (the closed bill's prescriber, Rx serial, emergency flag or
 * pharmacist) is reset, so it never follows a new patient.
 */
function freshControlledAuth(
  current: typeof EMPTY_CONTROLLED_AUTH,
  edited: ReadonlySet<ControlledAuthField>
): typeof EMPTY_CONTROLLED_AUTH {
  const fresh = { ...EMPTY_CONTROLLED_AUTH };
  for (const key of edited) Object.assign(fresh, { [key]: current[key] });
  return fresh;
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

/** DEV-575: typed search fires this long after the last keystroke. */
export const COUNTER_SEARCH_DEBOUNCE_MS = 150;
/** DEV-977B: changing or removing a bill line is a server action, never done offline. */
const LINE_CHANGE_NEEDS_CONNECTION =
  'Changing or removing a line needs the connection. Reconnect, then change it on the bill.';
/** DEV-977B (Counter v2, B6): a search running this long shows its slow state. */
export const COUNTER_SLOW_SEARCH_MS = 1500;

/**
 * A barcode (six or more digits) or a GS1 payload: input a scanner sends as one
 * burst ending in Enter. It is resolved on Enter, never searched per keystroke.
 */
export function looksLikeScannedCode(text: string): boolean {
  return /^\d{6,}$/.test(text) || text.startsWith(']d2') || text.startsWith('(01)');
}

/**
 * DEV-575: text a scanner burst can be part-way through: digits, or a GS1 payload
 * (or the start of its prefix). Anything else typed during a save is a human edit.
 */
export function looksLikeScanPrefix(text: string): boolean {
  if (!text) return false;
  return (
    /^\d+$/.test(text) ||
    [']d2', '(01)'].some((prefix) => text.startsWith(prefix) || prefix.startsWith(text))
  );
}

const UNKNOWN_TENDER_MESSAGE =
  'Payment outcome is unknown. The original attempt is saved in this browser. Check payment outcome before taking more money. Refreshing the bill will not retry the payment.';

type ConsoleProps = { initialSaleId?: string | null; initialBranchId?: string };

/** DEV-977: a key named beside the control it drives (Counter v2 keycap). */
const KEYCAP_CLASS =
  'inline-flex min-h-5 items-center rounded-[var(--radius-control)] border border-border-subtle bg-surface-sunken px-1.5 font-mono text-xs font-semibold text-text-body';

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

/**
 * DEV-921: the first real reason "Add to cart" is unavailable, checked in
 * order: missing MRP, missing sale unit, then a bad quantity.
 */
export function counterAddToCartBlockReason(
  row: CounterSearchRow | null,
  option: CounterSearchRow['saleUnits'][number] | null,
  quantity: number | null
): string {
  // No sellable stock also leaves MRP and sale units empty; that is a stock
  // problem, not a pricing setup problem (see CounterUnsellableMessage).
  if (row && row.onHandUnits === 0) {
    return 'Nothing can be sold from stock here right now. Receive stock or record the shortage.';
  }
  if (row && row.printedMrpMinor === null) {
    return 'This medicine has no MRP set, so it cannot be priced. Ask the owner to add the MRP in Medicines.';
  }
  if (row && row.saleUnits.length === 0) {
    return 'This medicine has no sale unit set up. Ask the owner to add one in Medicines › Packs for receiving.';
  }
  if (row && !option) return 'Choose a sale unit to add this item.';
  if (quantity === null) return 'Enter a valid quantity to add this item.';
  return 'This item cannot be priced right now. Check its pack setup in Medicines.';
}

const LINK_CLASS =
  'inline-flex min-h-11 min-w-11 items-center font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50';

/**
 * DEV-724: why a staged medicine offers no sale unit, in shop words. "No stock
 * here" and "the pack setup needs fixing" are different jobs for the operator,
 * so they are never reported with the same message.
 */
export function CounterUnsellableMessage({ row }: { row: CounterSearchRow }) {
  if (row.onHandUnits === 0) {
    // Blocked balances are excluded from on-hand units, so zero sellable stock
    // is not the same as no stock: say which it is.
    if (row.blocked.length > 0) {
      return (
        <>
          None of the stock here can be sold right now (
          {row.blocked.map((reason) => reason.toLowerCase().replace(/_/g, ' ')).join(', ')}).
          Receive fresh stock or record it as a shortage.
        </>
      );
    }
    return <>Out of stock at this branch. Receive stock or record it as a shortage.</>;
  }
  const name = counterMedicineDisplayName(row);
  const fix = (
    <>
      {' '}
      Open{' '}
      <Link href="/pharmacy/medicines" className={LINK_CLASS}>
        Medicines › {name} › Packs for receiving
      </Link>{' '}
      to fix it.
    </>
  );
  if (row.packMismatch) {
    return (
      <>
        This batch was received as {row.packMismatch.received} but the medicine is set up as{' '}
        {row.packMismatch.setup ?? 'a different pack'}, so it cannot be priced.
        {fix}
      </>
    );
  }
  return (
    <>
      This medicine&apos;s pack setup does not match the batch on hand, so it cannot be priced.
      {fix}
    </>
  );
}

export function PharmacyCounterConsole(props: ConsoleProps = {}) {
  const { data: liveSession, status: liveStatus } = useSession();
  const entitlements = useEntitlements();
  const browserOnline = useBrowserOnline();
  // DEV-957: with no connection, a session re-check (on tab focus) cannot reach
  // the server and reads as signed out. While the browser is offline the counter
  // keeps the person it last verified, so the offline banner and price check
  // stay on screen; nothing offline reaches the server, and the first online
  // re-check decides again. Online, the live answer is used unchanged.
  const [verifiedSession, setVerifiedSession] = useState(liveSession);
  if (liveStatus === 'authenticated' && liveSession !== verifiedSession)
    setVerifiedSession(liveSession);
  const holdOffline = !browserOnline && liveStatus === 'unauthenticated' && verifiedSession;
  const session = holdOffline ? verifiedSession : liveSession;
  const status = holdOffline ? 'authenticated' : liveStatus;
  const user = session?.user;
  // DEV-970: once the session has ended (signed out, expired or revoked; not merely
  // offline), the next sign-in sees the ready-to-sell panel in full again.
  const sessionEnded =
    status === 'unauthenticated' || (status === 'authenticated' && !evaluateSessionUser(user).ok);
  useEffect(() => {
    if (sessionEnded) clearCounterReadinessOkay();
  }, [sessionEnded]);
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
      <CounterFrame>
        <CounterFrameContent>
          <SectionCard title="Counter unavailable">
            <p role="status" className="text-sm text-text-body">
              {status === 'loading'
                ? 'Checking counter access…'
                : 'Sign in with an authorized pharmacy account to open this counter.'}
            </p>
          </SectionCard>
        </CounterFrameContent>
      </CounterFrame>
    );
  }
  return (
    <CounterApprovalMode>
      <ScopedPharmacyCounterConsole
        {...props}
        key={JSON.stringify([
          user.organizationId,
          user.id,
          user.role,
          user.status,
          [...entitlements.enabledModules].sort(),
        ])}
        organizationId={user.organizationId}
        accountId={user.id}
        evidenceAuthorized={user.role === 'ADMIN'}
        keymapPreviewAuthorized={user.role === 'ADMIN'}
        safetyLicensed={isModuleGranted('pharmacy-safety', entitlements.enabledModules)}
        dispensingLicensed={isModuleGranted('pharmacy-dispensing', entitlements.enabledModules)}
        accountEmail={user.email}
      />
    </CounterApprovalMode>
  );
}

/**
 * DEV-961: the counter's approval fields follow the owner's "Authenticator for approvals"
 * setting: "Approval code" while it is on (the default, and until it is read), "Approver PIN"
 * while the owner has it off. The server decides either way; this is the wording only.
 */
function CounterApprovalMode({ children }: { children: React.ReactNode }) {
  return (
    <ApprovalSecretKindContext.Provider value={useApprovalSecretKind()}>
      {children}
    </ApprovalSecretKindContext.Provider>
  );
}

type CounterBrowserPrintAudit = {
  branchId: string;
  saleId: string;
  locale: CounterReceiptLocale;
} & ({ copyNumber: number; failed?: never } | { failed: true; copyNumber?: never });

const PRINT_AUDIT_RETRY_MS = 2_000;
const PRINT_AUDIT_MAX_RETRIES = 5;

/** Transport faults can be retried; rejected allocation bindings cannot. */
function isRetryablePrintAuditError(error: unknown): boolean {
  const code = (error as { data?: { code?: string } } | null)?.data?.code;
  return !['CONFLICT', 'FORBIDDEN', 'UNAUTHORIZED', 'BAD_REQUEST', 'NOT_FOUND'].includes(
    code ?? ''
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
  keymapPreviewAuthorized = false,
  safetyLicensed,
  dispensingLicensed = false,
  accountEmail,
}: ConsoleProps & {
  organizationId: string;
  accountId: string;
  evidenceAuthorized?: boolean;
  keymapPreviewAuthorized?: boolean;
  /** Pharmacy Safety owns the approving-pharmacist list; without it that read is refused. */
  safetyLicensed: boolean;
  /** Pharmacy Dispensing owns the substitution workspace the Rx hand-off links to. */
  dispensingLicensed?: boolean;
  accountEmail: string;
}) {
  const utils = trpc.useUtils();

  const [selectedBranchId, setSelectedBranchId] = useState(initialBranchId);
  const [query, setQuery] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState({ text: '', query: '', branchId: '' });
  const submittedQuery = submittedSearch.query;
  const scannerRevision = useRef(0);
  const [catalogueCache] = useState(() => new CounterCatalogueCache());
  const completedAdds = useRef(0);
  // Bumped with every confirmed add; the scan field clears its local draft on it.
  const [addVersion, setAddVersion] = useState(0);
  // DEV-748: bumped when a scanned loyalty card is taken out of the search field, so the scan
  // input drops its draft; added to addVersion (both only grow) to form its reset version.
  const [cardScanResets, setCardScanResets] = useState(0);
  // DEV-575: complete scans entered while a line is saving, added in order afterwards.
  const [scanQueue, setScanQueue] = useState<{ code: string; branchId: string }[]>([]);
  const [drainingScan, setDrainingScan] = useState(false);
  const [scanSettles, setScanSettles] = useState(0);
  const drainedScan = useRef<string | null>(null);
  const lastAddOutcome = useRef<'added' | 'pending'>('added');
  const lineAttempts = useRef(new Map<string, string>());
  const scannerInFlight = useRef<{ text: string; branchId: string; revision: number } | null>(null);
  const packApprovalResolver = useRef<((approval: CounterApprovalPin | null) => void) | null>(null);
  // DEV-929: the same dialog approves a manual discount; `discount` describes it.
  const [packApproval, setPackApproval] = useState<{
    medicineName: string;
    discount?: string;
  } | null>(null);
  const finishPackApproval = useCallback((approval: CounterApprovalPin | null) => {
    const resolve = packApprovalResolver.current;
    packApprovalResolver.current = null;
    setPackApproval(null);
    resolve?.(approval);
  }, []);
  const [activeRow, setActiveRow] = useState<CounterSearchRow | null>(null);
  const [saleUnit, setSaleUnit] = useState<SaleUnitKind | null>(null);
  const [quantityText, setQuantityText] = useState('1');
  const [lotOverride, setLotOverride] = useState<CounterLotOverrideValue | null>(null);
  const [saleId, setSaleId] = useState<string | null>(initialSaleId);
  const [heldSaleId, setHeldSaleId] = useState<string | null>(null);
  const [patientQuery, setPatientQuery] = useState('');
  const [submittedPatientQuery, setSubmittedPatientQuery] = useState('');
  const [controlledAuth, setControlledAuth] = useState(EMPTY_CONTROLLED_AUTH);
  // DEV-780: a voucher checked and confirmed with the cashier's own PIN, sent with the next
  // item added. It is dropped after that add, whatever the outcome, so the PIN is not kept.
  const [voucherHold, setHeldVoucher] = useState<
    (CounterHeldVoucher & { branchId: string }) | null
  >(null);
  // DEV-929: a manual discount for the next item added, dropped after that add.
  const [discountHold, setHeldDiscount] = useState<
    (CounterHeldDiscount & { branchId: string }) | null
  >(null);
  const pharmacistsQuery = trpc.pharmacySafety.controlledPharmacists.useQuery(undefined, {
    enabled: safetyLicensed,
  });
  // DEV-35: the same ABAC read the rail uses decides whether the Rx substitute
  // hand-off links to the substitution workspace (dispense or Pharmacy Safety).
  const railAccess = trpc.pharmacyAccess.navigation.useQuery(undefined, {
    enabled: Boolean(accountId),
    retry: (failures, error) => failures < 2 && error.data?.code !== 'FORBIDDEN',
    staleTime: 30_000,
  });
  const canOpenSubstitution =
    dispensingLicensed &&
    railAccess.data?.userId === accountId &&
    (railAccess.data?.capabilities ?? []).some(
      (capability) => capability === 'pharmacy:dispense' || capability === 'pharmacy:safety'
    );
  // DEV-323: prescription upload/capture need Pharmacy Dispensing and
  // `pharmacy:prescriptions` on the server; a cashier is not offered them.
  const canCapturePrescription =
    dispensingLicensed &&
    railAccess.data?.userId === accountId &&
    (railAccess.data?.capabilities ?? []).includes('pharmacy:prescriptions');
  // DEV-950: who may be offered to sign a prescription line at payment (the server decides).
  const canSignPrescriptionLines =
    dispensingLicensed &&
    railAccess.data?.userId === accountId &&
    (railAccess.data?.capabilities ?? []).includes('pharmacy:dispense');
  const [patientId, setPatientId] = useState<string | null>(null);
  const [patientAddressDraft, setPatientAddressDraft] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [redeemPoints, setRedeemPoints] = useState(0);
  // DEV-748: a card code typed by hand when the scanner cannot read the card.
  const [cardCodeText, setCardCodeText] = useState('');
  const [receiptLocale, setReceiptLocale] = useState<CounterReceiptLocale>('en');
  // DEV-742: a cashier's paper choice overrides the branch's saved paper for this session only.
  const [receiptFormatChoice, setReceiptFormatChoice] = useState<{
    branchId: string;
    format: CounterReceiptFormat;
  } | null>(null);
  const [receiptReprint, setReceiptReprint] = useState(false);
  const [autoPrint, setAutoPrint] = useState(false);
  const [receiptSettlement, setReceiptSettlement] = useState<CounterReceiptSettlement | null>(null);
  const [settledChange, setSettledChange] = useState<{
    branchId: string;
    saleId: string;
    minor: number;
  } | null>(null);
  // Keep the receipt the cashier is reviewing independent from query lifecycle
  // changes. A background invalidation must not replace an issued receipt with
  // a loading/error state while its drawer is open.
  const [lastReceipt, setLastReceipt] = useState<{
    branchId: string;
    receipt: CounterReceipt;
  } | null>(null);
  const receiptIntent = useRef<ReceiptIntent | null>(null);
  // The patient on the bill when it was first seen paid or voided, and the
  // authorization fields the operator has edited since then (DEV-712).
  const closedBillPatient = useRef<{
    saleId: string;
    patientId: string | null;
    editedAuth: Set<ControlledAuthField>;
  } | null>(null);
  const autoPrintRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    if (!notice || notice.persistent) return;
    if (notice.tone !== 'success' && notice.tone !== 'info') return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const [pending, setPending] = useState<string | null>(null);
  // DEV-508: Void and Shift+F4 open a reason-and-confirm dialog; nothing is voided until confirmed.
  const [voidOpen, setVoidOpen] = useState(false);
  const online = useBrowserOnline();
  // DEV-81: the short line whose optional outcome chips are showing.
  const [lostSaleCapture, setLostSaleCapture] = useState<{
    branchId: string;
    demandId: string;
    requested: string;
  } | null>(null);
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
  // DEV-712: payment keys a supervisor discarded. The server refuses them for good, so the
  // next payment of the same amount on the same bill is sent under a fresh key.
  const discardedTenderKeys = useRef(new Set<string>());

  const searchRef = useRef<HTMLInputElement>(null);
  const quantityRef = useRef<HTMLInputElement>(null);
  const focusQuantityOnStage = useRef(false);
  // The default quantity of 1 is a proposal until the cashier has looked at it (DEV-633).
  const quantityReviewed = useRef(false);
  const restoreSearchAfterAdd = useRef(false);
  const rxPanelRef = useRef<HTMLDivElement>(null);
  const tenderRef = useRef<HTMLDivElement>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  // DEV-977: choosing a result (click or Enter) closes the results over the bill so the line
  // being added is in view; typing or arrowing through results opens them again.
  const [resultsDismissed, setResultsDismissed] = useState(false);
  // DEV-977B (Counter v2, A6): the result the arrows are on. Moving through results no longer
  // stages a line; Enter adds the highlighted one in one step.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // DEV-977B: "Adds as" (F3 pack, F4 strip, F5 unit), chosen before or while searching. Null
  // adds each medicine in its usual unit.
  const [addUnit, setAddUnit] = useState<SaleUnitKind | null>(null);
  // DEV-977B: the sale units of medicines added from search, so their bill line can switch unit.
  const knownSaleUnits = useRef(new Map<string, readonly SaleUnitOption[]>());
  // DEV-977B: retry keys for a line change or removal whose answer was lost.
  const lineChangeKeys = useRef(new Map<string, string>());
  const actionsButtonRef = useRef<HTMLButtonElement>(null);
  const actionsPanelRef = useRef<HTMLDivElement>(null);
  const [checksOpen, setChecksOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [loyaltyOpen, setLoyaltyOpen] = useState(false);

  // ── Data ──────────────────────────────────────────────────────────────────

  const branchesQuery = trpc.pharmacySales.counterBranches.useQuery(undefined, {
    staleTime: 60_000,
  });
  const branches = useMemo(() => branchesQuery.data?.branches ?? [], [branchesQuery.data]);
  const workspaceZone = branchesQuery.data?.timezone;

  // Derived, not mirrored into state: the default branch is simply "the first
  // one" until the operator picks another, so an effect would only add a render.
  // DEV-957: an enrolled counter opens on its own branch, also offline when the
  // branch list cannot be loaded; an unenrolled browser keeps "the first one".
  const counterEnrolment = useCounterEnrolment(organizationId);
  const enrolledBranchId =
    counterEnrolment &&
    (branches.length === 0 || branches.some((branch) => branch.id === counterEnrolment.branchId))
      ? counterEnrolment.branchId
      : null;
  const branchId = selectedBranchId || enrolledBranchId || (branches[0]?.id ?? '');
  // Every drawer, tender and loyalty write is stamped with the branch's business day:
  // DEV-958A, the workspace's day ending at the branch's "day ends at" hour.
  const dayEnd = branches.find((entry) => entry.id === branchId)?.businessDayEndsAtHistory;
  const todayBusinessDate = useCallback(
    () => businessDate({ timeZone: workspaceZone, dayEnd }),
    [workspaceZone, dayEnd]
  );
  const recoveryScope = useMemo<TenderAttemptScope>(
    () => ({ organizationId, accountId, branchId }),
    [organizationId, accountId, branchId]
  );
  // A voucher belongs to the branch it was checked at; switching branch drops it.
  // DEV-957: an enrolled counter of this branch keeps its last verified price
  // list for offline price check; an unenrolled browser stays online-only.
  const offlineMode = useCounterOffline({ organizationId, branchId, online });
  const heldVoucher = voucherHold?.branchId === branchId ? voucherHold : null;
  const heldDiscount = discountHold?.branchId === branchId ? discountHold : null;
  const branchAuthorized =
    branchesQuery.isSuccess &&
    !branchesQuery.isError &&
    branches.some((branch) => branch.id === branchId);

  // DEV-97: the drawer and payment controls belong to whoever takes payment
  // (`pharmacy:counter`). A pharmacist builds the bill and counter staff take it.
  // Only a confirmed answer for this account counts; a failed read withholds
  // payment. The server stays the authority for every drawer and tender write.
  const settlementAccess = trpc.pharmacySales.settlementAccess.useQuery(undefined, {
    retry: false,
  });
  const settlementIdentityMatches =
    settlementAccess.data?.userId === accountId &&
    settlementAccess.data.organizationId === organizationId;
  const canSettlePayments =
    settlementIdentityMatches &&
    settlementAccess.data?.authorized === true &&
    !settlementAccess.isError;
  // Only a confirmed "no" lifts the opening-drawer step (DEV-725): while access is
  // unknown, a cashier still opens the drawer before the first bill.
  const settlementDenied =
    settlementIdentityMatches &&
    settlementAccess.data?.authorized === false &&
    !settlementAccess.isError;
  const savedReceiptFormat = trpc.pharmacySales.counterReceiptFormat.useQuery(
    { branchId },
    { enabled: branchAuthorized, staleTime: 60_000, retry: false }
  );
  const receiptFormat =
    receiptFormatChoice?.branchId === branchId
      ? receiptFormatChoice.format
      : counterFormatFromLayout(savedReceiptFormat.data?.layout);
  const setReceiptFormat = useCallback(
    (format: CounterReceiptFormat) => setReceiptFormatChoice({ branchId, format }),
    [branchId]
  );

  useEffect(
    () => () => {
      scannerRevision.current += 1;
      catalogueCache.clear();
      // A scan cancelled by this change must not discard scans queued for the next branch.
      drainedScan.current = null;
      lastAddOutcome.current = 'added';
    },
    [branchAuthorized, branchId, catalogueCache]
  );

  useEffect(
    () => () => {
      packApprovalResolver.current?.(null);
      packApprovalResolver.current = null;
    },
    [branchAuthorized, branchId]
  );

  const loadScannedPackApprovers = useCallback(
    () => utils.client.pharmacySales.scannedPackFefoApprovers.query({ branchId }),
    [branchId, utils]
  );
  const loadDiscountApprovers = useCallback(
    () => utils.client.pharmacySales.discountApprovers.query({ branchId }),
    [branchId, utils]
  );
  // DEV-956: the whole-bill discount is approved in the same dialog as an item discount.
  const requestBillDiscountApproval = useCallback(
    (discount: string) =>
      new Promise<CounterApprovalPin | null>((resolve) => {
        packApprovalResolver.current = resolve;
        setPackApproval({ medicineName: 'Whole bill', discount });
      }),
    []
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
        setHeldVoucher(null);
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
  const keymap =
    keymapQuery.data && (keymapQuery.data.preset.confirmed || keymapPreviewAuthorized)
      ? keymapQuery.data
      : resolveCounterKeymap({ preset: 'devfathom' });
  // Preserve operator overrides before offering a receipt-only shortcut.
  const lastReceiptShift = !matchCounterAction(keymap.bindings, { key: 'r', altKey: true })
    ? false
    : !matchCounterAction(keymap.bindings, { key: 'R', altKey: true, shiftKey: true })
      ? true
      : null;
  const lastReceiptShortcut =
    lastReceiptShift === null ? undefined : lastReceiptShift ? 'Alt+Shift+R' : 'Alt+R';
  const saveKeymap = trpc.pharmacySales.counterSaveKeymap.useMutation({
    onSuccess: (saved) => {
      utils.pharmacySales.counterKeymap.setData(undefined, saved);
      void utils.pharmacySales.counterKeymap.invalidate();
      setNotice({ tone: 'success', message: 'Keymap saved for this operator.' });
    },
    onError: (error) => setNotice({ tone: counterErrorTone(error), message: messageFrom(error) }),
  });

  const trimmedQuery = query.trim();
  // DEV-575: a scanner types a code in a burst and ends it with Enter, so a code
  // being typed never fires a search per digit; Enter submits it.
  // DEV-748: a loyalty card code is never sent to the medicine search either.
  const scannerQuery = looksLikeScannedCode(trimmedQuery) || looksLikeLoyaltyCardCode(trimmedQuery);
  // A name search follows the selected branch, including one submitted (or debounced)
  // just before a branch change, so it never waits on the old branch.
  if (
    branchAuthorized &&
    trimmedQuery.length >= 2 &&
    !scannerQuery &&
    submittedSearch.text === trimmedQuery &&
    submittedSearch.branchId !== branchId
  )
    setSubmittedSearch({ text: trimmedQuery, query: trimmedQuery, branchId });
  const searchCurrent =
    branchAuthorized &&
    trimmedQuery.length >= 2 &&
    submittedSearch.text === trimmedQuery &&
    submittedSearch.branchId === branchId;

  const searchQuery = trpc.pharmacySales.counterSearch.useQuery(
    { branchId, query: submittedQuery },
    {
      enabled: searchCurrent && submittedQuery.length >= 2,
      staleTime: 10_000,
      // A superseded search is cancelled rather than left to finish on the server.
      trpc: { abortOnUnmount: true },
    }
  );
  const searchState =
    !branchAuthorized || trimmedQuery.length < 2 || (scannerQuery && !searchCurrent)
      ? 'idle'
      : !searchCurrent || searchQuery.isFetching || searchQuery.isPlaceholderData
        ? 'loading'
        : searchQuery.isError
          ? 'error'
          : 'ready';
  // DEV-977B (Counter v2): a search still running after a moment says so.
  const [slowQuery, setSlowQuery] = useState<string | null>(null);
  useEffect(() => {
    if (searchState !== 'loading') return;
    const timer = window.setTimeout(() => setSlowQuery(trimmedQuery), COUNTER_SLOW_SEARCH_MS);
    return () => window.clearTimeout(timer);
  }, [searchState, trimmedQuery]);
  const slowSearch = searchState === 'loading' && slowQuery === trimmedQuery;

  const cartQuery = trpc.pharmacySales.counterCart.useQuery(
    { branchId, saleId: saleId ?? '' },
    { enabled: Boolean(branchId && saleId), staleTime: 30_000 }
  );
  // DEV-623: every unpaid bill in the branch, so none is stranded with its stock.
  const openBillsQuery = trpc.pharmacySales.openBills.useQuery(
    { branchId },
    { enabled: branchAuthorized, staleTime: 15_000 }
  );
  const refetchOpenBills = openBillsQuery.refetch;

  // POS-07: one OPEN drawer per counter device. The header offers "Open drawer"
  // only once the server has said this device has none; while one is open it
  // shows the drawer instead, so a second open is never offered.
  const deviceId = useCounterDeviceId({ organizationId, branchId });
  const currentCounterDeviceId = useCallback(
    () => counterDeviceId({ organizationId, branchId }),
    [organizationId, branchId]
  );
  /** DEV-977B: the counter device a line change names, so the server checks its drawer's shift. */
  const counterDevice = useCallback(() => {
    const id = currentCounterDeviceId();
    return id ? { deviceId: id } : {};
  }, [currentCounterDeviceId]);
  const drawerQueryEnabled = Boolean(branchAuthorized && branchId && deviceId && !settlementDenied);
  // On the client a missing device id means site storage is blocked: no drawer
  // can be read or opened, so the step says so instead of waiting forever.
  const deviceUnavailable = useHydrated() && deviceId === null;
  const tradingDayQuery = trpc.pharmacySales.tradingDayStatus.useQuery(
    { branchId },
    { enabled: branchAuthorized, staleTime: 30_000, refetchInterval: 30_000 }
  );
  const drawerQuery = trpc.pharmacySales.drawerStatus.useQuery(
    { branchId, deviceId: deviceId ?? '' },
    { enabled: drawerQueryEnabled, staleTime: 30_000 }
  );
  // A disabled query still returns cached data, so a revoked grant drops it here.
  const openDrawerSession = settlementDenied ? null : (drawerQuery.data?.openDrawer ?? null);
  const drawerStatusKnown = drawerQuery.isSuccess || drawerQuery.isError;
  // DEV-725: opening the drawer is the first step of the shift. Until the server
  // reports an OPEN drawer for this device, the opening-cash step replaces
  // scan/search, so no bill is built that cannot be charged. A failed status read
  // keeps the step, with a retry, rather than offering a bill the server refuses.
  // A failed read is an unknown drawer, even when older data says it was open.
  const drawerOpen = Boolean(openDrawerSession) && !drawerQuery.isError;
  // DEV-97: someone who takes no payment opens no drawer, and still builds bills.
  const drawerRequired = branchAuthorized && !settlementDenied && !drawerOpen;
  // DEV-958B: a drawer whose branch runs cash shifts takes money only inside a shift. Between
  // shifts the next cashier opens theirs in place of scan/search; the server refuses otherwise.
  const cashShift =
    settlementDenied || !drawerOpen || !drawerQuery.data || !('cashShift' in drawerQuery.data)
      ? undefined
      : drawerQuery.data.cashShift;
  const shiftRequired = Boolean(cashShift && !cashShift.openShift);
  // DEV-631: the business day is closed, so the counter says so before a bill is
  // built rather than only when payment is refused. The server still refuses it.
  const dayClosed =
    branchAuthorized && !tradingDayQuery.isError && tradingDayQuery.data?.dayClosed === true;
  // DEV-860: the ready-to-sell check lists missing setup before the first scan. The
  // server answers with reason codes and whether this account may fix them.
  const saleReadiness = trpc.pharmacySales.saleReadiness.useQuery(
    { branchId, ...(deviceId ? { deviceId } : {}) },
    { enabled: Boolean(branchAuthorized && branchId), staleTime: 30_000, retry: false }
  );
  // Both answers come from the same administrator rule on the server. The branch list
  // loads before any scan, so a refusal while readiness is loading or failed still
  // offers an administrator the setup link.
  const canFixSetup =
    saleReadiness.data?.canFixSetup === true || branchesQuery.data?.canFixSetup === true;
  const refetchSaleReadiness = saleReadiness.refetch;
  // DEV-905: a refusal for a workspace waiting on approval says so, like the panel does.
  const organizationApproval = saleReadiness.data?.approval ?? null;
  const setupNotice = useCallback(
    (error: unknown): { setup?: CounterSetupAdvice } => {
      const reason = counterSetupReason(error);
      // The drawer has its own step on the counter; nobody else is asked to open it.
      if (!reason || reason === 'DRAWER_NOT_OPEN') return {};
      return {
        setup: counterSetupAdvice(reason, {
          canFixSetup,
          branchId,
          approval: organizationApproval,
        }),
      };
    },
    [organizationApproval, branchId, canFixSetup]
  );
  // DEV-911: the owner switched the pharmacist check at each sale off. Only an explicit OFF
  // from the server counts; unknown (loading, failed, offline before a read) means on. The
  // server reads the stored setting again at every line, payment and completion.
  const pharmacistCheckOff =
    (saleReadiness.data as { pharmacistCheckOff?: boolean } | undefined)?.pharmacistCheckOff ===
    true;
  // Read at call time: a scan or shortcut can finish after the drawer closed.
  const drawerRequiredRef = useRef(drawerRequired);
  const dayClosedRef = useRef(dayClosed);
  const pharmacistCheckOffRef = useRef(pharmacistCheckOff);
  useEffect(() => {
    drawerRequiredRef.current = drawerRequired || shiftRequired;
    dayClosedRef.current = dayClosed;
    pharmacistCheckOffRef.current = pharmacistCheckOff;
  }, [drawerRequired, shiftRequired, dayClosed, pharmacistCheckOff]);

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
  const changeLine = trpc.pharmacySales.changeLine.useMutation();
  const removeLine = trpc.pharmacySales.removeLine.useMutation();
  const transition = trpc.pharmacySales.transition.useMutation();
  const tender = trpc.pharmacySales.tender.useMutation({ retry: false });
  // DEV-641: only a request React Query is holding for the connection is queued.
  // A dispatched payment or its post-acceptance bill read is not waiting to send.
  const paymentQueued = pending === 'tender' && tender.isPaused;
  const allocateBrowserPrint = trpc.pharmacySales.counterReceiptBrowserPrint.useMutation({
    retry: false,
  });
  const recordBrowserPrint = trpc.pharmacySales.counterReceiptBrowserPrintDispatched.useMutation({
    retry: false,
  });
  const recordBrowserPrintFailure = trpc.pharmacySales.counterReceiptBrowserPrintFailed.useMutation(
    {
      retry: false,
    }
  );
  const sendWhatsAppReceipt = trpc.pharmacySales.counterReceiptWhatsApp.useMutation({
    retry: false,
  });
  const manualSettings = trpc.pharmacySales.manualPaymentSettings.useQuery(
    { branchId },
    { enabled: Boolean(branchId) && canSettlePayments }
  );
  const openDrawer = trpc.pharmacySales.openDrawer.useMutation();
  // DEV-821: a manager or owner names who runs a till and can hand it over. The
  // cashier list is a manager read; a cashier's request is refused and shows nothing.
  const managerAccess = trpc.pharmacySales.refundAccess.useQuery(undefined, {
    enabled: branchAuthorized && !settlementDenied,
    retry: false,
  });
  const actorIsManager =
    managerAccess.isSuccess && !managerAccess.isError && managerAccess.data?.authorized === true;
  const drawerCashiers = trpc.pharmacySales.drawerCashiers.useQuery(
    { branchId },
    { enabled: actorIsManager && Boolean(branchId), retry: false, staleTime: 60_000 }
  );
  const handoverDrawer = trpc.pharmacySales.handoverDrawer.useMutation();
  const drawerOperatingCashier = settlementDenied
    ? null
    : (drawerQuery.data?.operatingCashier ?? null);
  const captureDemand = trpc.pharmacySales.captureDemand.useMutation();
  const setDemandOutcome = trpc.pharmacySales.setDemandOutcome.useMutation();
  const declineSubstitute = trpc.pharmacySales.declineSubstitute.useMutation();
  const linkCustomer = trpc.pharmacySales.linkCustomer.useMutation();
  const scanLoyaltyCard = trpc.pharmacySales.scanLoyaltyCard.useMutation({ retry: false });
  const khataSignup = trpc.pharmacySales.khataSignup.useMutation();
  const redeemLoyalty = trpc.pharmacySales.redeemPoints.useMutation();
  const authenticatePack = trpc.pharmacySales.authenticatePack.useMutation();

  const refreshCart = useCallback(async () => {
    await refreshCounterQueries(utils.pharmacySales);
  }, [utils]);

  const setActiveSale = useCallback(
    (nextSaleId: string | null) => {
      discardReceiptIntent();
      setReceiptSettlement(null);
      setSettledChange(null);
      setReceiptOpen(false);
      setSaleId(nextSaleId);
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
  const locationName = activeRow?.storage.locationName?.trim() || activeRow?.storage.locationKind;
  const locationCode = activeRow?.storage.locationCode;
  const locationLabel =
    !locationCode || locationName === locationCode || locationName?.endsWith(` ${locationCode}`)
      ? locationName
      : `${locationName ?? 'Location'} ${locationCode}`;

  const selectedOption = useMemo(
    () => activeRow?.saleUnits.find((option) => option.kind === saleUnit) ?? null,
    [activeRow, saleUnit]
  );
  // Keep the editable draft separate from the integer used by previews and writes.
  const parsedQuantity = Number(quantityText);
  const quantity =
    /^\d+$/.test(quantityText) && Number.isSafeInteger(parsedQuantity) && parsedQuantity > 0
      ? parsedQuantity
      : null;

  const preview = useMemo(
    () => (quantity === null ? null : counterSelectionPreview(activeRow, selectedOption, quantity)),
    [activeRow, quantity, selectedOption]
  );

  const requestedCanonicalUnits =
    quantity === null
      ? null
      : selectedOption
        ? selectedOption.canonicalUnitsPerSaleUnit * quantity
        : activeRow?.saleUnits.length === 0
          ? quantity
          : null;
  const shortfallUnits =
    activeRow &&
    requestedCanonicalUnits !== null &&
    Number.isSafeInteger(requestedCanonicalUnits) &&
    requestedCanonicalUnits > 0
      ? Math.max(
          0,
          requestedCanonicalUnits - (activeRow.medicineOnHandUnits ?? activeRow.onHandUnits)
        )
      : 0;
  const substituteInput =
    activeRow &&
    selectedOption &&
    requestedCanonicalUnits !== null &&
    (activeRow.medicineOnHandUnits ?? activeRow.onHandUnits) < requestedCanonicalUnits
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
      // DEV-629: a non-controlled line is covered only by the prescription the server attached
      // to it, because that is what settlement checks; a controlled line keeps its register gate.
      const prescriptionLine = patient?.prescriptions
        .flatMap((prescription) => prescription.lines.map((entry) => ({ prescription, entry })))
        .find(({ entry }) =>
          line.controlled
            ? entry.medicineId === line.medicineId
            : Boolean(line.prescriptionLineId) &&
              entry.prescriptionLineId === line.prescriptionLineId
        );
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
              // DEV-629: settlement needs the signed review of this sale line, not any earlier one.
              verified: line.controlled
                ? prescriptionLine.entry.verified
                : (line.prescriptionSigned ?? false),
              validFrom: new Date(prescriptionLine.prescription.validFrom),
              validUntil: new Date(prescriptionLine.prescription.validUntil),
              remainingAuthorizedUnits:
                prescriptionLine.entry.remainingAuthorizedUnits +
                (line.controlled && prescriptionLine.entry.verified ? line.canonicalUnits : 0),
            }
          : null,
        requestedCanonicalUnits: line.canonicalUnits,
        nearestSafeExpiry: line.allocations[0]?.expiresAt
          ? new Date(line.allocations[0].expiresAt)
          : null,
        discountMinor: line.discountMinor,
      };
    });
    return counterAlertsFor(lines, { at: new Date(), timeZone: workspaceZone, pharmacistCheckOff });
  }, [cart, patient, workspaceZone, pharmacistCheckOff]);

  const blocked = hasBlockingAlert(alerts);
  const safetyLabel = blocked
    ? `${alerts.filter((alert) => alert.severity === 'SAFETY_BLOCK').length} safety block · payment locked`
    : `No safety blocks · ${alerts.length} notes to pass on`;
  const loyaltyLabel = customerQuery.data
    ? `${customerQuery.data.pointsBalance} loyalty points${customerQuery.data.customer.creditLimitMinor > 0 || customerQuery.data.creditBalanceMinor > 0 ? ' · Khata' : ''}`
    : 'Loyalty and khata · not linked';
  const currentBill = hasValidBill(cart, saleId);
  const currentBillClosed = billClosed(cart, saleId);
  useEffect(() => {
    if (currentBillClosed && saleId && closedBillPatient.current?.saleId !== saleId)
      closedBillPatient.current = { saleId, patientId, editedAuth: new Set() };
  }, [currentBillClosed, patientId, saleId]);
  const balanceMinor = currentBill ? cart.totals.netMinor - cart.totals.tenderedMinor : null;
  const paidMinor = currentBill ? cart.totals.tenderedMinor : 0;
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
  // #1254: opening the drawer moves no money for this bill, so the bill re-read a
  // refused payment demands must not lock "Open drawer", the usual fix for that refusal.
  const drawerBusy =
    pending !== null ||
    unknownTender ||
    refreshingTenderBill ||
    !recoveryReady ||
    attempt !== null ||
    checkingOutcome;
  const busy = drawerBusy || tenderReadRequired;
  // Every busy state other than a counter action in progress (`pending`).
  const sessionBusy =
    tenderReadRequired ||
    unknownTender ||
    refreshingTenderBill ||
    !recoveryReady ||
    attempt !== null ||
    checkingOutcome;
  const queuedScans = scanQueue.filter((scan) => scan.branchId === branchId).length;
  // DEV-575: a line save (or a queued scan) keeps the scan field live, so the next
  // scanner burst is buffered instead of being typed into a disabled field.
  const bufferScans =
    !sessionBusy &&
    branchAuthorized &&
    (pending === 'addToCart' || drainingScan || queuedScans > 0);
  const lineCount = cart?.lines.length ?? 0;
  const describeBusy = (billReadRequired: boolean) =>
    unknownTender || attempt !== null || checkingOutcome
      ? 'Check the payment outcome before changing this bill or branch.'
      : storageError
        ? 'Browser recovery is unavailable. Review payment status before continuing.'
        : billReadRequired
          ? 'Refresh this bill to verify payment before continuing.'
          : !recoveryReady
            ? 'Checking saved payment details. Please wait.'
            : 'Wait for the current counter action to finish.';
  const counterBusyReason = busy ? describeBusy(tenderReadRequired) : null;
  const branchControlReason = !branchAuthorized
    ? 'Select a branch you can access before continuing.'
    : counterBusyReason;
  const billActionReason =
    counterBusyReason ??
    (!saleId
      ? 'Start or resume an open bill to hold or void it.'
      : cart?.status === 'OPEN'
        ? null
        : cart?.status === 'HELD'
          ? 'Resume this held bill before holding or voiding it.'
          : currentBillClosed
            ? 'This bill is closed. Start or resume an open bill to hold or void it.'
            : 'Wait for the open bill to load before holding or voiding it.');
  const resumeDisabledReason =
    counterBusyReason ??
    (!heldSaleId ? 'No bill is held on this counter. Use Open bills to find another bill.' : null);
  const resumeReasonId = resumeDisabledReason
    ? resumeDisabledReason === billActionReason
      ? 'counter-bill-action-reason'
      : 'counter-resume-reason'
    : undefined;
  const drawerDisabledReason = !canSettlePayments
    ? settlementAccess.isError
      ? "Couldn't check payment access. Retry payment access before opening the drawer."
      : 'Checking payment access before opening the drawer.'
    : drawerBusy
      ? describeBusy(false)
      : !drawerStatusKnown
        ? 'Checking the cash drawer. Please wait.'
        : null;

  // DEV-623: the bill open on this device survives a reload. It is restored once
  // payment recovery has run (an in-flight payment takes precedence), and only
  // when the server's own cart read still says OPEN; otherwise it is forgotten
  // here and stays under Open bills.
  const activeBillScope = useMemo<ActiveBillScope | null>(
    () => (branchAuthorized && branchId ? { organizationId, accountId, branchId } : null),
    [accountId, branchAuthorized, branchId, organizationId]
  );
  const activeBillKey = JSON.stringify([organizationId, accountId, branchId]);
  // The scope whose remembered bill has been checked; nothing is written before.
  const activeBillChecked = useRef<string | null>(null);
  const currentSaleId = useRef(saleId);
  useEffect(() => {
    currentSaleId.current = saleId;
  }, [saleId]);
  useEffect(() => {
    if (!activeBillScope) return;
    if (activeBillChecked.current !== activeBillKey) {
      if (!recoveryReady) return;
      activeBillChecked.current = activeBillKey;
      const stored = saleId || attemptRef.current ? null : readActiveBill(activeBillScope);
      if (stored) {
        // Still this scope, still no bill on the counter, and the stored id unchanged.
        const unchanged = () =>
          activeBillChecked.current === activeBillKey &&
          !currentSaleId.current &&
          !attemptRef.current &&
          readActiveBill(activeBillScope) === stored;
        void utils.client.pharmacySales.counterCart
          .query({ branchId: activeBillScope.branchId, saleId: stored })
          .then(
            (read) => (read.status === 'OPEN' ? 'open' : 'closed'),
            (error: { data?: { code?: string } | null }) =>
              // Gone or out of reach is final; a transient failure keeps the record.
              error?.data?.code === 'NOT_FOUND' || error?.data?.code === 'FORBIDDEN'
                ? 'closed'
                : 'unknown'
          )
          .then((verdict) => {
            if (verdict === 'unknown' || !unchanged()) return;
            if (verdict === 'closed') {
              rememberActiveBill(activeBillScope, null);
              return;
            }
            setActiveSale(stored);
            setNotice({ tone: 'success', message: 'The open bill on this counter was restored.' });
          });
        return;
      }
    }
    rememberActiveBill(activeBillScope, saleId);
  }, [activeBillKey, activeBillScope, recoveryReady, saleId, setActiveSale, utils]);

  // DEV-41: both Pay buttons say why they are disabled, in cashier words.
  const payDisabledReason = !canSettlePayments
    ? settlementAccess.isError
      ? "Couldn't check payment access."
      : settlementDenied
        ? 'Payments are taken by counter staff.'
        : 'Checking payment access…'
    : unknownTender || attempt !== null
      ? 'Check the payment outcome before taking more money.'
      : storageError
        ? 'Browser recovery is unavailable. Review payment status before continuing.'
        : tenderReadRequired
          ? 'Refresh this bill to verify payment before taking more money.'
          : blocked
            ? 'Resolve the safety block in the prescription panel before taking payment.'
            : billState === 'idle'
              ? 'Add an item to start a sale before taking payment.'
              : billState === 'loading'
                ? 'Checking the bill. Please wait before taking payment.'
                : billState === 'error' || billState === 'stale'
                  ? 'Refresh the bill to check the balance before taking payment.'
                  : billState === 'settled'
                    ? 'This bill is already paid. Start a new sale.'
                    : billState === 'unavailable'
                      ? cart?.status === 'HELD'
                        ? 'Resume this bill before taking payment.'
                        : currentBill && lineCount === 0
                          ? 'Add an item to this bill before taking payment.'
                          : 'Refresh the bill or start a new sale before taking payment.'
                      : busy
                        ? 'Wait for the current counter action to finish before taking payment.'
                        : null;
  const settledReceipt =
    billState === 'settled' &&
    !receiptQuery.isError &&
    !receiptQuery.isFetching &&
    receiptQuery.data?.saleId === saleId &&
    receiptQuery.data.receiptNumber === cart?.receiptNumber
      ? receiptQuery.data
      : null;
  // Retain only the confirmed change, not permission to tender or print. Query
  // staleness and background reads must not erase money still owed to the customer.
  // Adjust during render only when the confirmed value or its scope changes.
  const receiptChangeMinor = settledReceipt?.totals?.changeMinor;
  if (
    branchAuthorized &&
    saleId &&
    typeof receiptChangeMinor === 'number' &&
    Number.isSafeInteger(receiptChangeMinor) &&
    receiptChangeMinor >= 0
  ) {
    if (
      settledChange?.branchId !== branchId ||
      settledChange.saleId !== saleId ||
      settledChange.minor !== receiptChangeMinor
    ) {
      setSettledChange({ branchId, saleId, minor: receiptChangeMinor });
    }
  } else if (
    settledChange !== null &&
    (!branchAuthorized || settledChange.branchId !== branchId || settledChange.saleId !== saleId)
  ) {
    setSettledChange(null);
  }
  const confirmedChangeMinor =
    branchAuthorized && settledChange?.branchId === branchId && settledChange.saleId === saleId
      ? settledChange.minor
      : undefined;
  // A snapshot is only readable in the operator/branch scope that verified it.
  // A transient refetch failure can retain it; an explicit access denial cannot.
  // The cart remains authoritative when the next bill disables the receipt query.
  const receiptAccessDenied =
    cartQuery.error?.data?.code === 'UNAUTHORIZED' ||
    cartQuery.error?.data?.code === 'FORBIDDEN' ||
    receiptQuery.error?.data?.code === 'UNAUTHORIZED' ||
    receiptQuery.error?.data?.code === 'FORBIDDEN' ||
    (lastReceipt?.receipt.saleId === saleId && receiptQuery.error?.data?.code === 'NOT_FOUND');
  // Drop denied data before committing this render. Starting another bill changes
  // the query key and clears its error; that must never restore this snapshot.
  if (receiptAccessDenied && lastReceipt !== null) {
    setLastReceipt(null);
    setReceiptReprint(false);
  }
  const presentedReceipt =
    branchAuthorized && lastReceipt?.branchId === branchId && !receiptAccessDenied
      ? lastReceipt.receipt
      : null;
  const currentReceipt = !receiptAccessDenied
    ? ((presentedReceipt?.saleId === saleId ? presentedReceipt : null) ?? settledReceipt)
    : null;
  const displayReceipt = presentedReceipt ?? currentReceipt;

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
            receipt.data.receiptNumber !== read.data.receiptNumber ||
            !Number.isSafeInteger(read.data.receiptNumber) ||
            (read.data.receiptNumber ?? 0) <= 0
          )
            throw new Error('Receipt unavailable');
          // Validate an issued print model before retaining it beyond this query.
          buildCounterBrowserReceipt(receipt.data, receiptLocale, receiptFormat);
          if (presentedReceipt?.saleId !== receipt.data.saleId) setReceiptReprint(false);
          setLastReceipt({ branchId, receipt: receipt.data });
          const intent = receiptIntent.current;
          if (
            resolution === 'accepted' &&
            Number.isSafeInteger(read.data.receiptNumber) &&
            (read.data.receiptNumber ?? 0) > 0 &&
            read.data.totals.netMinor === read.data.totals.tenderedMinor &&
            read.data.lines.length > 0
          ) {
            const matchingIntent =
              intent?.saleId === saleId &&
              intent.branchId === branchId &&
              intent.receiptNumber === read.data.receiptNumber;
            confirmed = {
              status: 'confirmed',
              saleId,
              receiptNumber: read.data.receiptNumber!,
              autoPrint: matchingIntent ? intent.autoPrint : false,
              printReservation: matchingIntent ? intent.printReservation : undefined,
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
        if (confirmed) {
          setReceiptSettlement(confirmed);
          setPaymentOpen(false);
          setReceiptOpen(true);
        }
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
      presentedReceipt?.saleId,
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

  const openPayment = useCallback(() => {
    if (!canSettlePayments) return;
    // DEV-931: F9 arrives on a window keydown listener, outside React's event system, so a
    // plain state update opened the dialog only after the key event ended, and the dialog
    // moved focus in on a later frame. A cashier's (or a scanner's) next key landed outside
    // the payment: a payment method could not take focus, and Enter never took the payment.
    // Open it now and put focus in it now.
    flushSync(() => setPaymentOpen(true));
    tenderRef.current?.focus({ preventScroll: true });
  }, [canSettlePayments]);

  // Leave the settled bill and everything tied to its patient behind.
  const clearBill = useCallback(() => {
    setActiveSale(null);
    setPatientId(null);
    setPatientQuery('');
    setSubmittedPatientQuery('');
    setPatientAddressDraft(null);
    setControlledAuth(EMPTY_CONTROLLED_AUTH);
  }, [setActiveSale]);

  const startNextBill = useCallback(() => {
    if (busy || attemptRef.current) return;
    clearBill();
    setActiveRow(null);
    focusSearch();
  }, [busy, clearBill, focusSearch]);

  const openChecks = useCallback(() => setChecksOpen(true), []);
  // DEV-977: the More menu closes on Escape (focus returns to its button) and on a press
  // outside it, as the workspace menus do. Its panels stay mounted while it is closed.
  useEffect(() => {
    if (!actionsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const focus = document.activeElement;
      if (!actionsPanelRef.current?.contains(focus) && focus !== actionsButtonRef.current) return;
      setActionsOpen(false);
      actionsButtonRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        !actionsPanelRef.current?.contains(target) &&
        !actionsButtonRef.current?.contains(target) &&
        // A panel opened from the menu (a dialog) sits outside it in the page.
        !(target instanceof Element && target.closest('[role="dialog"]'))
      )
        setActionsOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [actionsOpen]);

  useEffect(() => {
    if (!paymentOpen) return;
    tenderRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [paymentOpen]);

  // DEV-714: the tender panel holds cash while the drawer reads closed, so a
  // cached "closed" (e.g. the drawer was opened in another tab on this device)
  // is re-read from the server each time payment opens.
  const refetchDrawer = drawerQuery.refetch;
  useEffect(() => {
    if (paymentOpen && drawerQueryEnabled) void refetchDrawer();
  }, [paymentOpen, drawerQueryEnabled, refetchDrawer]);

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
        return { query: trimmed, revision, blocked: false, serializedPack: null };
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
          // DEV-92: a serialized pack is sold as itself, so the server can pin its lot.
          serializedPack: verdict.parsed?.serial
            ? { payload: trimmed, serial: verdict.parsed.serial }
            : null,
        };
      } catch (error) {
        if (revision !== scannerRevision.current) return;
        setNotice({ tone: counterErrorTone(error), message: messageFrom(error) });
      } finally {
        setPending(null);
      }
    },
    [authenticatePack, branchAuthorized, branchId, busy, query]
  );

  const stageRow = useCallback((row: CounterSearchRow, focusQuantity = true) => {
    const label = counterLabelScanDecision(row);
    if (label.kind === 'BLOCKED') {
      setActiveRow(null);
      setQuantityText('');
      setSaleUnit(null);
      setLotOverride(null);
      setNotice({ tone: 'danger', message: label.message });
      return;
    }
    focusQuantityOnStage.current = focusQuantity;
    quantityReviewed.current = false;
    setHighlightId(null);
    if (focusQuantity) setResultsDismissed(true);
    setActiveRow(row);
    setQuantityText('1');
    setSaleUnit(preferredSaleUnitOption(row.saleUnits, row.dosageForm)?.kind ?? null);
    setLotOverride(
      label.kind === 'OVERRIDE' ? { inventoryLotId: label.inventoryLotId, reason: '' } : null
    );
  }, []);

  const changeQuantity = useCallback((text: string) => {
    quantityReviewed.current = true;
    setQuantityText(text);
  }, []);

  useEffect(() => {
    if (activeRow && focusQuantityOnStage.current) quantityRef.current?.focus();
    focusQuantityOnStage.current = false;
  }, [activeRow]);

  // DEV-705, DEV-977B: Enter that beats the search debounce runs the search now and highlights
  // its first result; nothing is added until the cashier presses Enter on what they see.
  const searchAndHighlight = useCallback(
    async (text: string) => {
      const search = await runSearch(text);
      if (!search || search.blocked) return;
      try {
        const result = await utils.pharmacySales.counterSearch.fetch(
          { branchId, query: search.query },
          { staleTime: 10_000 }
        );
        // A changed query, branch or scanner invalidates the in-flight selection.
        if (search.revision !== scannerRevision.current) return;
        if (result.rows[0]) {
          setResultsDismissed(false);
          setHighlightId(result.rows[0].medicineId);
        }
      } catch (error) {
        if (search.revision === scannerRevision.current)
          setNotice({ tone: counterErrorTone(error), message: messageFrom(error) });
      }
    },
    [branchId, runSearch, utils]
  );

  const openSale = useCallback(async () => {
    if (dayClosedRef.current) throw new Error('DAY_CLOSED');
    if (drawerRequiredRef.current) throw new Error('DRAWER_NOT_OPEN');
    const created = await createSale
      .mutateAsync({ branchId, quotation: false, deviceId: currentCounterDeviceId() })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === 'DAY_CLOSED')
          void utils.pharmacySales.tradingDayStatus.invalidate();
        // The drawer was closed elsewhere: re-read it so the opening step returns.
        if (error instanceof Error && error.message === 'DRAWER_NOT_OPEN')
          void utils.pharmacySales.drawerStatus.invalidate();
        throw error;
      });
    setActiveSale(created.id);
    void refetchOpenBills();
    return created.id;
  }, [branchId, createSale, currentCounterDeviceId, refetchOpenBills, setActiveSale, utils]);

  const ensureSale = useCallback(async () => saleId ?? (await openSale()), [openSale, saleId]);

  const addToCart = useCallback(
    async (
      scannedRow?: CounterSearchRow,
      scanRevision?: number,
      scannedPack?: { payload: string; serial: string } | null,
      /** DEV-977B: a result added in one step, in the unit chosen under "Adds as". */
      unitOption?: SaleUnitOption
    ) => {
      const scanIsCurrent = () =>
        scanRevision === undefined || scanRevision === scannerRevision.current;
      if (!scanIsCurrent()) return;
      const row = scannedRow ?? activeRow;
      // One serialized pack is one sealed pack, whatever unit the counter last staged.
      const option = scannedPack
        ? (scannedRow?.saleUnits.find((unit) => unit.kind === 'PACK') ?? null)
        : unitOption && scannedRow
          ? unitOption
          : scannedRow
            ? (scannedRow.saleUnits[0] ?? null)
            : selectedOption;
      const units = scannedRow ? 1 : quantity;
      if (units === null) {
        setNotice({
          tone: 'warning',
          message:
            !quantityText || Number(quantityText) === 0
              ? 'Enter a quantity'
              : 'Enter a whole number',
        });
        return;
      }
      const selectionPreview = scannedRow ? counterSelectionPreview(row, option, units) : preview;
      const batchOverride = scannedRow ? null : lotOverride;
      if (!row || !option || !selectionPreview || busy) return;
      if (!selectionPreview.sufficient) {
        setNotice({
          tone: 'warning',
          message: `Only ${onHandInSaleUnitLabel(selectionPreview)} on hand. Reduce the quantity or record the shortage.`,
        });
        return;
      }
      const overrideLotId = batchOverride?.inventoryLotId ?? null;
      if (overrideLotId && !batchOverride?.reason.trim()) {
        setNotice({
          tone: 'warning',
          message: 'Enter a reason before selling a batch other than the earliest-expiry one.',
        });
        return;
      }
      // DEV-929: a manual discount, worked out on this line's price. The server re-checks the
      // owner's maximum, the cost floor and minimum margin, and who may give it.
      const manualDiscount = heldDiscount;
      const discountMinor = manualDiscount
        ? counterDiscountMinor(manualDiscount, selectionPreview.grossMinor)
        : 0;
      if (manualDiscount && discountMinor <= 0) {
        setNotice({
          tone: 'warning',
          message: `A discount of ${describeCounterDiscount(manualDiscount)} comes to nothing on this item. Give a larger discount, or remove it.`,
        });
        return;
      }
      // DEV-930: where focus was when the add began, so it is only restored from there.
      const focusAtAdd = document.activeElement;
      setPending('addToCart');
      lastAddOutcome.current = 'pending';
      setNotice(null);
      // DEV-712: once a bill is paid (or voided) the next scan starts a new bill.
      // A pending, unresolved payment attempt keeps its bill until it is resolved.
      // The closed bill's patient and authorization are cleared; a patient the
      // operator picked for the next customer after the bill closed is kept,
      // with only the authorization fields entered since then.
      let billPatient = patient;
      let billAuth = controlledAuth;
      const replaceClosedBill =
        Boolean(saleId) && !attemptRef.current && billClosed(cartQuery.data, saleId);
      if (replaceClosedBill) {
        const closed = closedBillPatient.current;
        if (closed?.saleId === saleId && closed.patientId !== patientId) {
          billAuth = freshControlledAuth(controlledAuth, closed.editedAuth);
          setActiveSale(null);
          setControlledAuth(billAuth);
        } else {
          clearBill();
          billPatient = null;
          billAuth = EMPTY_CONTROLLED_AUTH;
        }
      }
      try {
        // No line is added while the day or the drawer is closed, to a new bill or an open one.
        if (dayClosedRef.current) throw new Error('DAY_CLOSED');
        if (drawerRequiredRef.current) throw new Error('DRAWER_NOT_OPEN');
        let activeSaleId = replaceClosedBill ? await openSale() : await ensureSale();
        const freshBill = replaceClosedBill || activeSaleId !== saleId;
        // Creating a bill can outlive this scan or the mounted counter.
        if (!scanIsCurrent()) return;
        // DEV-911: with the owner's pharmacist check off, nothing is asked for a controlled or
        // prescription-only line; the server writes the controlled register entry itself.
        const checkOff = pharmacistCheckOffRef.current;
        const controlled = row.restriction.controlled;
        const patient = billPatient;
        const addressOk = patientAddress.trim().length >= 3;
        const prescriptionOk = billAuth.emergency || Boolean(billAuth.prescriptionLineId);
        const emergencyOk = !billAuth.emergency || billAuth.prescriberName.trim().length > 0;
        if (
          controlled &&
          !checkOff &&
          (!patient ||
            !addressOk ||
            !prescriptionOk ||
            !emergencyOk ||
            !billAuth.staffProfileId ||
            !/^\d{4,8}$/.test(billAuth.pin) ||
            !navigator.onLine)
        ) {
          setNotice({
            tone: 'warning',
            message:
              'Controlled medicine needs the patient address, a pharmacist PIN, and a prescription or an emergency prescriber. Connect online, then complete the authorization panel.',
          });
          // DEV-1005: a one-step add (Enter, or a plain barcode) is staged as Shift+Enter stages
          // it, so the authorization panel this notice points to is shown and the line is added
          // once it is complete. A serialized pack scan is left as it was: staging would drop
          // the scanned pack's own lot.
          if (scannedRow && !scannedPack) {
            stageRow(scannedRow, false);
            setSaleUnit(option.kind);
          }
          openChecks();
          return;
        }
        // DEV-629: the server refuses to take payment for an Rx/restricted line without a
        // prescription reference, so the counter sends the selected patient's current
        // prescription line for this medicine. Without one the line still shows its safety block.
        const needsPrescription =
          !checkOff && !controlled && (row.restriction.rx || row.restriction.restricted);
        const prescriptionLine = needsPrescription
          ? patient?.prescriptions
              .filter((prescription) => prescription.inDate)
              .flatMap((prescription) => prescription.lines)
              .find(
                (line) =>
                  line.medicineId === row.medicineId &&
                  line.presentationId === row.presentationId &&
                  line.remainingAuthorizedUnits >= units * option.canonicalUnitsPerSaleUnit
              )
          : undefined;
        const refSerial = Number(billAuth.refSerial);
        const voucher = heldVoucher;
        let discountApproval: CounterApprovalPin | undefined;
        const attemptKeys: string[] = [];
        const postLine = (lineSaleId: string, approval?: CounterApprovalPin) => {
          const selection = JSON.stringify([
            lineSaleId,
            row.medicineId,
            option.packLevelId,
            option.kind,
            units,
            overrideLotId,
            row.labelLot?.inventoryLotId,
            scannedPack?.serial.toUpperCase(),
          ]);
          // DEV-780: the voucher is not part of the attempt's identity. The held voucher (and its
          // PIN) is dropped after every add, so a retry after a lost response reuses this key:
          // the server replays the committed line, or refuses a changed voucher, and never adds
          // the item a second time.
          let key = lineAttempts.current.get(selection);
          if (!key) {
            key = `counter-add:${browserUuid()}`;
            lineAttempts.current.set(selection, key);
          }
          attemptKeys.push(selection);
          return addLine.mutateAsync({
            ...(patient && prescriptionLine
              ? {
                  prescription: {
                    prescriptionLineId: prescriptionLine.prescriptionLineId,
                    patientId: patient.patientId,
                  },
                }
              : {}),
            controlledAuthorization:
              controlled && patient && !checkOff
                ? {
                    patientId: patient.patientId,
                    patientAddress: patientAddress.trim(),
                    staffProfileId: billAuth.staffProfileId,
                    pin: billAuth.pin,
                    rxSerialWritten: billAuth.rxSerialWritten,
                    emergency: billAuth.emergency,
                    prescriptionLineId: billAuth.prescriptionLineId || undefined,
                    prescriberName: billAuth.prescriberName.trim() || undefined,
                    prescriberRegNo: billAuth.prescriberRegNo.trim() || undefined,
                    refSerial: Number.isInteger(refSerial) && refSerial > 0 ? refSerial : undefined,
                  }
                : undefined,
            branchId,
            saleId: lineSaleId,
            medicineId: row.medicineId,
            // DEV-780: the server sets the voucher's amount and re-checks every rule.
            ...(voucher ? { voucherId: voucher.id, voucherPin: voucher.pin } : {}),
            // DEV-929: the approver is proven by a PIN the server verifies, never named here.
            ...(discountMinor > 0
              ? {
                  discountKind: 'DISCOUNT' as const,
                  discountMinor,
                  ...(discountApproval ? { discountApproval } : {}),
                }
              : {}),
            presentationId: row.presentationId,
            packLevelId: option.packLevelId,
            saleUnit: option.kind,
            quantity: units,
            canonicalUnitsPerSaleUnit: option.canonicalUnitsPerSaleUnit,
            ...(row.labelLot ? { shelfLabelLotId: row.labelLot.inventoryLotId } : {}),
            // Retries keep the key until a confirmed add; the next completed
            // scanner gesture must allocate another item, even for the same code.
            idempotencyKey: key,
            // DEV-92: the raw DataMatrix of one serialized pack; the server re-reads it.
            ...(scannedPack
              ? { scannedPack: { payload: scannedPack.payload, ...(approval ? { approval } : {}) } }
              : {}),
            ...(overrideLotId && batchOverride
              ? {
                  // #520: the server resolves who approved the override; the counter never names one.
                  override: {
                    inventoryLotId: overrideLotId,
                    reason: batchOverride.reason.trim(),
                  },
                }
              : {}),
          });
        };
        let packApprovalUsed = false;
        const postScannedLine = async (lineSaleId: string) => {
          try {
            return await postLine(lineSaleId);
          } catch (error) {
            if (
              !scannedPack ||
              !(error instanceof Error) ||
              error.message !== 'SERIAL_FEFO_APPROVAL_REQUIRED'
            )
              throw error;
            if (!scanIsCurrent()) return null;
            const approval = await new Promise<CounterApprovalPin | null>((resolve) => {
              packApprovalResolver.current = resolve;
              setPackApproval({ medicineName: row.displayName });
            });
            if (!approval || !scanIsCurrent()) return null;
            // Approval belongs to this exact bill and physical pack only.
            packApprovalUsed = true;
            return postLine(lineSaleId, approval);
          }
        };
        // DEV-929: without the right to discount on their own, the cashier is asked for a
        // manager's or owner's PIN (a solo owner enters their own), for this one line.
        const postApprovedLine = async (lineSaleId: string) => {
          try {
            return await postScannedLine(lineSaleId);
          } catch (error) {
            if (
              !manualDiscount ||
              discountApproval ||
              !(error instanceof Error) ||
              error.message !== COUNTER_DISCOUNT_APPROVAL_REQUIRED
            )
              throw error;
            if (!scanIsCurrent()) return null;
            const approval = await new Promise<CounterApprovalPin | null>((resolve) => {
              packApprovalResolver.current = resolve;
              setPackApproval({
                medicineName: row.displayName,
                discount: `Rs ${formatMinor(discountMinor)}`,
              });
            });
            if (!approval || !scanIsCurrent()) return null;
            discountApproval = approval;
            try {
              return await postScannedLine(lineSaleId);
            } catch (retryError) {
              if (
                !(retryError instanceof Error) ||
                retryError.message !== COUNTER_DISCOUNT_APPROVAL_REQUIRED
              )
                throw retryError;
              setNotice({
                tone: 'warning',
                message:
                  'That PIN did not approve the discount, so the item was not added. A manager or owner must enter their own PIN.',
              });
              return null;
            }
          }
        };
        let startedNextBill = replaceClosedBill;
        let added: Awaited<ReturnType<typeof postApprovedLine>>;
        try {
          added = await postApprovedLine(activeSaleId);
        } catch (error) {
          // DEV-712: the server says this bill already moved on — paid on another
          // screen, or this copy was stale. Re-read it and, once it is confirmed
          // paid or voided, carry the scan onto a new bill. A held bill keeps its
          // ID so it can still be resumed. A controlled line is never re-sent:
          // its authorization belonged to the old bill's patient. DEV-629: nor is a line
          // carrying that patient's prescription reference.
          if (
            !counterBillMovedOn(error) ||
            freshBill ||
            controlled ||
            packApprovalUsed ||
            discountApproval ||
            prescriptionLine ||
            attemptRef.current
          )
            throw error;
          const read = await cartQuery.refetch();
          if (!read.isSuccess || !billClosed(read.data, activeSaleId)) throw error;
          if (!scanIsCurrent()) return;
          clearBill();
          startedNextBill = true;
          activeSaleId = await openSale();
          if (!scanIsCurrent()) return;
          added = await postApprovedLine(activeSaleId);
        }
        if (!added) return;
        if ('blocked' in added) {
          catalogueCache.clear();
          setNotice({ tone: 'warning', message: added.blocked });
          return;
        }
        for (const selection of attemptKeys) lineAttempts.current.delete(selection);
        completedAdds.current += 1;
        lastAddOutcome.current = 'added';
        for (const unit of row.saleUnits)
          knownSaleUnits.current.set(unit.packLevelId, row.saleUnits);
        catalogueCache.sold(row.medicineId, units * option.canonicalUnitsPerSaleUnit);
        await refreshCart();
        await utils.pharmacyPrescriptions.counterPatientPanel.invalidate();
        await utils.pharmacySafety.controlledRegister.invalidate();
        await utils.pharmacySales.counterSearch.invalidate();
        setLotOverride(null);
        // DEV-977B: a one-step add (a scan or a result) leaves no line form behind.
        if (scannedRow) setActiveRow(null);
        // DEV-66: a promotion the owner's maximum skipped is said, never silent.
        const discountNotice =
          'promotionNotice' in added && added.promotionNotice
            ? COUNTER_DISCOUNT_NOTICES[added.promotionNotice]
            : null;
        // DEV-956: adding an item clears the whole-bill discount; the cashier gives it again.
        const billDiscountNotice =
          'billDiscountClearedMinor' in added && added.billDiscountClearedMinor
            ? `The whole-bill discount of Rs ${formatMinor(added.billDiscountClearedMinor)} was removed because the bill changed. Give it again to include this item.`
            : null;
        setNotice({
          tone: discountNotice || billDiscountNotice ? 'warning' : 'success',
          message: `${startedNextBill ? 'New bill started. ' : ''}${units} × ${row.displayName}${unitOption ? ` (${unitOption.levelLabel.toLowerCase()})` : ''} added${overrideLotId ? ' with a recorded batch override' : ''}${voucher ? ` with voucher ${voucher.code}` : ''}${discountMinor > 0 ? ` with a discount of Rs ${formatMinor(discountMinor)}` : ''}.${discountNotice ? ` ${discountNotice}` : ''}${billDiscountNotice ? ` ${billDiscountNotice}` : ''}`,
        });
        setAddVersion(completedAdds.current);
        setQuery('');
        // A focused field may already hold the next scan's digits; selecting them
        // would let the scanner's next digit replace them. A field that lost focus
        // (disabled while adding, or an add from a button) gets it back once enabled.
        // DEV-930: never from a control the cashier moved to meanwhile (the Patient button,
        // or the F9 payment dialog), or their next Enter lands in search and is lost.
        const focused = document.activeElement;
        if (
          focused !== searchRef.current &&
          (focused === null || focused === document.body || focused === focusAtAdd) &&
          document.querySelector('[role="dialog"]:not([hidden])') === null
        ) {
          restoreSearchAfterAdd.current = true;
          focusSearch();
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'DAY_CLOSED')
          void utils.pharmacySales.tradingDayStatus.invalidate();
        catalogueCache.clear();
        const message = counterSaleErrorMessage(error);
        setNotice({
          tone: counterErrorTone(error),
          message,
          ...(message === COUNTER_ERROR_MESSAGES.INVALID_ARRANGEMENT
            ? { inventoryBranchId: branchId }
            : {}),
          ...setupNotice(error),
        });
        if (counterSetupReason(error)) void refetchSaleReadiness();
      } finally {
        setPackApproval(null);
        packApprovalResolver.current = null;
        setControlledAuth((value) => ({ ...value, pin: '' }));
        if (heldVoucher) setHeldVoucher(null);
        if (manualDiscount) setHeldDiscount(null);
        setPending(null);
      }
    },
    [
      activeRow,
      addLine,
      heldVoucher,
      heldDiscount,
      catalogueCache,
      cartQuery,
      clearBill,
      controlledAuth,
      patient,
      patientAddress,
      branchId,
      busy,
      ensureSale,
      focusSearch,
      lotOverride,
      openChecks,
      openSale,
      patientId,
      preview,
      quantity,
      quantityText,
      refetchSaleReadiness,
      refreshCart,
      saleId,
      selectedOption,
      setActiveSale,
      setupNotice,
      stageRow,
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
      lastAddOutcome.current = 'pending';
      let revision: number | undefined;
      try {
        const searching = runSearch(submittedQuery);
        // runSearch claims its revision synchronously, before its first await.
        scan.revision = scannerRevision.current;
        const search = await searching;
        if (!search || search.blocked) return;
        revision = search.revision;
        const cached = search.serializedPack
          ? undefined
          : catalogueCache.get(branchId, search.query);
        const result = cached
          ? { rows: [cached], truncated: false }
          : await utils.pharmacySales.counterSearch.fetch(
              { branchId, query: search.query },
              { staleTime: 10_000 }
            );
        if (revision !== scannerRevision.current || result.rows.length !== 1 || barcodeBusy.current)
          return;
        const row = result.rows[0]!;
        if (!cached && !search.serializedPack) catalogueCache.put(branchId, search.query, row);
        const serialized = search.serializedPack;
        const label = counterLabelScanDecision(row);
        if (label.kind === 'BLOCKED') {
          stageRow(row);
          return;
        }
        // Use this lookup's restrictions/availability even when the medicine ID
        // matches the previous selection. A server refusal can refresh its rules.
        const scanPreview = counterSelectionPreview(row, row.saleUnits[0] ?? null, 1);
        // DEV-977B (Counter v2): a scan adds in one step. Only an exception (a non-FEFO shelf
        // sticker, or not enough stock) opens the line form, so the cashier can act on it.
        if (label.kind === 'OVERRIDE' || (!serialized && !scanPreview?.sufficient)) {
          stageRow(row, false);
          setSaleUnit(row.saleUnits[0]?.kind ?? null);
          // Barcode entry keeps its one-item default; manual selection starts empty.
          setQuantityText('1');
        }
        if (label.kind === 'OVERRIDE') {
          // A non-FEFO sticker waits for the existing reason and pharmacist approval.
          setNotice({ tone: 'warning', message: label.message });
          return;
        }
        if (serialized) {
          // The server pins the scanned pack's own lot and refuses a pack already sold.
          await addToCart(row, revision, serialized);
        } else if (scanPreview?.sufficient) {
          await addToCart(row, revision);
        }
      } catch (error) {
        if (revision === scannerRevision.current)
          setNotice({
            tone: counterErrorTone(error),
            message: messageFrom(error),
            ...setupNotice(error),
          });
      } finally {
        if (scannerInFlight.current === scan) scannerInFlight.current = null;
        setScanSettles((count) => count + 1);
      }
    },
    [addToCart, branchId, busy, catalogueCache, query, runSearch, setupNotice, stageRow, utils]
  );

  /** DEV-977B: the unit a result is added in: "Adds as" when it sells that way, else its usual. */
  const addUnitFor = useCallback(
    (row: CounterSearchRow): SaleUnitOption | null => {
      const preferred =
        addUnit === 'UNIT'
          ? looseSaleUnitOption(row.saleUnits)
          : addUnit
            ? (row.saleUnits.find((option) => option.kind === addUnit) ?? null)
            : null;
      return preferred ?? preferredSaleUnitOption(row.saleUnits, row.dosageForm) ?? null;
    },
    [addUnit]
  );

  /**
   * DEV-977B (Counter v2, A6): Enter on the highlighted result, or a press on it, adds one of it
   * to the bill in one step. Quantity and unit are then changed on the bill line. A result that
   * needs the line form (a blocked or non-FEFO shelf label, no sellable unit, not enough stock)
   * opens it instead, with the reason.
   */
  const addRowNow = useCallback(
    (row: CounterSearchRow) => {
      if (busy) return;
      const label = counterLabelScanDecision(row);
      const option = addUnitFor(row);
      const rowPreview = option ? counterSelectionPreview(row, option, 1) : null;
      setHighlightId(null);
      if (
        label.kind === 'BLOCKED' ||
        label.kind === 'OVERRIDE' ||
        !option ||
        !rowPreview?.sufficient
      ) {
        stageRow(row);
        if (option) setSaleUnit(option.kind);
        if (label.kind === 'OVERRIDE') setNotice({ tone: 'warning', message: label.message });
        return;
      }
      setResultsDismissed(true);
      void addToCart(row, undefined, null, option);
    },
    [addToCart, addUnitFor, busy, stageRow]
  );

  /** DEV-977B: the line form, for a result the cashier wants to add with more than one step. */
  const stageWithOptions = useCallback(
    (row: CounterSearchRow) => {
      setHighlightId(null);
      stageRow(row);
      const option = addUnitFor(row);
      if (option) setSaleUnit(option.kind);
    },
    [addUnitFor, stageRow]
  );

  const lineUnitOptions = useCallback(
    (line: CounterCartLine): readonly SaleUnitOption[] => {
      if (!line.packLevelId) return [];
      // Only the units of the line's own presentation (the one its pack level belongs to).
      return (
        knownSaleUnits.current.get(line.packLevelId) ??
        searchQuery.data?.rows.find(
          (row) =>
            row.medicineId === line.medicineId &&
            row.saleUnits.some((unit) => unit.packLevelId === line.packLevelId)
        )?.saleUnits ??
        []
      );
    },
    [searchQuery.data]
  );

  const lineChangeMessage = useCallback((error: unknown) => {
    // A line change stays with the bill's cashier, as a void does.
    if (error instanceof Error && error.message === 'NOT_BILL_OWNER')
      return 'Another cashier opened this bill. Only that cashier or a manager or owner can change its lines.';
    return counterSaleErrorMessage(error);
  }, []);

  /** DEV-977B: changes the quantity or unit of a bill line, on the server, with its rules. */
  const changeBillLine = useCallback(
    async (line: CounterCartLine, next: CounterLineChange) => {
      if (!saleId || busy) return;
      if (!navigator.onLine) {
        setNotice({ tone: 'warning', message: LINE_CHANGE_NEEDS_CONNECTION });
        return;
      }
      const selection = JSON.stringify([
        saleId,
        line.saleLineId,
        next.kind,
        next.packLevelId,
        next.canonicalUnitsPerSaleUnit,
        next.quantity,
      ]);
      let idempotencyKey = lineChangeKeys.current.get(selection);
      if (!idempotencyKey) {
        idempotencyKey = `counter-change:${browserUuid()}`;
        lineChangeKeys.current.set(selection, idempotencyKey);
      }
      setPending('changeLine');
      setNotice(null);
      try {
        const changed = await changeLine.mutateAsync({
          branchId,
          saleId,
          saleLineId: line.saleLineId,
          packLevelId: next.packLevelId,
          saleUnit: next.kind,
          quantity: next.quantity,
          canonicalUnitsPerSaleUnit: next.canonicalUnitsPerSaleUnit,
          idempotencyKey,
          ...counterDevice(),
        });
        lineChangeKeys.current.delete(selection);
        catalogueCache.clear();
        await refreshCart();
        await utils.pharmacySales.counterSearch.invalidate();
        const discountNotice =
          'promotionNotice' in changed && changed.promotionNotice
            ? COUNTER_DISCOUNT_NOTICES[changed.promotionNotice]
            : null;
        const billDiscountNotice =
          'billDiscountClearedMinor' in changed && changed.billDiscountClearedMinor
            ? `The whole-bill discount of Rs ${formatMinor(changed.billDiscountClearedMinor)} was removed because the bill changed. Give it again to include this change.`
            : null;
        setNotice({
          tone: discountNotice || billDiscountNotice ? 'warning' : 'success',
          message: `${line.medicineName}: ${next.quantity} × ${
            next.kind === 'UNIT' ? counterUnitNoun(line.dosageForm) : next.kind.toLowerCase()
          }.${discountNotice ? ` ${discountNotice}` : ''}${billDiscountNotice ? ` ${billDiscountNotice}` : ''}`,
        });
      } catch (error) {
        catalogueCache.clear();
        void refreshCart();
        setNotice({ tone: counterErrorTone(error), message: lineChangeMessage(error) });
      } finally {
        setPending(null);
      }
    },
    [
      branchId,
      busy,
      catalogueCache,
      changeLine,
      counterDevice,
      lineChangeMessage,
      refreshCart,
      saleId,
      utils,
    ]
  );

  /** DEV-977B: takes a line off the bill, on the server, which gives its stock back. */
  const removeBillLine = useCallback(
    async (line: CounterCartLine) => {
      if (!saleId || busy) return;
      if (!navigator.onLine) {
        setNotice({ tone: 'warning', message: LINE_CHANGE_NEEDS_CONNECTION });
        return;
      }
      const selection = JSON.stringify([saleId, line.saleLineId, 'remove']);
      let idempotencyKey = lineChangeKeys.current.get(selection);
      if (!idempotencyKey) {
        idempotencyKey = `counter-remove:${browserUuid()}`;
        lineChangeKeys.current.set(selection, idempotencyKey);
      }
      setPending('removeLine');
      setNotice(null);
      try {
        const removed = await removeLine.mutateAsync({
          branchId,
          saleId,
          saleLineId: line.saleLineId,
          idempotencyKey,
          ...counterDevice(),
        });
        lineChangeKeys.current.delete(selection);
        catalogueCache.clear();
        await refreshCart();
        await utils.pharmacySales.counterSearch.invalidate();
        const billDiscountNotice =
          'billDiscountClearedMinor' in removed && removed.billDiscountClearedMinor
            ? ` The whole-bill discount of Rs ${formatMinor(removed.billDiscountClearedMinor)} was removed because the bill changed. Give it again if it still applies.`
            : '';
        setNotice({
          tone: billDiscountNotice ? 'warning' : 'success',
          message: `${line.medicineName} removed from the bill.${billDiscountNotice}`,
        });
        focusSearch();
      } catch (error) {
        catalogueCache.clear();
        void refreshCart();
        setNotice({ tone: counterErrorTone(error), message: lineChangeMessage(error) });
      } finally {
        setPending(null);
      }
    },
    [
      branchId,
      busy,
      catalogueCache,
      counterDevice,
      focusSearch,
      lineChangeMessage,
      refreshCart,
      removeLine,
      saleId,
      utils,
    ]
  );

  const queueScan = useCallback(
    (code: string) => setScanQueue((queue) => [...queue, { code, branchId }]),
    [branchId]
  );

  // DEV-575: add buffered scans one at a time, each through the normal barcode path
  // (lookup, local checks, then the server's own permission, stock and pricing checks).
  // If a scan is not added, later buffered scans are discarded with a notice rather than
  // added behind a warning the operator has not read. A branch change discards them too.
  const drainScanQueue = useCallback(() => {
    if (scanQueue.some((scan) => scan.branchId !== branchId)) {
      setScanQueue((queue) => queue.filter((scan) => scan.branchId === branchId));
      return;
    }
    if (busy || drainingScan || scannerInFlight.current) return;
    const drained = drainedScan.current;
    drainedScan.current = null;
    if (lastAddOutcome.current !== 'added' && (drained || scanQueue.length)) {
      const later = scanQueue.length;
      const message = [
        drained ? `Barcode ${drained} was not added.` : null,
        later
          ? `${later} later ${later === 1 ? 'scan was' : 'scans were'} not added. Scan ${later === 1 ? 'it' : 'them'} again.`
          : null,
      ]
        .filter(Boolean)
        .join(' ');
      lastAddOutcome.current = 'added';
      if (later) setScanQueue([]);
      setNotice((current) =>
        current && current.tone !== 'success'
          ? { ...current, message: `${current.message} ${message}` }
          : { tone: 'warning', message }
      );
      return;
    }
    const next = scanQueue[0];
    if (!next) return;
    setScanQueue((queue) => queue.slice(1));
    drainedScan.current = next.code;
    setDrainingScan(true);
    void addBarcode(next.code).finally(() => setDrainingScan(false));
  }, [addBarcode, branchId, busy, drainingScan, scanQueue]);
  useEffect(() => {
    // Run after this commit, with the latest bill state; a newer render reschedules it.
    const timer = window.setTimeout(drainScanQueue, 0);
    return () => window.clearTimeout(timer);
  }, [drainScanQueue, scanSettles]);

  const runTransition = useCallback(
    async (action: 'hold' | 'resume' | 'void', voidReason?: SaleVoidReason) => {
      const target = action === 'resume' ? heldSaleId : saleId;
      if (!target || busy) return;
      setPending(action);
      setNotice(null);
      try {
        await transition.mutateAsync({
          branchId,
          saleId: target,
          action,
          ...(action === 'void' ? { voidReason } : {}),
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
        setNotice({
          tone: 'success',
          message: `Bill ${action === 'void' ? 'voided' : action === 'hold' ? 'held' : action}.`,
        });
        focusSearch();
      } catch (error) {
        setNotice({ tone: counterErrorTone(error), message: messageFrom(error) });
      } finally {
        setPending(null);
        void refetchOpenBills();
      }
    },
    [
      branchId,
      busy,
      focusSearch,
      heldSaleId,
      refetchOpenBills,
      refreshCart,
      saleId,
      setActiveSale,
      transition,
    ]
  );

  // DEV-623: pick up a bill from Open bills. An OPEN bill is simply loaded; a HELD
  // one is resumed on the server first (which re-checks the licence gate).
  const resumeOpenBill = useCallback(
    async (bill: CounterOpenBill) => {
      if (busy) return false;
      setPending('resume');
      setNotice(null);
      try {
        if (bill.status === 'HELD')
          await transition.mutateAsync({ branchId, saleId: bill.saleId, action: 'resume' });
        setActiveSale(bill.saleId);
        if (heldSaleId === bill.saleId) setHeldSaleId(null);
        await refreshCart();
        setNotice({ tone: 'success', message: 'Bill resumed.' });
        focusSearch();
        return true;
      } catch (error) {
        setNotice({ tone: 'warning', message: messageFrom(error) });
        return false;
      } finally {
        setPending(null);
        void refetchOpenBills();
      }
    },
    [
      branchId,
      busy,
      focusSearch,
      heldSaleId,
      refetchOpenBills,
      refreshCart,
      setActiveSale,
      transition,
    ]
  );

  // DEV-623: void an OPEN or HELD bill from the list; its stock goes back on sale.
  const voidOpenBill = useCallback(
    async (bill: CounterOpenBill, voidReason: SaleVoidReason) => {
      if (busy) return false;
      setPending('void');
      setNotice(null);
      try {
        const result = await transition.mutateAsync({
          branchId,
          saleId: bill.saleId,
          action: 'void',
          voidReason,
        });
        if (result && typeof result === 'object' && 'blocked' in result) {
          setNotice({ tone: 'warning', message: String(result.blocked) });
          return false;
        }
        if (bill.saleId === saleId) setActiveSale(null);
        if (bill.saleId === heldSaleId) setHeldSaleId(null);
        await refreshCart();
        setNotice({ tone: 'success', message: 'Bill voided. Its stock is back on sale.' });
        return true;
      } catch (error) {
        setNotice({ tone: 'warning', message: messageFrom(error) });
        return false;
      } finally {
        setPending(null);
        void refetchOpenBills();
      }
    },
    [branchId, busy, heldSaleId, refetchOpenBills, refreshCart, saleId, setActiveSale, transition]
  );

  const loadKhataAccounts = useCallback(async () => {
    if (!saleId) return [];
    return utils.client.pharmacySales.khataAccounts.query({ branchId, saleId });
  }, [branchId, saleId, utils]);
  const loadKhataApprovers = useCallback(
    () => utils.client.pharmacySales.khataOverLimitApprovers.query({ branchId }),
    [branchId, utils]
  );
  // A signup started on one bill must not link its customer to another branch or bill.
  const counterScopeRef = useRef('');
  useEffect(() => {
    counterScopeRef.current = `${branchId}:${saleId ?? ''}`;
  }, [branchId, saleId]);
  const signUpKhata = useCallback(
    async (input: KhataSignupInput) => {
      if (!saleId) throw new Error('Open a bill');
      const startedIn = `${branchId}:${saleId}`;
      let result;
      try {
        result = await khataSignup.mutateAsync({ branchId, saleId, ...input });
      } catch (error) {
        throw new Error(messageFrom(error));
      }
      if (counterScopeRef.current !== startedIn) return;
      setCustomerId(result.customerId);
      setNotice({ tone: 'success', message: 'Khata account opened and linked to this bill.' });
    },
    [branchId, khataSignup, saleId]
  );
  const khataSignupPatient = useMemo(
    () => (patient ? { patientId: patient.patientId, displayName: patient.displayName } : null),
    [patient]
  );
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
      // DEV-973: an isolated window that prints itself, so this counter never freezes.
      const popup = openPrintWindow('popup,width=640,height=720');
      try {
        const statement = await utils.client.pharmacySales.khataStatement.query({
          branchId,
          saleId,
          familyAccountId,
        });
        const doc = createPrintDocument('Family Khata statement');
        const pre = doc.createElement('pre');
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
        doc.body.replaceChildren(pre);
        await sendToPrintWindow(popup, serializePrintDocument(doc), {
          blockedMessage: 'Allow pop-ups',
          failedMessage: 'The print window is closed. Retry Print Khata statement.',
        });
      } catch (error) {
        closePrintWindow(popup);
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
        overrideReason?: string;
        overLimitApproval?: { staffProfileId: string; pin: string };
        prepaidPin?: string;
        providerRef?: string;
        payerName?: string;
        referenceSkipped?: boolean;
        approvalCode?: string;
        buyerName?: string;
      },
      draft: TenderDraft
    ): Promise<CounterTenderResult> => {
      if (
        !canSettlePayments ||
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
      let sentKey: string | null = null;
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
          deviceId: currentCounterDeviceId(),
          businessDate: todayBusinessDate(),
          type: input.type,
          amountMinor: input.amountMinor,
          ...(input.cashReceivedMinor !== undefined
            ? { cashReceivedMinor: input.cashReceivedMinor }
            : {}),
          // #722: equal split rows (Rs 500 + Rs 500) are distinct payments at
          // different paid balances; a double tap at the same balance still replays.
          // #708: a cash-memo buyer keeps this key; a changed buyer conflicts on the
          // payload hash rather than recording the same payment twice.
          idempotencyKey:
            input.familyAccountId ||
            input.payerName !== undefined ||
            input.approvalCode !== undefined
              ? `counter-tender:${saleId}:${input.type}:${browserUuid()}`
              : freshTenderKey(
                  `counter-tender:${saleId}:${input.type}:${input.amountMinor}${
                    paidMinor > 0 ? `:after:${paidMinor}` : ''
                  }`,
                  discardedTenderKeys.current
                ),
          ...(input.familyAccountId
            ? {
                familyAccountId: input.familyAccountId,
                ownerOverride: input.ownerOverride,
                ...(input.overrideReason !== undefined
                  ? { overrideReason: input.overrideReason }
                  : {}),
              }
            : {}),
          ...(input.providerRef !== undefined ? { providerRef: input.providerRef } : {}),
          ...(input.payerName !== undefined ? { payerName: input.payerName } : {}),
          ...(input.referenceSkipped !== undefined
            ? { referenceSkipped: input.referenceSkipped }
            : {}),
          ...(input.approvalCode !== undefined ? { approvalCode: input.approvalCode } : {}),
          ...(input.buyerName !== undefined ? { buyerName: input.buyerName } : {}),
        };
        sentKey = payload.idempotencyKey;
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
        // DEV-290: the approver's PIN goes with this one request only; it is never persisted
        // with the recovery attempt, so a recovery check never carries or replays it.
        // DEV-863: so is the customer's prepaid PIN.
        const result = await tender.mutateAsync({
          ...payload,
          ...(input.overLimitApproval ? { overLimitApproval: input.overLimitApproval } : {}),
          ...(input.prepaidPin ? { prepaidPin: input.prepaidPin } : {}),
        });
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
        // DEV-631: the day was closed under this bill: re-read it so the counter says so.
        if (error instanceof Error && error.message === 'DAY_CLOSED')
          void utils.pharmacySales.tradingDayStatus.invalidate();
        if (
          dispatched &&
          sentKey &&
          error instanceof Error &&
          error.message === TENDER_ATTEMPT_DISCARDED
        )
          discardedTenderKeys.current.add(sentKey);
        outcome =
          !dispatched || tenderRejected(error)
            ? {
                status: 'rejected',
                message: `Payment was not accepted. ${counterPaymentErrorMessage(error)}`,
              }
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
      // #1254: a refused cash payment may mean this counter's drawer is not open
      // after all (closed elsewhere); re-read it so the opening-cash step returns.
      if (outcome.status === 'rejected' && dispatched && input.type === 'CASH')
        void utils.pharmacySales.drawerStatus.invalidate();
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
      canSettlePayments,
      currentCounterDeviceId,
      discardReceiptIntent,
      paidMinor,
      recoveryScope,
      refreshTenderBill,
      saleId,
      tender,
      todayBusinessDate,
      utils,
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
        outcome = {
          status: 'accepted',
          message: 'Payment recorded.',
          // A blank draft amount follows today's balance; recovery must use
          // the amount actually submitted, even after the bill has settled.
          changeMinor:
            original.input.type === 'CASH'
              ? (original.input.cashReceivedMinor ?? original.input.amountMinor) -
                original.input.amountMinor
              : 0,
        };
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

  const loadDiscardApprovers = useCallback(
    () => utils.client.pharmacySales.tenderDiscardApprovers.query({ branchId }),
    [branchId, utils]
  );

  /**
   * DEV-712: a manager or owner discards the saved attempt whose outcome is unknown. Only the
   * server's answer resolves it: DISCARDED proves the attempt can never be recorded, so the
   * saved attempt is cleared and the bill re-read; ACCEPTED means it was recorded after all.
   * A refusal (wrong PIN, no permission, no connection) keeps the attempt locked.
   */
  const discardPaymentAttempt = useCallback(
    async (input: CounterTenderDiscardInput): Promise<CounterTenderResult> => {
      const original = attemptRef.current;
      const locked: CounterTenderResult = {
        status: 'unknown',
        message:
          'The attempt was not discarded. Wait for the current check to finish, then try again. The saved attempt is still locked.',
      };
      if (
        !original ||
        !branchAuthorized ||
        original.input.saleId !== saleId ||
        tenderInFlight.current ||
        outcomeInFlight.current
      )
        return locked;
      outcomeInFlight.current = true;
      setCheckingOutcome(true);
      let outcome: CounterTenderResult;
      let resolution: 'accepted' | 'rejected' | null = null;
      try {
        const result = await utils.client.pharmacySales.discardTenderAttempt.mutate({
          attempt: original.input,
          reason: input.reason,
          approval: { staffProfileId: input.staffProfileId, pin: input.pin },
        });
        if (result.status === 'ACCEPTED' && tenderAcknowledgement(result.result)) {
          resolution = 'accepted';
          outcome = {
            status: 'accepted',
            message: 'Payment recorded. The attempt was not discarded because it reached the shop.',
            changeMinor:
              original.input.type === 'CASH'
                ? (original.input.cashReceivedMinor ?? original.input.amountMinor) -
                  original.input.amountMinor
                : 0,
          };
        } else if (result.status === 'DISCARDED') {
          resolution = 'rejected';
          discardedTenderKeys.current.add(original.input.idempotencyKey);
          outcome = {
            status: 'rejected',
            message:
              'Payment attempt discarded. It was not recorded and never will be. Take the payment again if the customer has not paid.',
          };
          try {
            clearTenderAttempt(original);
            attemptRef.current = null;
            setAttempt(null);
            setRestoredAttempt(null);
            setStorageError(false);
          } catch {
            setStorageError(true);
          }
        } else {
          outcome = {
            status: 'unknown',
            message:
              'The discard answer could not be read. The saved attempt is still locked; check the payment outcome.',
          };
        }
      } catch (error) {
        outcome = {
          status: 'unknown',
          message: `The attempt was not discarded. ${messageFrom(error)} The saved attempt is still locked.`,
        };
      }
      setTenderOutcome(outcome);
      setTenderReadRequired(true);
      outcomeInFlight.current = false;
      setCheckingOutcome(false);
      // Only fresh bill and receipt reads establish today's balance for the next payment.
      if (resolution) await refreshTenderBill(resolution);
      return outcome;
    },
    [branchAuthorized, refreshTenderBill, saleId, utils]
  );

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

  // DEV-748: a scanned or typed loyalty card links its customer to the bill (opening one if
  // needed), so the bill earns points when paid and the customer can redeem on it.
  const linkLoyaltyCard = useCallback(
    async (text: string) => {
      if (busy) return false;
      const cardToken = normalizeLoyaltyCardCode(text);
      if (!cardToken) {
        setNotice({
          tone: 'warning',
          message: 'That is not a loyalty card code. Check the code printed under the QR.',
        });
        return false;
      }
      setPending('customer');
      // DEV-712: a card scanned after the last bill was paid or voided starts the next
      // customer's bill, as a medicine scan does; the closed bill's patient is cleared.
      const replaceClosedBill =
        Boolean(saleId) && !attemptRef.current && billClosed(cartQuery.data, saleId);
      if (replaceClosedBill) clearBill();
      try {
        const activeSaleId = replaceClosedBill ? await openSale() : await ensureSale();
        const link = (linkSaleId: string) =>
          scanLoyaltyCard.mutateAsync({ branchId, saleId: linkSaleId, cardToken });
        let linked: Awaited<ReturnType<typeof link>>;
        try {
          linked = await link(activeSaleId);
        } catch (error) {
          // DEV-712: the bill moved on (paid or voided on another screen, or this copy was
          // stale). Re-read it and, only once it is confirmed paid or voided, link the card to a
          // new bill. A held bill keeps its ID so it can still be resumed.
          const freshBill = replaceClosedBill || activeSaleId !== saleId;
          if (!counterBillMovedOn(error) || freshBill || attemptRef.current) throw error;
          const read = await cartQuery.refetch();
          if (!read.isSuccess || !billClosed(read.data, activeSaleId)) throw error;
          clearBill();
          linked = await link(await openSale());
        }
        setCustomerId(linked.id);
        setRedeemPoints(0);
        setNotice({
          tone: 'success',
          message: `Loyalty card: ${linked.displayName} linked to this bill.`,
        });
        return true;
      } catch (error) {
        setNotice({ tone: counterErrorTone(error), message: messageFrom(error) });
        return false;
      } finally {
        setPending(null);
      }
    },
    [branchId, busy, cartQuery, clearBill, ensureSale, openSale, saleId, scanLoyaltyCard]
  );

  const redeemCustomerPoints = useCallback(async () => {
    if (!saleId || redeemPoints <= 0 || busy) return;
    setPending('redeem');
    try {
      const result = await redeemLoyalty.mutateAsync({
        branchId,
        saleId,
        points: redeemPoints,
        deviceId: currentCounterDeviceId(),
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
    currentCounterDeviceId,
    customerQuery,
    redeemLoyalty,
    redeemPoints,
    refreshCart,
    saleId,
    todayBusinessDate,
  ]);

  const captureShortfall = useCallback(async () => {
    if (busy || !branchAuthorized || quantity === null) return;
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
      const demand = await captureDemand.mutateAsync({
        branchId,
        ...(saleId ? { saleId } : {}),
        ...(deviceId ? { terminalId: deviceId } : {}),
        requestedQty: Math.max(requestedCanonicalUnits ?? quantity, capturedUnits),
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
          onHandUnits: activeRow?.medicineOnHandUnits ?? activeRow?.onHandUnits ?? 0,
          blocked: activeRow?.blocked ?? [],
          capturedAt: new Date().toISOString(),
        },
      });
      setNotice({
        tone: 'success',
        message: `Recorded a shortage of ${capturedUnits} ${plural(counterUnitNoun(activeRow?.dosageForm), capturedUnits)} for ${requested}.`,
      });
      if (demand?.id) setLostSaleCapture({ branchId, demandId: demand.id, requested });
      focusSearch();
    } catch (error) {
      setNotice({ tone: counterErrorTone(error), message: messageFrom(error) });
    } finally {
      setPending(null);
    }
  }, [
    activeRow,
    branchAuthorized,
    branchId,
    busy,
    captureDemand,
    deviceId,
    focusSearch,
    query,
    quantity,
    saleId,
    saleUnit,
    selectedOption,
    requestedCanonicalUnits,
    shortfallUnits,
  ]);

  // DEV-81: an outcome tap is fire-and-forget; it never sets `pending`, so the
  // counter (search, cart, tender) stays usable while it saves.
  const chooseLostSaleOutcome = useCallback(
    (choice: LostSaleChoice) => {
      const capture = lostSaleCapture;
      setLostSaleCapture(null);
      if (!capture) return;
      setDemandOutcome
        .mutateAsync({ branchId: capture.branchId, demandId: capture.demandId, ...choice })
        .catch((error: unknown) => setNotice({ tone: 'warning', message: messageFrom(error) }));
    },
    [lostSaleCapture, setDemandOutcome]
  );
  const dismissLostSaleChips = useCallback(() => setLostSaleCapture(null), []);

  const declineVisibleSubstitutes = useCallback(async () => {
    if (!activeRow || busy || quantity === null) return;
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
      setNotice({ tone: counterErrorTone(error), message: messageFrom(error) });
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

  // A dispatch retry confirms the same copy; it must never allocate another one.
  const pendingPrintAudits = useRef<CounterBrowserPrintAudit[]>([]);
  const printAuditRetry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushPrintAudits = useCallback(
    async (attempt = 0): Promise<void> => {
      if (printAuditRetry.current) {
        clearTimeout(printAuditRetry.current);
        printAuditRetry.current = null;
      }
      const queued = [...pendingPrintAudits.current];
      for (const event of queued) {
        try {
          if (event.failed) {
            await recordBrowserPrintFailure.mutateAsync({
              branchId: event.branchId,
              saleId: event.saleId,
              locale: event.locale,
            });
          } else {
            await recordBrowserPrint.mutateAsync(event);
          }
          pendingPrintAudits.current = pendingPrintAudits.current.filter((item) => item !== event);
        } catch (error) {
          if (!isRetryablePrintAuditError(error)) {
            pendingPrintAudits.current = pendingPrintAudits.current.filter(
              (item) => item !== event
            );
          }
        }
      }
      if (pendingPrintAudits.current.length > 0 && attempt < PRINT_AUDIT_MAX_RETRIES) {
        printAuditRetry.current = setTimeout(
          () => void flushPrintAudits(attempt + 1),
          PRINT_AUDIT_RETRY_MS * 2 ** attempt
        );
      }
    },
    [recordBrowserPrint, recordBrowserPrintFailure]
  );
  useEffect(
    () => () => {
      if (printAuditRetry.current) clearTimeout(printAuditRetry.current);
    },
    []
  );

  const printReceipt = useCallback(
    async (existingReservation?: CounterBrowserPrintReservation): Promise<boolean> => {
      const reservation = existingReservation ?? reserveCounterBrowserPrint();
      // Outside the drawer the shortcut belongs to the current bill; Last
      // receipt explicitly selects the retained, authorized receipt snapshot.
      const receipt = receiptOpen ? displayReceipt : currentReceipt;
      if (!receipt || receipt.receiptNumber === null) {
        setNotice({ tone: 'warning', message: 'Load the settled receipt before printing.' });
        reservation.cancel();
        return false;
      }
      if (!existingReservation) {
        discardReceiptIntent();
        setReceiptSettlement(null);
      }
      try {
        // Reject known popup and rendering failures before claiming an ordinal.
        // Recheck at dispatch too: windows can close while allocation is in flight.
        await assertCounterBrowserPrintReady(reservation);
        buildCounterBrowserReceipt(receipt, receiptLocale, receiptFormat, false);
        buildCounterBrowserReceipt(receipt, receiptLocale, receiptFormat, true);
      } catch (error) {
        reservation.cancel();
        pendingPrintAudits.current.push({
          branchId,
          saleId: receipt.saleId,
          locale: receiptLocale,
          failed: true,
        });
        void flushPrintAudits();
        setNotice({ tone: counterErrorTone(error), message: messageFrom(error) });
        return false;
      }
      let allocation: { copyNumber: number; reprint: boolean };
      try {
        allocation = await allocateBrowserPrint.mutateAsync({
          branchId,
          saleId: receipt.saleId,
          locale: receiptLocale,
        });
        await printCounterBrowserReceipt(
          receipt,
          receiptLocale,
          receiptFormat,
          allocation.reprint,
          reservation
        );
      } catch (error) {
        reservation.cancel();
        setNotice({ tone: counterErrorTone(error), message: messageFrom(error) });
        return false;
      }
      // Recording faults do not undo a dialog that has already opened.
      setLastReceipt({ branchId, receipt });
      setReceiptReprint(allocation.reprint);
      setNotice({
        tone: 'success',
        persistent: true,
        message:
          'Browser print dialog requested. Select the matching paper size and OS printer. Physical printing is not confirmed.',
      });
      pendingPrintAudits.current.push({
        branchId,
        saleId: receipt.saleId,
        locale: receiptLocale,
        copyNumber: allocation.copyNumber,
      });
      void flushPrintAudits();
      return true;
    },
    [
      currentReceipt,
      displayReceipt,
      discardReceiptIntent,
      receiptFormat,
      receiptLocale,
      receiptOpen,
      allocateBrowserPrint,
      flushPrintAudits,
      branchId,
    ]
  );

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
          // DEV-977B (Counter v2): with no line form open the key sets "Adds as", the unit the
          // next result is added in.
          if (!activeRow) {
            setAddUnit(kind);
            return;
          }
          const options = activeRow.saleUnits;
          const option =
            kind === 'UNIT'
              ? looseSaleUnitOption(options)
              : (options.find((entry) => entry.kind === kind) ?? null);
          if (option) {
            setSaleUnit(option.kind);
            return;
          }
          setNotice({
            tone: 'warning',
            message: !activeRow
              ? 'Select a medicine before choosing a unit.'
              : options.length === 0
                ? 'This medicine has no sellable unit. Check its pack setup or capture the demand.'
                : kind === 'UNIT'
                  ? `No loose unit is sellable for this medicine. Sell by ${options
                      .map((entry) => entry.levelLabel.toLowerCase())
                      .join(' or ')}.`
                  : `This medicine is not sold by ${kind.toLowerCase()}.`,
          });
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
          openPayment();
          return;
        case 'printReceipt':
          printReceipt();
          return;
        case 'focusPrescriptionPanel':
          openChecks();
          return;
        case 'captureDemand':
          void captureShortfall();
          return;
        case 'voidSale':
          if (saleId && cart?.status === 'OPEN') setVoidOpen(true);
          return;
      }
    },
    [
      activeRow,
      addToCart,
      captureShortfall,
      cart?.status,
      focusSearch,
      openChecks,
      openPayment,
      printReceipt,
      runTransition,
      saleId,
    ]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        event.shiftKey === lastReceiptShift &&
        !event.repeat &&
        event.key.toLowerCase() === 'r' &&
        !matchCounterAction(keymap.bindings, event) &&
        presentedReceipt &&
        !document.querySelector('[role="dialog"]:not([hidden])')
      ) {
        event.preventDefault();
        setReceiptOpen(true);
        return;
      }
      // Native tender controls own Enter/Space; the counter's Enter shortcut
      // must not also add a staged medicine when payment is activated.
      if (
        (event.key === 'Enter' || event.key === ' ') &&
        event.target instanceof Node &&
        (tenderRef.current?.contains(event.target) || event.target === autoPrintRef.current)
      )
        return;
      if (
        !shouldHandleCounterKey(
          event,
          document.querySelector('[role="dialog"]:not([hidden])') !== null
        )
      )
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
  }, [keymap.bindings, lastReceiptShift, presentedReceipt, runAction]);

  /**
   * Persistent scan focus (POS-01): the field regains focus after every action.
   * Keyed on `busy`, not `pending`: the field mounts disabled until tender
   * recovery is ready, so `autoFocus` alone cannot land on it.
   */
  useEffect(() => {
    if (!busy && (restoreSearchAfterAdd.current || document.activeElement === document.body)) {
      restoreSearchAfterAdd.current = false;
      focusSearch();
    }
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

  // Operator preferences do not depend on branch/bill recovery readiness.
  const keymapLegend = (
    <CounterKeymapLegend
      keymap={keymap}
      allowUnconfirmed={keymapPreviewAuthorized}
      saving={saveKeymap.isPending}
      disabled={pending === 'tender'}
      error={saveKeymap.error ? messageFrom(saveKeymap.error) : null}
      onPresetChange={(preset: CounterKeymapPresetKey) =>
        saveKeymap.mutate({ preset, overrides: {} })
      }
    />
  );

  // DEV-957: offline with nothing loaded from the server (the stored page opened
  // with no connection), say so and offer what still works, not "no branch".
  if ((!online || offlineMode.serverUnreachable) && !branchesQuery.data) {
    return (
      <CounterFrame heading={false}>
        <CounterFrameContent>
          <CounterOfflineOnly offline={offlineMode} />
        </CounterFrameContent>
      </CounterFrame>
    );
  }

  if (branchesQuery.isLoading) {
    return <CounterSkeleton />;
  }

  if (branchesQuery.isError) {
    return (
      <CounterFrame heading={false}>
        <CounterFrameContent>
          <div className="space-y-6">
            <PageHeader
              eyebrow="Pharmacy"
              heading="Counter"
              description="This counter is unavailable."
            />
            <SectionCard title="Branches unavailable">
              <div className="space-y-3" role="alert">
                <p className="text-sm text-warning">{messageFrom(branchesQuery.error)}</p>
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
        </CounterFrameContent>
      </CounterFrame>
    );
  }

  // DEV-860: a member assigned to no active branch is told so, and whom to ask. No
  // setup link: branch assignments are the owner's or an administrator's to change.
  if (
    branches.length === 0 &&
    branchesQuery.data?.setupReason === BRANCH_NOT_ASSIGNED &&
    branchesQuery.data.canFixSetup !== true
  ) {
    return (
      <CounterFrame heading={false}>
        <CounterFrameContent>
          <div className="space-y-6">
            <PageHeader
              eyebrow="Pharmacy"
              heading="Counter"
              description="You are not assigned to a branch yet."
            />
            <SectionCard title="Before this counter can sell">
              <div className="space-y-3" role="alert">
                <p className="text-sm text-text-body">{COUNTER_NO_ASSIGNED_BRANCH_MESSAGE}</p>
                <div className="text-sm">
                  <CounterSetupNextStep
                    advice={{
                      reason: BRANCH_NOT_ASSIGNED,
                      message: COUNTER_NO_ASSIGNED_BRANCH_MESSAGE,
                      nextStep: ASK_OWNER_OR_MANAGER,
                      link: null,
                    }}
                  />
                </div>
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
            <SectionCard title="Shortcuts">{keymapLegend}</SectionCard>
          </div>
        </CounterFrameContent>
      </CounterFrame>
    );
  }

  if (branches.length === 0) {
    return (
      <CounterFrame heading={false}>
        <CounterFrameContent>
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
                      className="inline-flex min-h-11 min-w-11 items-center font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
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
                      className="inline-flex min-h-11 min-w-11 items-center font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
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
            <SectionCard title="Shortcuts">{keymapLegend}</SectionCard>
          </div>
        </CounterFrameContent>
      </CounterFrame>
    );
  }

  if (!branchAuthorized) {
    return (
      <CounterFrame>
        <CounterFrameContent>
          <SectionCard title="Counter unavailable">
            <p role="alert" className="text-sm text-text-body">
              This branch could not be verified for your account. Restore branch access before
              opening a saved payment.
            </p>
          </SectionCard>
        </CounterFrameContent>
      </CounterFrame>
    );
  }

  const connectionOnline = online && !offlineMode.serverUnreachable;
  const statusLine = [
    connectionOnline ? 'Online' : 'Offline',
    branches.find((entry) => entry.id === branchId)?.name,
    counterLabel(deviceId),
  ]
    .filter(Boolean)
    .join(' · ');
  const searchRows =
    searchCurrent && !searchQuery.isPlaceholderData ? (searchQuery.data?.rows ?? []) : [];
  const actionBar = (
    <CounterActionBar>
      <label className="sr-only" htmlFor="counter-branch">
        Branch
      </label>
      <select
        id="counter-branch"
        aria-describedby={counterBusyReason ? 'counter-branch-reason' : undefined}
        value={branchId}
        disabled={busy}
        onChange={(event) => {
          scannerRevision.current += 1;
          setSelectedBranchId(event.target.value);
          // A voucher and the cashier PIN held for one branch never carry to another.
          setHeldVoucher(null);
          setHeldDiscount(null);
          setLastReceipt(null);
          setReceiptReprint(false);
          setActiveRow(null);
          setActiveSale(null);
          setHeldSaleId(null);
        }}
        className="h-11 max-w-40 shrink-0 truncate rounded-full border border-border-subtle bg-surface-card px-3.5 text-[13px] font-semibold text-text-strong outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 sm:max-w-56"
      >
        {branches.map((branch) => (
          <option key={branch.id} value={branch.id}>
            {branch.name}
          </option>
        ))}
      </select>
      {/* DEV-1005: at narrow widths this strip scrolls sideways, so it takes the keyboard focus
          (arrow keys then scroll it) and shows the Studio focus ring. */}
      <div
        role="group"
        aria-label="Counter status"
        tabIndex={0}
        className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto rounded-full [scrollbar-width:none] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <div className="flex shrink-0 items-center gap-2" aria-label="Bill status">
          <StatusPill
            status={saleId ? 'open' : 'idle'}
            tone={cart?.receiptNumber ? 'success' : 'neutral'}
            className="font-mono text-xs uppercase"
            label={
              cart?.receiptNumber ? (
                `Receipt ${cart.receiptNumber}`
              ) : saleId ? (
                // DEV-977B: on a phone the pill reads "4 lines", so it is never cut off; the
                // whole label is still announced.
                <>
                  <span className="max-sm:sr-only">Bill open · </span>
                  {`${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`}
                </>
              ) : (
                'No open bill'
              )
            }
          />
          {heldSaleId ? <StatusPill status="held" tone="warning" label="1 held" /> : null}
          {dayClosed ? <StatusPill status="day-closed" tone="warning" label="Day closed" /> : null}
          {drawerOpen ? (
            <StatusPill status="drawer-open" tone="success" label="Drawer open" />
          ) : drawerRequired && drawerQuery.isSuccess ? (
            <StatusPill status="drawer-closed" tone="warning" label="Drawer closed" />
          ) : null}
        </div>
        <StatusPill
          status={connectionOnline ? 'online' : 'offline'}
          tone={connectionOnline ? 'success' : 'warning'}
          label={connectionOnline ? 'Online' : 'Offline'}
          className="shrink-0"
        />
      </div>
      <Button
        ref={actionsButtonRef}
        type="button"
        variant="ghost"
        className="order-last h-11 shrink-0 gap-2 px-3"
        aria-expanded={actionsOpen}
        aria-controls="counter-actions"
        onClick={() => setActionsOpen(!actionsOpen)}
      >
        <Ellipsis aria-hidden="true" />
        More
      </Button>
      {/* DEV-977: below 1280px every action sits in More; from 1280px the everyday ones sit
          in the row and the rest stay in More. One copy of each, so no panel loses state. */}
      <div
        id="counter-actions"
        ref={actionsPanelRef}
        className={`${actionsOpen ? 'flex' : 'hidden'} absolute end-4 top-full z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] flex-col items-stretch gap-2 rounded-2xl border border-border-default bg-surface-card p-3 shadow-lg xl:contents [&_[data-slot=button]]:rounded-[var(--radius-sm)]`}
      >
        {branchAuthorized ? (
          <CounterOpenBills
            bills={openBillsQuery.data}
            loading={openBillsQuery.isLoading}
            error={openBillsQuery.isError ? messageFrom(openBillsQuery.error) : null}
            activeSaleId={saleId}
            disabled={busy}
            onRefresh={() => void refetchOpenBills()}
            onResume={resumeOpenBill}
            onVoid={voidOpenBill}
          />
        ) : null}
        <CounterReturnPanel
          branchId={branchId}
          organizationId={organizationId}
          accountId={accountId}
          deviceId={currentCounterDeviceId}
          businessDate={todayBusinessDate}
        />
        <Link
          className={buttonVariants({
            variant: 'outline',
            className:
              'h-11 rounded-[var(--radius-sm)] shadow-none hover:translate-y-0 active:translate-y-0',
          })}
          href="/pharmacy/orders"
        >
          Customer orders
        </Link>
        <CounterSignOut
          hasOpenSale={Boolean(heldSaleId || (saleId && !billClosed(cart, saleId)))}
        />
        <div
          className={`${actionsOpen ? 'contents xl:flex' : 'contents xl:hidden'} xl:absolute xl:end-6 xl:top-full xl:z-40 xl:mt-2 xl:w-[20rem] xl:flex-col xl:items-stretch xl:gap-2 xl:rounded-2xl xl:border xl:border-border-default xl:bg-surface-card xl:p-3 xl:shadow-lg`}
        >
          {canSettlePayments ? (
            <CounterKhataPaymentPanel
              branchId={branchId}
              organizationId={organizationId}
              accountId={accountId}
              deviceId={currentCounterDeviceId}
              businessDate={todayBusinessDate}
            />
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="h-11 shadow-none hover:translate-y-0 active:translate-y-0"
            onClick={() => setShortcutsOpen(true)}
          >
            Shortcuts
          </Button>
          {presentedReceipt && (
            <Button
              variant="outline"
              className="h-11"
              aria-keyshortcuts={lastReceiptShortcut}
              onClick={() => setReceiptOpen(true)}
            >
              Last receipt{lastReceiptShortcut ? ` · ${lastReceiptShortcut}` : ''}
            </Button>
          )}
        </div>
      </div>
    </CounterActionBar>
  );
  const counterBody = (
    <>
      <nav
        aria-label="Counter shortcuts"
        className="sr-only focus-within:not-sr-only focus-within:mb-3"
      >
        <a
          href="#counter-scan-search"
          onClick={(event) => {
            if (searchRef.current && !searchRef.current.disabled) {
              event.preventDefault();
              searchRef.current.focus();
            }
          }}
          className="inline-flex min-h-11 items-center rounded-md px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-ring"
        >
          Skip to scan or search
        </a>
        <a
          href="#counter-bill-total"
          className="inline-flex min-h-11 items-center rounded-md px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-ring"
        >
          Skip to bill total
        </a>
      </nav>
      {/* Reserve space outside the scroller: one reason stays visible without covering controls. */}
      {counterBusyReason ? (
        <p
          id="counter-branch-reason"
          className="shrink-0 border-b border-border-subtle bg-surface-sunken px-4 py-2 text-xs text-text-body lg:px-6"
        >
          {counterBusyReason}
        </p>
      ) : null}
      {/* DEV-957 phase 2 (review B1/B2): what this computer holds is shown online too, as
          strips under the bars like the offline banner (Counter v2, B2 and C7). */}
      <CounterSalesToReconcile
        organizationId={organizationId}
        branchId={branchId}
        online={online && !offlineMode.serverUnreachable}
        refreshKey={offlineMode.revokedNotice?.kept ?? null}
        className="shrink-0 space-y-3 border-b border-border-subtle bg-surface-raised px-4 py-3 text-sm lg:px-6"
      />
      {online && !offlineMode.serverUnreachable ? (
        offlineMode.queued.length > 0 ? (
          <div
            className="shrink-0 border-b border-border-subtle bg-surface-raised px-4 py-3 text-sm lg:px-6"
            data-counter-offline-waiting-online=""
          >
            <OfflineQueue queued={offlineMode.queued} />
          </div>
        ) : null
      ) : (
        <div
          role="status"
          aria-live="polite"
          data-counter-offline=""
          // DEV-977 phase 2B (Counter v2 B2 and C7): the design's offline banner. While the
          // owner's offline selling switch is off it tells the truth: a price check only.
          className="flex shrink-0 flex-wrap items-start gap-3 border-b border-border-subtle bg-warning/10 px-4 py-3 text-sm lg:px-6"
        >
          <WifiOff aria-hidden="true" className="mt-0.5 size-4.5 shrink-0 text-warning" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="flex flex-wrap items-center gap-2 font-semibold text-text-strong">
              <StatusPill status="offline" tone="warning" label="Offline" />
              {paymentQueued
                ? 'Offline — the payment will be sent when the connection returns.'
                : pending === 'tender'
                  ? 'Offline — this payment is waiting for the server to confirm it.'
                  : 'Offline — this counter cannot reach the server.'}
            </p>
            <CounterOfflineBannerDetail
              paymentQueued={paymentQueued}
              tenderPending={pending === 'tender'}
              offlineSelling={offlineMode.actions !== null && offlineMode.sellingOn}
            />
            <CounterOfflinePanel offline={offlineMode} />
          </div>
          {paymentQueued ? (
            <StatusPill status="queued" tone="warning" label="1 payment waiting" />
          ) : null}
        </div>
      )}
      <div
        className="min-h-0 flex-1 overflow-y-auto pb-28 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-[auto_auto_minmax(0,1fr)] lg:overflow-hidden lg:pb-0 xl:grid-cols-[minmax(0,1fr)_380px]"
        data-counter-console=""
      >
        {/* From 1024px this wrapper steps aside (display: contents) and its sections take
            their places in the counter grid: search and bill on the left, the line being
            added on the right. */}
        <div className="min-w-0 lg:contents">
          {branchAuthorized && !saleId && saleReadiness.data ? (
            <div className="shrink-0 px-4 pt-3 lg:col-start-1 lg:row-start-1 lg:border-e lg:border-border-subtle lg:px-6 lg:pt-4">
              <CounterSaleReadiness
                readiness={saleReadiness.data}
                branchId={branchId}
                checking={saleReadiness.isFetching}
                onCheckAgain={() => void refetchSaleReadiness()}
                rememberFor={{ organizationId, accountId, deviceId }}
                onHidden={() => searchRef.current?.focus()}
              />
            </div>
          ) : null}
          <section
            id="counter-scan-search"
            tabIndex={-1}
            aria-label="Counter bill"
            className="relative z-10 shrink-0 border-b border-border-subtle bg-surface-page px-4 py-3 outline-none focus-visible:outline-2 focus-visible:outline-ring max-lg:sticky max-lg:top-0 lg:col-start-1 lg:row-start-2 lg:self-start lg:border-e lg:px-6 lg:pt-4 lg:pb-3.5"
          >
            {/* DEV-972: the search help sits beside the heading, so the medicines found start
                directly under the search box. DEV-977: both are announced, not drawn; the
                field shows its key and the results list shows how to move through it. */}
            <div className="sr-only">
              <h2>Scan or search</h2>
              {!dayClosed && !drawerRequired ? (
                <p id="counter-search-help">
                  {formatBinding(keymap.bindings.focusSearch)} focuses search. Enter adds the
                  selected medicine, or a barcode. {formatBinding(keymap.bindings.openTender)} opens
                  pay.
                </p>
              ) : null}
            </div>
            <div className="space-y-2.5">
              {notice ? (
                <div
                  role={notice.tone === 'success' || notice.tone === 'info' ? 'status' : 'alert'}
                  aria-live="polite"
                  className={`flex items-center gap-3 rounded-lg border p-3 ${notice.tone === 'success' || notice.tone === 'info' ? 'fixed inset-x-4 bottom-24 z-50 mx-auto max-w-lg bg-surface-card shadow-sm lg:start-11 lg:end-auto lg:bottom-11 lg:mx-0 lg:w-[35rem]' : ''} ${
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
                    {notice.setup ? <CounterSetupNextStep advice={notice.setup} /> : null}
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
                  {notice.persistent ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="ml-auto min-h-11 min-w-11 shrink-0"
                      onClick={() => setNotice(null)}
                    >
                      Dismiss
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {lostSaleCapture && lostSaleCapture.branchId === branchId ? (
                <CounterLostSaleChips
                  key={lostSaleCapture.demandId}
                  requested={lostSaleCapture.requested}
                  onChoose={chooseLostSaleOutcome}
                  onDismiss={dismissLostSaleChips}
                />
              ) : null}

              {dayClosed ? (
                <div
                  role="status"
                  aria-label="Business day closed"
                  className="space-y-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm"
                >
                  <p className="font-medium text-text-strong">
                    Today&apos;s business day is closed.
                  </p>
                  <p className="text-text-body">
                    New bills, payments and drawer changes are blocked. The owner or a manager can
                    reopen today for trading on Day close, with a reason; selling resumes here once
                    they do.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={tradingDayQuery.isFetching}
                    onClick={() => void tradingDayQuery.refetch()}
                  >
                    {tradingDayQuery.isFetching ? 'Checking…' : 'Check again'}
                  </Button>
                </div>
              ) : drawerRequired ? (
                <CounterOpenDrawerStep
                  canDeclareFloat={actorIsManager}
                  accessChecking={managerAccess.isLoading}
                  disabled={drawerBusy || !drawerStatusKnown || !canSettlePayments}
                  disabledReason={drawerDisabledReason}
                  statusError={drawerQuery.isError}
                  deviceUnavailable={deviceUnavailable}
                  checking={drawerQuery.isFetching}
                  onRetry={() => void drawerQuery.refetch()}
                  cashiers={actorIsManager ? drawerCashiers.data : undefined}
                  currentUserId={accountId}
                  context={{
                    branch: (() => {
                      const branch = branches.find((entry) => entry.id === branchId);
                      return branch?.name ?? null;
                    })(),
                    counter: counterLabel(deviceId),
                    businessDay: todayBusinessDate().toLocaleDateString('en-GB', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                      timeZone: 'UTC',
                    }),
                  }}
                  onOpen={(openingFloatMinor, operatingCashierId) => {
                    // #1254: a refused payment left this bill needing a re-read.
                    const rereadBill = tenderReadRequired;
                    setPending('drawer');
                    setNotice(null);
                    openDrawer
                      .mutateAsync({
                        branchId,
                        deviceId: currentCounterDeviceId(),
                        businessDate: todayBusinessDate(),
                        openingFloatMinor,
                        ...(operatingCashierId ? { operatingCashierId } : {}),
                      })
                      .then(() => {
                        setNotice({
                          tone: 'success',
                          message: 'Cash drawer opened for this counter.',
                        });
                        // #1254: re-read the bill, as "Refresh bill" does, so the counter
                        // is ready to take the refused payment again.
                        if (rereadBill) void refreshTenderBill();
                      })
                      .catch((error: unknown) =>
                        setNotice({
                          tone: 'warning',
                          message: counterDrawerErrorMessage(
                            error,
                            operatingCashierId && operatingCashierId !== accountId
                              ? 'assign-cashier'
                              : openingFloatMinor > 0
                                ? 'open-with-float'
                                : 'open'
                          ),
                        })
                      )
                      // Either way the server now holds the truth about this device's drawer;
                      // stay busy until it is read back, so the step cannot be sent twice.
                      .finally(() =>
                        Promise.resolve(utils.pharmacySales.drawerStatus.invalidate())
                          .catch(() => undefined)
                          .finally(() => setPending(null))
                      );
                  }}
                />
              ) : shiftRequired && openDrawerSession && cashShift ? (
                <CounterCashShiftPanel
                  branchId={branchId}
                  drawerSessionId={openDrawerSession.id}
                  status={cashShift}
                  currency={cashShift.currency}
                  timeZone={workspaceZone ?? 'UTC'}
                  actorIsManager={actorIsManager}
                  cashiers={actorIsManager ? drawerCashiers.data : undefined}
                  currentUserId={accountId}
                  onChanged={() => void utils.pharmacySales.drawerStatus.invalidate()}
                />
              ) : (
                <div className="space-y-2.5">
                  {/* DEV-958B: on a drawer that runs shifts, whose shift is open and its close. */}
                  {openDrawerSession && cashShift ? (
                    <CounterCashShiftPanel
                      branchId={branchId}
                      drawerSessionId={openDrawerSession.id}
                      status={cashShift}
                      currency={cashShift.currency}
                      timeZone={workspaceZone ?? 'UTC'}
                      actorIsManager={actorIsManager}
                      cashiers={actorIsManager ? drawerCashiers.data : undefined}
                      currentUserId={accountId}
                      onChanged={() => void utils.pharmacySales.drawerStatus.invalidate()}
                    />
                  ) : openDrawerSession && drawerOperatingCashier ? (
                    <CounterDrawerOperator
                      operatingCashier={drawerOperatingCashier}
                      cashiers={actorIsManager ? drawerCashiers.data : undefined}
                      pending={handoverDrawer.isPending}
                      onHandover={(toCashierId, reason) => {
                        setNotice(null);
                        return handoverDrawer
                          .mutateAsync({
                            branchId,
                            drawerSessionId: openDrawerSession.id,
                            toCashierId,
                            reason,
                          })
                          .then(() => {
                            setNotice({ tone: 'success', message: 'Till handed over.' });
                            void utils.pharmacySales.drawerStatus.invalidate();
                          })
                          .catch((error: unknown) => {
                            setNotice({
                              tone: 'warning',
                              message: counterDrawerErrorMessage(error, 'handover'),
                            });
                            throw error;
                          });
                      }}
                    />
                  ) : null}
                  {/* DEV-977 (Counter v2): one large scan field, its scanner icon and key inside it. */}
                  <div className="relative">
                    <ScanBarcode
                      aria-hidden="true"
                      className="pointer-events-none absolute start-3.5 top-1/2 z-10 size-6 -translate-y-1/2 text-text-muted"
                    />
                    <div>
                      <Label htmlFor="counter-search" className="sr-only">
                        Scan or search
                      </Label>
                      <CounterScanInput
                        id="counter-search"
                        ref={searchRef}
                        // POS-01: focus rests here for the whole bill, so F-keys stay live in this field.
                        data-counter-scan=""
                        autoFocus
                        autoComplete="off"
                        value={query}
                        resetVersion={addVersion + cardScanResets}
                        debounceMs={COUNTER_SEARCH_DEBOUNCE_MS}
                        buffering={bufferScans}
                        isScan={looksLikeScannedCode}
                        isScanPrefix={looksLikeScanPrefix}
                        onQueueScan={queueScan}
                        onSearch={(text) => {
                          // DEV-748: a loyalty card code is never sent to the medicine search.
                          if (looksLikeLoyaltyCardCode(text.trim())) return;
                          setQuery(text);
                          setSubmittedSearch({ text: text.trim(), query: text.trim(), branchId });
                        }}
                        disabled={busy && !bufferScans}
                        placeholder="Brand, generic or barcode"
                        aria-describedby={
                          counterBusyReason && !bufferScans
                            ? 'counter-search-help counter-branch-reason'
                            : 'counter-search-help'
                        }
                        onDraftChange={(text) => {
                          scannerRevision.current += 1;
                          setResultsDismissed(false);
                          // Results follow the field once it is too short to search;
                          // longer drafts reach the parent when their debounce fires.
                          if (text.trim().length < 2) setQuery(text);
                          setSubmittedSearch((current) =>
                            current.text ? { text: '', query: '', branchId: '' } : current
                          );
                          setActiveRow(null);
                          setHighlightId(null);
                          setSaleUnit(null);
                          setQuantityText('1');
                        }}
                        onKeyDown={(event) => {
                          const readyRows =
                            !busy &&
                            searchCurrent &&
                            !searchQuery.isFetching &&
                            !searchQuery.isError &&
                            !searchQuery.isPlaceholderData
                              ? (searchQuery.data?.rows ?? [])
                              : [];
                          const resultsShown = searchState !== 'idle' && !resultsDismissed;
                          // DEV-977B (Counter v2): Escape closes the results over the bill.
                          if (
                            event.key === 'Escape' &&
                            resultsShown &&
                            !event.nativeEvent.isComposing
                          ) {
                            event.preventDefault();
                            setResultsDismissed(true);
                            setHighlightId(null);
                            return;
                          }
                          // DEV-977B: Shift+Enter opens the line form for the highlighted result
                          // (quantity before adding, another batch).
                          if (
                            event.key === 'Enter' &&
                            event.shiftKey &&
                            !event.ctrlKey &&
                            !event.altKey &&
                            !event.metaKey &&
                            !event.nativeEvent.isComposing
                          ) {
                            const target =
                              readyRows.find((row) => row.medicineId === highlightId) ??
                              readyRows[0];
                            if (!target) return;
                            event.preventDefault();
                            stageWithOptions(target);
                            return;
                          }
                          if (
                            event.nativeEvent.isComposing ||
                            event.shiftKey ||
                            event.ctrlKey ||
                            event.altKey ||
                            event.metaKey
                          )
                            return;
                          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                            const rows = searchQuery.data?.rows ?? [];
                            if (
                              busy ||
                              !searchCurrent ||
                              searchQuery.isFetching ||
                              searchQuery.isError ||
                              searchQuery.isPlaceholderData ||
                              rows.length === 0
                            )
                              return;
                            event.preventDefault();
                            const index = rows.findIndex(
                              (row) => row.medicineId === (highlightId ?? activeRow?.medicineId)
                            );
                            const next =
                              event.key === 'ArrowDown'
                                ? (index + 1) % rows.length
                                : index < 0
                                  ? rows.length - 1
                                  : (index - 1 + rows.length) % rows.length;
                            // Arrowing through results keeps focus in search (DEV-633). DEV-977B:
                            // it highlights a result; nothing is staged until it is added.
                            setResultsDismissed(false);
                            setHighlightId(rows[next]!.medicineId);
                            return;
                          }
                          if (event.key !== 'Enter') return;
                          event.preventDefault();
                          const trimmed = event.currentTarget.value.trim();
                          if (looksLikeLoyaltyCardCode(trimmed)) {
                            // DEV-748: a loyalty card scanned into the search field.
                            scannerRevision.current += 1;
                            setQuery('');
                            setCardScanResets((count) => count + 1);
                            void linkLoyaltyCard(trimmed);
                            return;
                          }
                          setQuery(trimmed);
                          if (looksLikeScannedCode(trimmed)) {
                            void addBarcode(trimmed);
                            return;
                          }
                          // DEV-977B (Counter v2, A6): Enter adds the highlighted result (the
                          // first one until the arrows move) in one step.
                          const highlighted = highlightId
                            ? readyRows.find((row) => row.medicineId === highlightId)
                            : undefined;
                          if (highlighted) {
                            addRowNow(highlighted);
                            return;
                          }
                          // The line form, opened on purpose (Shift+Enter) or for an exception,
                          // keeps its two steps: the quantity is reviewed, then added (DEV-633).
                          if (activeRow) {
                            if (quantity === null || !quantityReviewed.current) {
                              quantityReviewed.current = true;
                              quantityRef.current?.focus();
                            } else void addToCart();
                            return;
                          }
                          const first = resultsShown ? readyRows[0] : undefined;
                          if (first) addRowNow(first);
                          else void searchAndHighlight(trimmed);
                        }}
                        // DEV-44: the field is focused on load, and the coral focus ring read as
                        // an error before anything was typed. It stays neutral until a search
                        // actually fails, then carries the destructive state and aria-invalid.
                        aria-invalid={searchState === 'error' || undefined}
                        className={
                          searchState === 'error'
                            ? 'h-14 rounded-[var(--radius-sm)] border-[1.5px] border-border-default bg-surface-card ps-12 pe-14 text-[17px] [--ring:var(--destructive)] md:text-[17px] dark:bg-surface-card'
                            : 'h-14 rounded-[var(--radius-sm)] border-[1.5px] border-border-default bg-surface-card ps-12 pe-14 text-[17px] [--ring:var(--text-muted)] md:text-[17px] dark:bg-surface-card'
                        }
                      />
                    </div>
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute end-3 top-1/2 flex -translate-y-1/2 items-center gap-2 text-xs text-text-muted"
                    >
                      <kbd className={KEYCAP_CLASS}>
                        {formatBinding(keymap.bindings.focusSearch)}
                      </kbd>
                    </span>
                  </div>
                  <div
                    className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] lg:mx-0 lg:flex-wrap lg:px-0"
                    aria-label="Bill context"
                  >
                    <Button
                      variant="outline"
                      className="min-h-11 shrink-0 rounded-full px-3.5 text-[13px]"
                      onClick={openChecks}
                      aria-label={`${patient?.displayName ?? 'Patient + prescription'} · ${formatBinding(keymap.bindings.focusPrescriptionPanel)}`}
                    >
                      <UserRound aria-hidden="true" />
                      <span>{patient?.displayName ?? 'Patient'}</span>
                      <span className="hidden md:inline">
                        {patient ? '' : ' + prescription'} ·{' '}
                        {formatBinding(keymap.bindings.focusPrescriptionPanel)}
                      </span>
                    </Button>
                    <Button
                      variant="outline"
                      className={`min-h-11 shrink-0 rounded-full px-3.5 text-[13px] ${blocked ? 'border-destructive bg-destructive/10 text-destructive' : ''}`}
                      onClick={openChecks}
                      aria-label={safetyLabel}
                    >
                      <ShieldCheck aria-hidden="true" />
                      <span className="hidden md:inline">{safetyLabel}</span>
                      <span className="md:hidden">{blocked ? 'Safety block' : 'No blocks'}</span>
                    </Button>
                    <Button
                      variant="outline"
                      className="min-h-11 shrink-0 rounded-full px-3.5 text-[13px]"
                      onClick={() => setLoyaltyOpen(true)}
                      aria-label={loyaltyLabel}
                    >
                      <Star aria-hidden="true" />
                      <span className="hidden md:inline">{loyaltyLabel}</span>
                      <span className="md:hidden">Loyalty</span>
                    </Button>
                    {/* DEV-977B (Counter v2, A1 and A6): the unit the next result is added in. */}
                    <div
                      role="radiogroup"
                      aria-label="Adds as"
                      className="hidden shrink-0 items-center gap-2 text-xs text-text-muted lg:ms-auto lg:flex"
                    >
                      <span aria-hidden="true">Adds as</span>
                      <span className="inline-flex overflow-hidden rounded-[var(--radius-sm)] border border-border-default bg-surface-card">
                        {(['PACK', 'STRIP', 'UNIT'] as const).map((kind) => {
                          const checked = addUnit === kind;
                          return (
                            <button
                              key={kind}
                              type="button"
                              role="radio"
                              aria-checked={checked}
                              aria-keyshortcuts={chordFor(kind)}
                              title={chordFor(kind)}
                              onClick={() => setAddUnit(checked ? null : kind)}
                              className={`min-h-11 px-3 text-[13px] font-semibold focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50 ${
                                checked
                                  ? 'bg-text-strong text-surface-card'
                                  : 'text-text-body hover:bg-surface-sunken'
                              }`}
                            >
                              {kind === 'PACK' ? 'Pack' : kind === 'STRIP' ? 'Strip' : 'Unit'}
                              <span className="ms-1.5 hidden font-mono text-xs font-normal opacity-70 xl:inline">
                                {chordFor(kind)}
                              </span>
                            </button>
                          );
                        })}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
            {/* DEV-977 (Counter v2, A6 and B5): results drop over the bill. While the
                field is too short to search they stay in place for screen readers only. */}
            <div
              data-counter-results=""
              className={
                searchState === 'idle'
                  ? 'sr-only'
                  : resultsDismissed
                    ? 'hidden'
                    : 'absolute inset-x-3 top-full z-20 -mt-1 max-h-[min(35rem,calc(100dvh-12.5rem))] overflow-y-auto rounded-2xl border border-border-default bg-surface-card shadow-lg lg:inset-x-6 lg:max-h-[calc(100dvh-18.75rem)]'
              }
            >
              {searchState === 'ready' && searchRows.length > 0 ? (
                <div className="sticky top-0 z-10 flex flex-wrap justify-between gap-x-3 gap-y-1 border-b border-border-subtle bg-surface-card px-4 py-2.5 text-xs text-text-muted">
                  <span>
                    {searchRows.length} {searchRows.length === 1 ? 'result' : 'results'}
                    {searchQuery.data?.truncated ? ' (more match: keep typing)' : ''}
                  </span>
                  <span aria-hidden="true">↑ ↓ move · Enter adds · Esc closes</span>
                </div>
              ) : null}
              <div className={searchState === 'ready' && searchRows.length > 0 ? '' : 'p-4'}>
                <CounterSearchResults
                  rows={
                    searchCurrent && !searchQuery.isPlaceholderData
                      ? (searchQuery.data?.rows ?? [])
                      : []
                  }
                  state={searchState}
                  query={trimmedQuery}
                  disabled={busy || !branchAuthorized}
                  disabledReasonId={branchControlReason ? 'counter-branch-reason' : undefined}
                  activeMedicineId={
                    highlightId ??
                    activeRow?.medicineId ??
                    (searchState === 'ready' ? (searchRows[0]?.medicineId ?? null) : null)
                  }
                  error={searchQuery.error ? messageFrom(searchQuery.error) : null}
                  onSelect={stageRow}
                  onAdd={addRowNow}
                  slow={slowSearch}
                  onCaptureDemand={() => void captureShortfall()}
                  onRetry={() => {
                    if (searchCurrent) void searchQuery.refetch();
                  }}
                />
              </div>
              {searchState === 'ready' && searchRows.length > 0 ? (
                <p
                  aria-hidden="true"
                  className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border-subtle px-4 py-2.5 text-xs text-text-muted"
                >
                  <span>Batches are picked by earliest expiry.</span>
                  <span>
                    {(['PACK', 'STRIP', 'UNIT'] as const)
                      .map((kind) => `${chordFor(kind)} ${kind.toLowerCase()}`)
                      .join(' · ')}
                  </span>
                  <span>Shift+Enter quantity or batch first</span>
                </p>
              ) : null}
            </div>
          </section>
          {/* DEV-977B (Counter v2): the bill column. A result is added in one step and changed on
              its bill line; the line form below opens only when asked for (Shift+Enter) or for an
              exception, above the bill, so the totals and Take payment are never covered. */}
          <div
            data-counter-bill-column=""
            className="min-w-0 lg:col-start-1 lg:row-start-3 lg:min-h-0 lg:overflow-y-auto lg:border-e lg:border-border-subtle"
          >
            {activeRow && !drawerRequired && !dayClosed ? (
              <div className="border-b border-border-subtle px-4 py-3 lg:px-6">
                <section
                  aria-label="Next line"
                  className="rounded-[var(--radius-sm)] border border-border-subtle bg-surface-card px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                    <div className="min-w-0 basis-full">
                      <h2 className="font-mono text-xs uppercase tracking-widest text-text-muted">
                        Next line
                      </h2>
                      <p className="text-[15px] font-semibold text-text-strong">
                        {counterMedicineDisplayName(activeRow)}
                        {activeRow.strength ? ` ${activeRow.strength}` : ''}
                        {counterMedicineGenericName(activeRow) ? (
                          <span dir="auto" className="block text-xs font-normal text-text-muted">
                            {counterMedicineGenericName(activeRow)}
                          </span>
                        ) : null}
                      </p>
                      <p className="text-xs leading-relaxed text-text-muted">
                        {[
                          activeRow.presentation,
                          activeRow.dosageForm,
                          activeRow.batchNumber
                            ? `Batch ${activeRow.batchNumber}`
                            : activeRow.recommendedLotId
                              ? 'Batch not recorded'
                              : null,
                          activeRow.nearestSafeExpiry || activeRow.recommendedLotId
                            ? formatShortExpiry(activeRow.nearestSafeExpiry)
                            : null,
                          locationLabel,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>
                    <div className="counter-next-controls min-w-0 flex-1 space-y-2">
                      <CounterUnitToggle
                        inline
                        options={activeRow.saleUnits}
                        dosageForm={activeRow.dosageForm}
                        priceFor={(option) =>
                          counterSelectionPreview(activeRow, option, 1)?.unitPriceMinor ?? null
                        }
                        onHandUnits={activeRow.onHandUnits}
                        selected={saleUnit}
                        quantity={quantityText}
                        preview={preview}
                        disabled={busy}
                        onSelect={setSaleUnit}
                        onQuantityChange={changeQuantity}
                        quantityRef={quantityRef}
                        onSubmit={() => void addToCart()}
                        chordFor={chordFor}
                        emptyMessage={<CounterUnsellableMessage row={activeRow} />}
                      />
                      {activeRow.saleUnits.length === 0 ? (
                        <div className="space-y-1.5">
                          <Label htmlFor="counter-demand-units">
                            Requested {plural(counterUnitNoun(activeRow.dosageForm), 2)}
                          </Label>
                          <Input
                            id="counter-demand-units"
                            type="number"
                            min={1}
                            step={1}
                            className="h-11 w-32"
                            value={quantityText}
                            disabled={busy}
                            onChange={(event) => changeQuantity(event.target.value)}
                          />
                        </div>
                      ) : null}
                      {shortfallUnits > 0 ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="h-auto min-h-11 whitespace-normal"
                          disabled={busy || !branchAuthorized}
                          aria-describedby={
                            branchControlReason ? 'counter-branch-reason' : undefined
                          }
                          onClick={() => void captureShortfall()}
                        >
                          {pending === 'captureDemand'
                            ? 'Recording…'
                            : `Record shortage: ${shortfallUnits} ${plural(counterUnitNoun(activeRow.dosageForm), shortfallUnits)}`}
                        </Button>
                      ) : null}
                    </div>

                    <Button
                      type="button"
                      className="min-h-12 w-full rounded-[var(--radius-sm)] md:w-auto lg:w-full"
                      disabled={busy || !preview?.sufficient}
                      aria-describedby={
                        !busy && !preview?.sufficient ? 'counter-add-to-cart-reason' : undefined
                      }
                      onClick={() => void addToCart()}
                    >
                      {pending === 'addToCart'
                        ? 'Adding…'
                        : `Add to cart · ${formatBinding(keymap.bindings.addToCart)}`}
                    </Button>
                    {!busy && !preview?.sufficient ? (
                      <p id="counter-add-to-cart-reason" className="text-xs text-text-muted">
                        {preview
                          ? 'Not enough stock for this quantity. Reduce it or record the shortage.'
                          : counterAddToCartBlockReason(activeRow, selectedOption, quantity)}
                      </p>
                    ) : null}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border-subtle pt-2 text-xs text-text-muted">
                    <span>
                      {lotOverride?.inventoryLotId
                        ? `Selected batch ${lotOptionsQuery.data?.find((lot) => lot.inventoryLotId === lotOverride.inventoryLotId)?.batchNumber ?? 'override'} will be used with a recorded reason.`
                        : activeRow.recommendedLotId && activeRow.batchNumber
                          ? `Earliest-expiry batch${activeRow.batchNumber ? ` ${activeRow.batchNumber}` : ''} is used; more batches are added if needed.`
                          : activeRow.onHandUnits === 0 && activeRow.blocked.length === 0
                            ? 'No batch of this medicine is in stock here.'
                            : 'No batch can be sold here right now.'}
                    </span>
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
                      onChange={(next) => {
                        // An explicit batch choice replaces the scanned sticker's lot pin;
                        // otherwise the server refuses the chosen batch as a mismatch.
                        // Merely opening the picker (lotOverride still null) keeps the pin.
                        setActiveRow((current) =>
                          lotOverride !== null &&
                          current?.labelLot &&
                          next?.inventoryLotId !== current.labelLot.inventoryLotId
                            ? { ...current, labelLot: null }
                            : current
                        );
                        setLotOverride(next);
                      }}
                      onRetry={() => void lotOptionsQuery.refetch()}
                    />
                  </div>
                </section>
              </div>
            ) : null}
            <section
              aria-label="Cart"
              tabIndex={0}
              className="min-w-0 px-4 pb-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset lg:px-6 lg:pb-6"
            >
              <h2 className="sr-only">Cart</h2>
              <CounterCartPanel
                cart={cart}
                alerts={alerts}
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
                lineControls={{
                  // DEV-977B: a line change needs the server; offline (or when the server cannot
                  // be reached) the bill's lines are read-only. Between cash shifts they are
                  // read-only too, as adding a line and taking payment are (the server refuses).
                  disabled:
                    busy ||
                    !connectionOnline ||
                    dayClosed ||
                    drawerRequired ||
                    shiftRequired ||
                    !cart ||
                    cart.status !== 'OPEN' ||
                    cart.totals.tenderedMinor > 0 ||
                    Boolean(attempt),
                  unitOptions: lineUnitOptions,
                  onChange: (line, next) => void changeBillLine(line, next),
                  onRemove: (line) => void removeBillLine(line),
                }}
                emptyHints={
                  <>
                    <span>
                      <kbd className={KEYCAP_CLASS}>
                        {formatBinding(keymap.bindings.focusSearch)}
                      </kbd>{' '}
                      search
                    </span>
                    <span>
                      <kbd className={KEYCAP_CLASS}>Enter</kbd> add
                    </span>
                    <span>
                      <kbd className={KEYCAP_CLASS}>
                        {formatBinding(keymap.bindings.openTender)}
                      </kbd>{' '}
                      take payment
                    </span>
                  </>
                }
              />
            </section>
          </div>
        </div>
        <aside
          id="counter-bill-total"
          tabIndex={-1}
          aria-label="Bill total"
          className="flex min-w-0 flex-col gap-3.5 p-4 outline-none lg:col-start-2 lg:row-span-3 lg:row-start-1 lg:min-h-0 lg:overflow-y-auto lg:bg-surface-card lg:p-5 [&_button]:rounded-[var(--radius-sm)]"
        >
          <div className="flex items-center gap-3 rounded-2xl border border-border-subtle bg-surface-card px-4 py-3.5">
            <span
              aria-hidden="true"
              className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-surface-sunken text-text-body"
            >
              <UserRound className="size-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-text-strong">
                {customerQuery.data?.customer.displayName ?? 'Walk-in customer'}
              </span>
              <span className="block text-xs text-text-muted">
                {customerQuery.data ? 'Linked to this bill' : 'No customer on this bill'}
              </span>
            </span>
            <Button
              type="button"
              variant="outline"
              className="h-11 shrink-0 px-3 text-[13px]"
              onClick={() => setLoyaltyOpen(true)}
            >
              {customerQuery.data ? 'Change' : 'Link customer'}
            </Button>
          </div>
          {/* DEV-972: the next item's voucher and discount sit in the bill total's own header
                row, never between the search box and its results, and add no row above Pay. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Eyebrow>Bill total</Eyebrow>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {!dayClosed && !drawerRequired ? (
                <div
                  role="group"
                  aria-label="Voucher and discount for the next item"
                  className="flex flex-wrap items-center gap-2"
                >
                  <CounterVoucherEntry
                    branchId={branchId}
                    held={heldVoucher}
                    disabled={busy || !branchAuthorized || !online || Boolean(heldDiscount)}
                    returnFocus={searchRef}
                    onHold={(voucher) => {
                      setHeldVoucher({ ...voucher, branchId });
                      setNotice({
                        tone: 'success',
                        message: `Voucher ${voucher.code} will be used on the next item you add.`,
                      });
                      focusSearch();
                    }}
                    onClear={() => setHeldVoucher(null)}
                  />
                  <CounterDiscountEntry
                    branchId={branchId}
                    held={heldDiscount}
                    disabled={busy || !branchAuthorized || !online || Boolean(heldVoucher)}
                    returnFocus={searchRef}
                    onHold={(discount) => {
                      setHeldDiscount({ ...discount, branchId });
                      setNotice({
                        tone: 'success',
                        message: `A discount of ${describeCounterDiscount(discount)} will come off the next item you add.`,
                      });
                      focusSearch();
                    }}
                    onClear={() => setHeldDiscount(null)}
                  />
                </div>
              ) : null}
              <span className="text-xs text-text-muted">
                {lineCount} {lineCount === 1 ? 'line' : 'lines'}
              </span>
            </div>
          </div>
          <dl className="grid gap-2 text-sm">
            {(
              [
                ['Gross', cart?.totals.grossMinor],
                ['Discount', cart?.totals.discountMinor],
                ['Total', cart?.totals.netMinor],
                ['Tendered', cart?.totals.tenderedMinor],
              ] as const
            ).map(([label, value]) => (
              <div
                key={label}
                className={`flex items-baseline justify-between gap-3 ${label === 'Total' ? 'border-t border-border-subtle pt-2 text-[15px] font-semibold text-text-strong' : 'text-text-body'}`}
              >
                <dt>{label}</dt>
                <dd
                  className={`tabular-nums ${label === 'Discount' && value ? 'font-semibold text-success' : 'font-semibold text-text-strong'}`}
                >
                  {currentBill && value !== undefined ? formatMinor(value) : '—'}
                </dd>
              </div>
            ))}
          </dl>
          {/* DEV-956: shown only when the owner has turned the whole-bill discount on. */}
          {currentBill && cart.status === 'OPEN' && lineCount > 0 ? (
            <CounterBillDiscountEntry
              branchId={branchId}
              saleId={cart.saleId}
              lines={cart.lines}
              disabled={busy || !branchAuthorized || !online || cart.totals.tenderedMinor > 0}
              requestApproval={requestBillDiscountApproval}
              onChanged={(message) => {
                setNotice({ tone: 'success', message });
                void cartQuery.refetch();
              }}
            />
          ) : null}
          <div className="grid gap-3.5">
            <div className="grid gap-0.5 rounded-2xl bg-surface-sunken px-4 py-3.5">
              <p className="flex items-center gap-1.5 text-[13px] font-semibold text-text-body">
                {/* Counter v2 A3: a paid bill says so with a mark, not by colour alone. */}
                {billState === 'settled' ? (
                  <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-success" />
                ) : null}
                {billState === 'settled' ? `Paid · receipt ${cart?.receiptNumber}` : 'Balance due'}
              </p>
              <p className="text-[34px] leading-tight font-semibold tracking-[-0.02em] text-text-strong tabular-nums">
                {billState === 'settled' && currentBill
                  ? formatMinor(cart.totals.tenderedMinor)
                  : balanceMinor === null
                    ? '—'
                    : formatMinor(balanceMinor)}
              </p>
              <div className="empty:hidden">
                <CounterChangeDue minor={confirmedChangeMinor} />
              </div>
            </div>
            {billState === 'settled' ? (
              <div className="space-y-2">
                <Button className="h-14 w-full" disabled={busy} onClick={startNextBill}>
                  Start next bill
                </Button>
                <Button
                  variant="outline"
                  className="h-11 w-full"
                  onClick={() => {
                    if (settledReceipt) {
                      if (presentedReceipt?.saleId !== saleId) setReceiptReprint(false);
                      setLastReceipt({ branchId, receipt: settledReceipt });
                    }
                    setReceiptOpen(true);
                  }}
                >
                  Preview receipt
                </Button>
                <Button
                  variant="outline"
                  className="h-11 w-full"
                  onClick={() => void printReceipt()}
                >
                  Print · {formatBinding(keymap.bindings.printReceipt)}
                </Button>
              </div>
            ) : (
              <Button
                className="h-14 w-full justify-between px-5 text-[17px]"
                disabled={!canSettlePayments || billState !== 'ready' || blocked || busy}
                aria-describedby="counter-pay-reason"
                onClick={openPayment}
              >
                <span>Take payment</span>
                <span className="sr-only">·</span>
                <kbd className="rounded border border-primary-foreground/30 bg-primary-foreground/10 px-1.5 py-0.5 font-mono text-xs">
                  {formatBinding(keymap.bindings.openTender)}
                </kbd>
              </Button>
            )}
          </div>
          {!canSettlePayments ? (
            <div
              role="status"
              className={`text-sm ${settlementAccess.isError ? 'text-warning' : 'text-text-muted'}`}
            >
              <p id="counter-pay-reason">{payDisabledReason}</p>
              {settlementAccess.isError ? (
                <Button
                  variant="outline"
                  className="mt-2 min-h-11"
                  onClick={() => void settlementAccess.refetch()}
                >
                  Retry payment access
                </Button>
              ) : null}
            </div>
          ) : (
            <p
              id="counter-pay-reason"
              className={`text-xs ${blocked ? 'rounded-[var(--radius-sm)] bg-destructive/10 px-3.5 py-3 text-[13px] font-semibold text-destructive' : 'text-text-muted'}`}
            >
              {payDisabledReason ?? 'Cash, card, bank transfer, wallet or khata.'}
            </p>
          )}
          {canSettlePayments && billState !== 'ready' && billState !== 'settled' && saleId ? (
            <Button variant="outline" className="min-h-11 w-full" onClick={openPayment}>
              Review payment status
            </Button>
          ) : null}
          <div className="grid grid-cols-3 gap-2" aria-label="Bill actions">
            <Button
              variant="outline"
              className="h-11 px-2 text-xs"
              disabled={busy || !saleId || cart?.status !== 'OPEN'}
              aria-describedby={billActionReason ? 'counter-bill-action-reason' : undefined}
              onClick={() => void runTransition('hold')}
            >
              Hold{' '}
              <kbd className="rounded border border-border-subtle bg-surface-sunken px-1.5 py-0.5 font-mono text-xs">
                {formatBinding(keymap.bindings.holdSale)}
              </kbd>
            </Button>
            <Button
              variant="outline"
              className="h-11 px-2 text-xs"
              disabled={busy || !heldSaleId}
              aria-describedby={resumeReasonId}
              onClick={() => void runTransition('resume')}
            >
              Resume{' '}
              <kbd className="rounded border border-border-subtle bg-surface-sunken px-1.5 py-0.5 font-mono text-xs">
                {formatBinding(keymap.bindings.resumeSale)}
              </kbd>
            </Button>
            <Button
              variant="outline"
              className="h-11 px-2 text-xs text-destructive"
              disabled={busy || !saleId || cart?.status !== 'OPEN'}
              aria-describedby={billActionReason ? 'counter-bill-action-reason' : undefined}
              onClick={() => setVoidOpen(true)}
            >
              Void
            </Button>
          </div>
          {billActionReason ? (
            <p id="counter-bill-action-reason" className="text-xs text-text-muted">
              {billActionReason}
            </p>
          ) : null}
          {resumeReasonId === 'counter-resume-reason' ? (
            <p id="counter-resume-reason" className="text-xs text-text-muted">
              {resumeDisabledReason}
            </p>
          ) : null}
          {packApproval ? (
            <CounterPackApprovalDialog
              medicineName={packApproval.medicineName}
              copy={
                packApproval.discount
                  ? {
                      title: 'Approve this discount?',
                      description: `${packApproval.medicineName}: a discount of ${packApproval.discount}. A manager or owner must enter a fresh PIN. A solo owner can enter their own PIN. The approval is recorded in the audit.`,
                      confirm: 'Approve discount',
                    }
                  : undefined
              }
              loadApprovers={
                packApproval.discount ? loadDiscountApprovers : loadScannedPackApprovers
              }
              onCancel={() => finishPackApproval(null)}
              onConfirm={finishPackApproval}
            />
          ) : null}
          <CounterVoidDialog
            open={voidOpen && Boolean(saleId)}
            onOpenChange={setVoidOpen}
            busy={busy}
            onConfirm={(reason) => {
              setVoidOpen(false);
              void runTransition('void', reason);
            }}
          />
          {/* DEV-977: suggestions sit with the bill, as drawn, never between search and results. */}
          {substituteInput ? (
            <SectionCard
              compact
              eyebrow="Same medicine, other brands"
              title="Exact substitute suggestions"
            >
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
                canOpenSubstitution={canOpenSubstitution}
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
            disabledReasonId={branchControlReason ? 'counter-branch-reason' : undefined}
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
        </aside>
      </div>
      <div
        aria-label="Phone payment"
        className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-3 border-t border-border-default bg-surface-card px-4 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:hidden"
      >
        <div className="min-w-0 flex-1">
          <p id="counter-phone-pay-reason" className="text-xs text-text-muted">
            {canSettlePayments || settlementDenied
              ? (payDisabledReason ?? 'Balance due')
              : 'Balance due'}
          </p>
          <p className="text-2xl leading-tight font-semibold text-text-strong tabular-nums">
            {balanceMinor === null ? '—' : formatMinor(balanceMinor)}
          </p>
        </div>
        <Button
          variant="outline"
          className="h-14 min-w-11 rounded-[var(--radius-sm)]"
          onClick={() =>
            document.getElementById('counter-bill-total')?.scrollIntoView({ block: 'start' })
          }
        >
          Bill
        </Button>
        <Button
          className="h-14 min-w-36 rounded-[var(--radius-sm)] text-[17px]"
          disabled={!canSettlePayments || billState !== 'ready' || blocked || busy}
          // While payment access is unresolved, the reason (with its retry) sits in the bill panel.
          aria-describedby={
            canSettlePayments || settlementDenied
              ? 'counter-phone-pay-reason'
              : 'counter-pay-reason'
          }
          onClick={openPayment}
        >
          Take payment{' '}
          <span className="sr-only">· {formatBinding(keymap.bindings.openTender)}</span>
        </Button>
      </div>
      <CounterOverlay
        title="Take payment"
        // Counter v2 (A2, C4): the sheet's name carries the bill total, as drawn.
        titleDetail={currentBill ? formatMinor(cart.totals.netMinor) : undefined}
        eyebrow={`Bill · ${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`}
        variant="wide"
        enabled={canSettlePayments}
        open={paymentOpen}
        onOpenChange={setPaymentOpen}
        initialFocus={tenderRef}
        finalFocus={searchRef}
      >
        {/* DEV-950: a prescription line still waiting for its pharmacist's signature. */}
        {canSignPrescriptionLines && paymentOpen ? (
          <CounterRxSelfSign
            branchId={branchId}
            saleId={currentBill ? saleId : null}
            enabled
            // The signed line releases the bill: read it again so payment can be taken at once.
            onSigned={() => void cartQuery.refetch()}
          />
        ) : null}
        <CounterTenderPanel
          key={`${branchId}:${saleId ?? 'none'}:${restoredAttempt?.input.idempotencyKey ?? ''}`}
          ref={tenderRef}
          prepaidBalanceMinor={currentBill ? cart.prepaidBalanceMinor : undefined}
          confirmedChangeMinor={confirmedChangeMinor}
          manualSettings={manualSettings.data?.settings}
          drawerOpen={drawerQuery.isSuccess ? Boolean(openDrawerSession) : undefined}
          manualSettingsLoading={manualSettings.isLoading}
          manualSettingsError={manualSettings.isError}
          onReloadManualSettings={() => void manualSettings.refetch()}
          loadKhataAccounts={loadKhataAccounts}
          reauthenticateOwner={reauthenticateOwner}
          loadKhataApprovers={loadKhataApprovers}
          printKhataStatement={printKhataStatement}
          signUpKhata={signUpKhata}
          khataSignupPatient={khataSignupPatient}
          balanceMinor={balanceMinor}
          tenders={currentBill ? cart.tenders : undefined}
          state={billState}
          blocked={blocked}
          pending={pending === 'tender'}
          queued={paymentQueued}
          disabled={busy || !saleId}
          initialDraft={
            restoredAttempt
              ? {
                  ...restoredAttempt.draft,
                  type: restoredAttempt.input.type,
                  payerName: restoredAttempt.input.payerName,
                  providerRef: restoredAttempt.input.providerRef,
                  referenceSkipped: restoredAttempt.input.referenceSkipped,
                  approvalCode: restoredAttempt.input.approvalCode,
                  buyerName: restoredAttempt.input.buyerName,
                }
              : undefined
          }
          cashMemo={sindhCashMemoSelected(
            branches.find((branch) => branch.id === branchId)?.provinceCode
          )}
          recoveryOutcome={tenderOutcome}
          checkingOutcome={checkingOutcome}
          onCheckOutcome={
            attempt && tenderOutcome?.status === 'unknown' ? checkPaymentOutcome : undefined
          }
          onDiscardAttempt={discardPaymentAttempt}
          loadDiscardApprovers={loadDiscardApprovers}
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
          summaryExtra={
            <>
              <p className="text-xs text-text-muted">
                {lineCount} {lineCount === 1 ? 'line' : 'lines'} · Tendered{' '}
                {currentBill ? formatMinor(cart.totals.tenderedMinor) : '—'}
              </p>
              <div className="space-y-1">
                <Label
                  htmlFor="counter-auto-print"
                  className="flex min-h-11 items-center gap-3 text-[13px]"
                >
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
                <p id="counter-auto-print-help" className="text-xs text-text-muted max-sm:hidden">
                  Opens the print window after each payment on this computer.
                </p>
              </div>
              <Button
                variant="outline"
                className="h-11 w-full shadow-none hover:translate-y-0 active:translate-y-0"
                onClick={() => setPaymentOpen(false)}
              >
                Back to bill
              </Button>
            </>
          }
        />
        {/* DEV-743: shown only where an admitted card terminal serves this counter. */}
        <CounterCardTerminalPanel
          branchId={branchId}
          saleId={currentBill ? saleId : null}
          deviceId={deviceId}
          balanceMinor={balanceMinor}
          disabled={!canSettlePayments || billState !== 'ready' || blocked || busy}
          businessDate={todayBusinessDate}
          onSettled={() => void refreshTenderBill('accepted')}
        />
      </CounterOverlay>
      <CounterOverlay
        title="Patient, prescription and checks"
        eyebrow={formatBinding(keymap.bindings.focusPrescriptionPanel)}
        open={checksOpen}
        onOpenChange={setChecksOpen}
        initialFocus={rxPanelRef}
        finalFocus={searchRef}
        variant="side"
      >
        <CounterRxPanel
          ref={rxPanelRef}
          controlled={
            // QA-138: controlledPharmacists requires pharmacy:dispense/safety. A
            // FORBIDDEN read means this actor cannot dispense, so the controlled
            // authorization panel is not offered (the server refuses it anyway).
            // Without Pharmacy Safety the read is not made at all, with the same outcome.
            !(
              activeRow?.restriction.controlled ||
              (currentBill && cart.lines.some((line) => line.controlled))
            ) ||
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
                    closedBillPatient.current?.editedAuth.add(field);
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
          canCapturePrescription={canCapturePrescription}
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
      </CounterOverlay>
      <CounterOverlay
        title="Customer loyalty and khata"
        eyebrow="Khata and loyalty"
        open={loyaltyOpen}
        onOpenChange={setLoyaltyOpen}
        finalFocus={searchRef}
        variant="side"
      >
        <SectionCard
          compact
          title="Customer loyalty and khata"
          actions={
            <Button
              type="button"
              variant="outline"
              className="h-11 shadow-none hover:translate-y-0 active:translate-y-0"
              disabled={busy || !patient || !saleId}
              onClick={() => void attachCustomer()}
            >
              {pending === 'customer' ? 'Linking…' : 'Link selected patient'}
            </Button>
          }
        >
          <form
            className="mb-4 flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void linkLoyaltyCard(cardCodeText).then((linked) => {
                if (linked) setCardCodeText('');
              });
            }}
          >
            <div className="grid min-w-0 flex-1 gap-1.5">
              <Label htmlFor="counter-loyalty-card" className="text-sm">
                Loyalty card code
              </Label>
              <Input
                id="counter-loyalty-card"
                autoComplete="off"
                spellCheck={false}
                value={cardCodeText}
                disabled={busy || !branchAuthorized}
                onChange={(event) => setCardCodeText(event.target.value)}
                placeholder="Scan the card or type the code under the QR"
                className="h-11 font-mono"
              />
            </div>
            <Button
              type="submit"
              variant="outline"
              className="h-11 shadow-none hover:translate-y-0 active:translate-y-0"
              disabled={busy || !branchAuthorized || !cardCodeText.trim()}
            >
              {pending === 'customer' ? 'Linking…' : 'Link card'}
            </Button>
          </form>
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
                {customerQuery.data.earnRateSet === false ? (
                  // DEV-746: no owner-set earn rate means nothing new is earned; say so.
                  <p role="status" className="mt-2 font-medium text-warning">
                    Points are not being earned: set an earn rate in Loyalty settings
                  </p>
                ) : null}
                {customerQuery.data.loyaltyActive === false ? (
                  // DEV-764: a deactivated member keeps their points but cannot earn or redeem.
                  <p role="status" className="mt-2 font-medium text-warning">
                    Loyalty membership deactivated: points are not earned or redeemed until an owner
                    or manager re-enrols this customer
                  </p>
                ) : null}
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
                  className="h-11"
                />
                <Button
                  type="button"
                  className="h-11 shadow-none hover:translate-y-0 active:translate-y-0"
                  disabled={busy || redeemPoints <= 0 || balanceMinor === null || balanceMinor <= 0}
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
                        {entry.kind} · Receipt {entry.sale?.receiptNumber ?? '—'} ·{' '}
                        {pharmacyCalendarDay(workspaceZone, new Date(entry.occurredAt))}
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
              Scan the customer’s loyalty card, or select a patient, open a bill, then link. Current
              loyalty consent is required.
            </p>
          )}
        </SectionCard>
      </CounterOverlay>
      <CounterOverlay
        title="Shortcuts"
        eyebrow="Keyboard"
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        finalFocus={searchRef}
      >
        {keymapLegend}
      </CounterOverlay>
      <CounterOverlay
        title="Receipt preview"
        eyebrow={
          displayReceipt?.receiptNumber ? `Receipt ${displayReceipt.receiptNumber}` : 'Receipt'
        }
        variant="side"
        open={receiptOpen}
        onOpenChange={setReceiptOpen}
        finalFocus={searchRef}
        onKeyDown={(event) => {
          if (
            shouldHandleCounterKey(event) &&
            matchCounterAction(keymap.bindings, event) === 'printReceipt'
          ) {
            event.preventDefault();
            printReceipt();
            return;
          }
          const target = event.target;
          if (
            presentedReceipt &&
            !busy &&
            !attemptRef.current &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            !event.nativeEvent.isComposing &&
            event.key.length === 1 &&
            event.key.trim() &&
            !(
              target instanceof HTMLElement &&
              (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)
            )
          ) {
            event.preventDefault();
            if (presentedReceipt.saleId === saleId) startNextBill();
            else setReceiptOpen(false);
            setQuery(event.key);
            setActiveRow(null);
            setSaleUnit(null);
            setQuantityText('1');
            requestAnimationFrame(() => {
              const input = searchRef.current;
              input?.focus();
              input?.setSelectionRange(input.value.length, input.value.length);
            });
          }
        }}
        summary={<CounterChangeDue minor={confirmedChangeMinor} />}
      >
        <CounterReceiptView
          branchId={branchId}
          receipt={displayReceipt}
          state={
            displayReceipt
              ? 'ready'
              : billState !== 'settled'
                ? 'idle'
                : receiptQuery.isLoading
                  ? 'loading'
                  : receiptQuery.isError
                    ? 'error'
                    : 'ready'
          }
          evidence={
            displayReceipt?.saleId === saleId && evidenceEligible && !evidenceQuery.isError
              ? evidenceQuery.data
              : null
          }
          evidenceError={
            displayReceipt?.saleId === saleId && evidenceEligible && evidenceQuery.isError
          }
          evidenceRefreshing={displayReceipt?.saleId === saleId && evidenceQuery.isFetching}
          onEvidenceRefresh={
            displayReceipt?.saleId === saleId && evidenceEligible
              ? () => void evidenceQuery.refetch()
              : undefined
          }
          locale={receiptLocale}
          format={receiptFormat}
          reprint={receiptReprint}
          printing={!displayReceipt && receiptQuery.isFetching}
          error={!displayReceipt && receiptQuery.error ? messageFrom(receiptQuery.error) : null}
          onLocaleChange={setReceiptLocale}
          onFormatChange={setReceiptFormat}
          onPrint={printReceipt}
          onRetry={() => void receiptQuery.refetch()}
          settlement={
            receiptSettlement?.status === 'confirmed' &&
            displayReceipt?.saleId === receiptSettlement.saleId
              ? receiptSettlement
              : null
          }
          onSettlementPresented={receiptPresented}
          onSendWhatsApp={async (receiptSaleId) => {
            try {
              const sent = await sendWhatsAppReceipt.mutateAsync({
                branchId,
                saleId: receiptSaleId,
                customerRequested: true,
              });
              // Delivery runs after the request commits; never claim it was delivered.
              return sent.outcome === 'DUPLICATE'
                ? {
                    ok: true,
                    message: 'A WhatsApp receipt for this sale was already requested today.',
                  }
                : {
                    ok: true,
                    message: 'WhatsApp receipt queued. Delivery is not confirmed at the counter.',
                  };
            } catch (error) {
              return { ok: false, message: messageFrom(error) };
            }
          }}
        />
      </CounterOverlay>
      <p className="sr-only" aria-live="polite">
        {COUNTER_ACTION_LABELS.focusSearch}: {formatBinding(keymap.bindings.focusSearch)}
      </p>
    </>
  );

  return (
    <CounterFrame statusLine={statusLine} actionBar={actionBar}>
      {counterBody}
    </CounterFrame>
  );
}

/**
 * Keep tender drafts and receipt settlement deduplication mounted across drawer toggles.
 * DEV-977 phase 2B: drawn in the Counter v2 sheet frame (eyebrow, title, icon close, footer).
 */
function CounterOverlay({
  title,
  titleDetail,
  eyebrow,
  subtitle,
  open,
  enabled = true,
  onOpenChange,
  initialFocus,
  finalFocus,
  onKeyDown,
  summary,
  footer,
  variant = 'dialog',
  children,
}: {
  title: string;
  /** Shown after the title, inside the dialog's name (the payment sheet's bill total). */
  titleDetail?: string;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  open: boolean;
  /** False unmounts even the normally retained, closed contents (DEV-97: lost access). */
  enabled?: boolean;
  onOpenChange: (open: boolean) => void;
  initialFocus?: RefObject<HTMLDivElement | null>;
  finalFocus: RefObject<HTMLInputElement | null>;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  summary?: ReactNode;
  footer?: ReactNode;
  variant?: CounterSheetVariant;
  children: ReactNode;
}) {
  if (!enabled) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal keepMounted>
        <DialogOverlay hidden={!open} className={COUNTER_SHEET_BACKDROP} />
        <DialogPrimitive.Popup
          hidden={!open}
          data-counter-sheet={variant}
          // Focus already inside the initial target (moved there when it opened, or by the
          // cashier since) stays where it is; the dialog's queued initial focus never takes it back.
          initialFocus={
            initialFocus
              ? () =>
                  initialFocus.current?.contains(document.activeElement)
                    ? false
                    : initialFocus.current
              : undefined
          }
          finalFocus={finalFocus}
          onKeyDown={onKeyDown}
          // Portalled out of the route layout, so the sheet carries the pharmacy scope itself
          // (12px metadata floor, POS-calm controls).
          className={counterSheetClassName(
            variant,
            'pharmacy-workspace pos-calm [&_:is([data-slot=button],[data-slot=dialog-close]):not(.rounded-full)]:rounded-[var(--radius-sm)]'
          )}
        >
          <CounterSheetHeader
            eyebrow={eyebrow}
            subtitle={subtitle}
            // One text run, so the name reads "Take payment · 894.00" as a single phrase.
            title={titleDetail ? `${title} · ${titleDetail}` : title}
          />
          {summary ? <div className="shrink-0 px-5 pt-5 empty:hidden">{summary}</div> : null}
          <DialogDescription className="sr-only">
            {`${title} for the current counter bill.`}
          </DialogDescription>
          <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-5 py-4.5">
            {children}
          </div>
          {footer ? <CounterSheetFooter>{footer}</CounterSheetFooter> : null}
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
