import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COUNTER_CASH_DRAWER_CLOSED_MESSAGE,
  COUNTER_UNKNOWN_ERROR_MESSAGE,
} from '@/lib/pharmacy/counter-messages';
import type { ComponentProps } from 'react';
import { installFakePrintWindows } from '@/lib/testing/print-window';
import { COUNTER_SETUP_GUIDANCE } from '@/lib/pharmacy/counter-setup';
import {
  clearCounterReadinessOkay,
  counterReadinessOkayKey,
} from '@/lib/pharmacy/counter-readiness-okay';
import { CounterApprovalDenied } from '@/lib/pharmacy/counter-line-approval';
import { PharmacyRxReferenceError } from '@/lib/pharmacy/rx-prescription-reference';

import type { CounterCart, CounterSearchRow } from '@/lib/pharmacy/counter';
import type { CounterReceipt } from '@/lib/pharmacy/counter-receipt';
import type { CounterRxPanel } from './counter-rx-panel';
import type { CounterSearchResults } from './counter-search-results';

type Query = {
  data?: unknown;
  isSuccess: boolean;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  isStale: boolean;
  isPlaceholderData: boolean;
  error?: Error;
  refetch: ReturnType<typeof vi.fn>;
};

// #708: the cash memo is held off by a hard-coded constant until counsel confirms it. Tests
// read the real constant unless one sets `cashMemoHold.live` to check the post-hold memo.
const cashMemoHold = vi.hoisted(() => ({ live: undefined as boolean | undefined }));
vi.mock('@/lib/pharmacy/sindh-cash-memo-hold', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pharmacy/sindh-cash-memo-hold')>();
  return {
    get SINDH_CASH_MEMO_LIVE() {
      return cashMemoHold.live ?? actual.SINDH_CASH_MEMO_LIVE;
    },
  };
});

const mocks = vi.hoisted(() => ({
  renderSearchResults: false,
  queries: {} as Record<string, Query>,
  renderBranchChildren: false,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  pausedMutations: new Set<string>(),
  refetch: vi.fn(),
  searchFetch: vi.fn(),
  voucherFetch: vi.fn(),
  cancel: vi.fn(),
  receiptInvalidate: vi.fn(),
  mutationOptions: vi.fn(),
  receiptProps: vi.fn(),
  printReceipt: vi.fn(),
  queryOptions: vi.fn(),
  queryInputs: vi.fn(),
  outcomeQuery: vi.fn(),
  searchQuery: vi.fn(),
  searchSetData: vi.fn(),
  rxPanelProps: vi.fn<(props: ComponentProps<typeof CounterRxPanel>) => void>(),
  searchProps: vi.fn<(props: ComponentProps<typeof CounterSearchResults>) => void>(),
  khataAccounts: vi.fn(),
  khataStatement: vi.fn(),
  cartRead: vi.fn(),
  khataApprovers: vi.fn(),
  discardApprovers: vi.fn(),
  discardAttempt: vi.fn(),
  scannedPackApprovers: vi.fn(),
  discountApprovers: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  receiptRefetch: vi.fn(),
  drawerStatusInvalidate: vi.fn(),
  keymapSetData: vi.fn(),
  session: {
    status: 'authenticated',
    data: {
      user: {
        id: 'account-a',
        organizationId: 'org-a',
        status: 'ACTIVE',
        sessionRevoked: false,
        role: 'EMPLOYEE',
      },
    },
  },
  entitlements: {
    organizationId: 'org-a',
    enabledModules: ['pharmacy-counter', 'pharmacy-safety'],
  },
}));

vi.mock('@/lib/auth/sign-out', () => ({ signOutEverything: mocks.signOut }));

vi.mock('next-auth/react', () => ({ useSession: () => mocks.session, signIn: mocks.signIn }));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => mocks.entitlements,
}));

// DEV-743: the card-terminal panel has its own tests (counter-card-terminal-panel.test.tsx); no
// terminal is admitted on these counters, and the panel renders nothing then.
vi.mock('./counter-card-terminal-panel', () => ({ CounterCardTerminalPanel: () => null }));
vi.mock('@/lib/trpc', async () => {
  const { useState } = await import('react');
  const router = (names: string[]) =>
    Object.fromEntries(
      names.map((name) => [
        name,
        {
          useQuery: (input: unknown, options?: unknown) => {
            mocks.queryOptions(name, options);
            mocks.queryInputs(name, input, options);
            return mocks.queries[name];
          },
          useMutation: (options: unknown) => {
            mocks.mutationOptions(name, options);
            const [state, setState] = useState({ isPending: false, error: null as Error | null });
            // Exercise pending/rejection/success transitions for the preference mutation.
            const mutateKeymap = (input: unknown) => {
              const callbacks = options as {
                onSuccess?: (saved: unknown) => void;
                onError?: (error: Error) => void;
              };
              setState({ isPending: true, error: null });
              const mutation = mocks.mutations[name] as (input: unknown) => unknown;
              void Promise.resolve(mutation(input)).then(
                (saved) => {
                  callbacks.onSuccess?.(saved);
                  setState({ isPending: false, error: null });
                },
                (error: Error) => {
                  callbacks.onError?.(error);
                  setState({ isPending: false, error });
                }
              );
            };
            return {
              mutateAsync: mocks.mutations[name],
              mutate: name === 'counterSaveKeymap' ? mutateKeymap : mocks.mutations[name],
              ...state,
              isPaused: mocks.pausedMutations.has(name),
            };
          },
        },
      ])
    );
  const utils = {
    client: {
      pharmacySales: {
        tenderOutcome: { query: mocks.outcomeQuery },
        khataAccounts: { query: mocks.khataAccounts },
        khataStatement: { query: mocks.khataStatement },
        counterCart: { query: mocks.cartRead },
        khataOverLimitApprovers: { query: mocks.khataApprovers },
        tenderDiscardApprovers: { query: mocks.discardApprovers },
        discardTenderAttempt: { mutate: mocks.discardAttempt },
        scannedPackFefoApprovers: { query: mocks.scannedPackApprovers },
        discountApprovers: { query: mocks.discountApprovers },
      },
    },
    pharmacySales: {
      counterSearch: {
        setData: mocks.searchSetData,
        invalidate: vi.fn(),
        fetch: (...args: unknown[]) => mocks.searchFetch(...args),
      },
      counterCart: { cancel: mocks.cancel, invalidate: vi.fn() },
      counterReceipt: { invalidate: mocks.receiptInvalidate },
      counterEvidence: { reset: vi.fn() },
      tradingDayStatus: { invalidate: vi.fn() },
      drawerStatus: { invalidate: mocks.drawerStatusInvalidate },
      counterKeymap: { setData: mocks.keymapSetData, invalidate: vi.fn() },
      counterVoucher: { fetch: (...args: unknown[]) => mocks.voucherFetch(...args) },
    },
    pharmacyPrescriptions: { counterPatientPanel: { invalidate: vi.fn() } },
    pharmacySafety: { controlledRegister: { invalidate: vi.fn() } },
  };
  return {
    trpc: {
      useUtils: () => utils,
      pharmacySales: router([
        'settlementAccess',
        'manualPaymentSettings',
        'counterBranches',
        'counterReceiptFormat',
        'counterKeymap',
        'counterSaveKeymap',
        'counterSearch',
        'upsellSuggestions',
        'counterCart',
        'counterReceipt',
        'counterLotOptions',
        'counterEvidence',
        'customerSnapshot',
        'tradingDayStatus',
        'drawerStatus',
        'create',
        'addLine',
        'changeLine',
        'removeLine',
        'transition',
        'tender',
        'counterReceiptBrowserPrint',
        'counterReceiptBrowserPrintDispatched',
        'counterReceiptBrowserPrintFailed',
        'counterReceiptWhatsApp',
        'openDrawer',
        'captureDemand',
        'setDemandOutcome',
        'declineSubstitute',
        'linkCustomer',
        // DEV-748: a scanned loyalty card links its customer.
        'scanLoyaltyCard',
        'khataSignup',
        'redeemPoints',
        'authenticatePack',
        'substituteProposals',
        'refundAccess',
        'openBills',
        'saleReadiness',
        // DEV-821: the till's cashier list and handover.
        'drawerCashiers',
        'handoverDrawer',
        // DEV-929: the owner's maximum discount, shown where the cashier gives one.
        'discountMaximum',
        // DEV-956: the owner's whole-bill discount switch, and giving one.
        'billDiscountSetting',
        'applyBillDiscount',
        // DEV-958B: the cash-shift panel shown between shifts.
        'openShift',
        'closeShift',
        'shiftReport',
        'shiftApprovers',
      ]),
      pharmacyPrescriptions: router(['counterPatients', 'counterPatientPanel']),
      pharmacySafety: router(['controlledPharmacists']),
      pharmacyAccess: router(['navigation']),
      // DEV-950: prescription lines waiting for a signature at payment.
      pharmacyDispensing: router(['counterSignStatus', 'selfSignReview']),
    },
  };
});

const browserPrint = vi.hoisted(() => ({
  cancel: vi.fn(),
  ready: vi.fn(),
}));
vi.mock('@/lib/pharmacy/counter-browser-print', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/counter-browser-print')>()),
  printCounterBrowserReceipt: mocks.printReceipt,
  assertCounterBrowserPrintReady: browserPrint.ready,
  reserveCounterBrowserPrint: () => ({ cancel: browserPrint.cancel }),
}));

vi.mock('./counter-receipt-view', () => ({
  CounterReceiptView: (props: unknown) => {
    mocks.receiptProps(props);
    return null;
  },
}));
vi.mock('./counter-rx-panel', () => ({
  // Render a marker only when the console offers controlled authorization (QA-138).
  CounterRxPanel: (props: ComponentProps<typeof CounterRxPanel>) => {
    mocks.rxPanelProps(props);
    return (
      <div ref={props.ref} tabIndex={-1} data-testid="rx-focus-target">
        {props.controlled ? <div data-testid="controlled-authorization" /> : null}
      </div>
    );
  },
}));
vi.mock('./counter-search-results', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./counter-search-results')>();
  return {
    CounterSearchResults: (props: ComponentProps<typeof CounterSearchResults>) => {
      mocks.searchProps(props);
      return mocks.renderBranchChildren || mocks.renderSearchResults ? (
        <actual.CounterSearchResults {...props} />
      ) : null;
    },
  };
});
vi.mock('./counter-substitute-proposals', () => ({ CounterSubstituteProposals: () => null }));
vi.mock('./counter-upsell-suggestions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./counter-upsell-suggestions')>();
  return {
    CounterUpsellSuggestions: (props: ComponentProps<typeof actual.CounterUpsellSuggestions>) =>
      mocks.renderBranchChildren ? <actual.CounterUpsellSuggestions {...props} /> : null,
  };
});

import { COUNTER_SLOW_SEARCH_MS, PharmacyCounterConsole } from './counter-console';
import { trpc } from '@/lib/trpc';
import { resolveCounterKeymap } from '@/lib/pharmacy/counter-keymap';
import {
  persistTenderAttempt,
  readTenderAttempt,
  TENDER_STORAGE_MESSAGE,
  tenderAttemptStorageKey,
  type TenderAttempt,
} from './tender-attempt-storage';
import { activeBillStorageKey } from './active-bill-storage';

function issuedReceipt(): CounterReceipt {
  return {
    saleId: 'sale-a',
    receiptNumber: 42,
    branchName: 'Synthetic branch',
    completedAt: '2026-09-11T10:00:00Z',
    businessDate: '2026-09-11',
    currency: 'PKR',
    lines: [
      {
        saleLineId: 'line-a',
        identityStatus: 'ISSUED',
        medicineName: 'Synthetic item',
        strength: null,
        presentation: 'Pack',
        batchNumber: 'BATCH-A',
        expiresAt: '2027-09-11',
        saleUnit: 'PACK',
        quantity: 1,
        canonicalUnits: 1,
        unitPriceMinor: 25000,
        discountMinor: 0,
        lineTotalMinor: 25000,
      },
    ],
    tenders: [
      {
        tenderId: 'tender-a',
        type: 'CASH',
        amountMinor: 25000,
        changeGivenMinor: 5000,
      },
    ],
    totals: {
      grossMinor: 25000,
      discountMinor: 0,
      netMinor: 25000,
      tenderedMinor: 25000,
      changeMinor: 5000,
    },
  };
}

function cart(overrides: Partial<CounterCart> = {}): CounterCart {
  return {
    saleId: 'sale-a',
    status: 'OPEN',
    receiptNumber: null,
    lines: [
      {
        saleLineId: 'line-a',
        medicineId: 'synthetic-medicine',
        medicineName: 'Synthetic item',
        strength: null,
        presentation: 'Pack',
        saleUnit: 'PACK',
        quantity: 1,
        canonicalUnits: 1,
        unitPriceMinor: 25000,
        proRataCeilingMinor: 25000,
        discountMinor: 0,
        lineTotalMinor: 25000,
        rx: false,
        controlled: false,
        restricted: false,
        highAlert: false,
        lasa: false,
        coldChain: false,
        emergencySupply: false,
        allocations: [],
      },
    ],
    totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 0 },
    ...overrides,
  };
}

function barcodeRow(overrides: Partial<CounterSearchRow> = {}): CounterSearchRow {
  return {
    medicineId: 'med-barcode',
    displayName: 'Paracetamol',
    brandName: null,
    manufacturer: null,
    strength: '500 mg',
    presentationId: 'presentation-a',
    presentation: 'Tablet',
    dosageForm: 'Tablet',
    route: 'Oral',
    matchedOn: 'BARCODE',
    recommendedLotId: 'lot-a',
    packLevelId: 'pack-a',
    unitsPerPack: 1,
    printedMrpMinor: 10000,
    roundingIncrementMinor: 1,
    batchNumber: 'B-1',
    nearestSafeExpiry: '2028-06-30T00:00:00.000Z',
    onHandUnits: 10,
    saleableUnits: [],
    saleUnits: [
      {
        kind: 'UNIT',
        packLevelId: 'pack-a',
        levelLabel: 'UNIT',
        canonicalUnitsPerSaleUnit: 1,
      },
    ],
    restriction: {
      rx: false,
      otc: true,
      restricted: false,
      controlled: false,
      highAlert: false,
      lasa: false,
    },
    storage: {
      coldChain: false,
      locationKind: 'STORE',
      locationCode: 'A',
      locationName: 'Store',
    },
    blocked: [],
    ...overrides,
  };
}

/** DEV-725: this counter device has no OPEN drawer. */
function closeDrawer() {
  mocks.queries.drawerStatus = query({ openDrawer: null });
}

/** DEV-725: this counter device has an OPEN drawer, so scan/search is offered. */
function openTheDrawer() {
  mocks.queries.drawerStatus = query({ openDrawer: { id: 'drawer-default' } });
}

function query(data?: unknown): Query {
  return {
    data,
    isSuccess: true,
    isLoading: false,
    isFetching: false,
    isError: false,
    isStale: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  };
}

function accepted(remainingMinor = 12450) {
  return {
    tenderId: 'tender-a',
    settled: remainingMinor === 0,
    remainingMinor,
    receiptNumber: remainingMinor === 0 ? 42 : null,
    replayed: false,
  };
}

function refused(code: string, message = code) {
  return Object.assign(new Error(message), { data: { code } });
}

function renderPayment(element: Parameters<typeof render>[0]) {
  const result = render(element);
  // DEV-725: with the drawer closed the opening step replaces the scan field.
  fireEvent.keyDown(screen.queryByLabelText('Scan or search') ?? window, { key: 'F9' });
  return result;
}

const TENDER_LABELS: Record<string, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  BANK_TRANSFER: 'Bank transfer',
  KHATA: 'Khata',
  JAZZCASH: 'JazzCash',
  EASYPAISA: 'Easypaisa',
  RAAST: 'Raast',
};

function tenderButton(type: string) {
  const methods = screen.getByRole('group', { name: 'Payment method', hidden: true });
  return within(methods).getByRole('button', { name: TENDER_LABELS[type], hidden: true });
}

function chooseTender(type: string) {
  fireEvent.click(tenderButton(type));
}

function enterPayment(type = 'CASH') {
  chooseTender(type);
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '125.50' } });
  if (type === 'CASH')
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '200.00' } });
  if (type === 'BANK_TRANSFER')
    fireEvent.change(screen.getByLabelText('Transfer reference'), {
      target: { value: 'BANK-001' },
    });
  if (type === 'CARD') {
    fireEvent.change(screen.getByLabelText('Card last 4 digits or terminal reference'), {
      target: { value: '4242' },
    });
    fireEvent.change(screen.getByLabelText('Approval code'), { target: { value: 'A1B2C3' } });
  }
  fireEvent.click(screen.getByRole('button', { name: 'Take payment', hidden: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.renderBranchChildren = false;
  mocks.renderSearchResults = false;
  browserPrint.ready.mockReset();
  mocks.keymapSetData.mockImplementation((_input, saved) => {
    mocks.queries.counterKeymap = query(saved);
  });
  mocks.session = {
    status: 'authenticated',
    data: {
      user: {
        id: 'account-a',
        organizationId: 'org-a',
        status: 'ACTIVE',
        sessionRevoked: false,
        role: 'EMPLOYEE',
      },
    },
  };
  mocks.entitlements = {
    organizationId: 'org-a',
    enabledModules: ['pharmacy-counter', 'pharmacy-safety'],
  };
  mocks.outcomeQuery.mockReset().mockResolvedValue({ status: 'UNKNOWN', replayUnsafe: true });
  mocks.searchQuery.mockReset().mockImplementation(async () => mocks.queries.counterSearch?.data);
  mocks.receiptRefetch.mockReset().mockResolvedValue({ isSuccess: true, data: issuedReceipt() });
  for (const name of [
    'manualPaymentSettings',
    'counterBranches',
    'counterReceiptFormat',
    'counterKeymap',
    'counterSearch',
    'counterCart',
    'counterReceipt',
    'counterLotOptions',
    'counterEvidence',
    'customerSnapshot',
    'substituteProposals',
    'counterPatients',
    'counterPatientPanel',
    'controlledPharmacists',
    'refundAccess',
    'navigation',
    'openBills',
    'saleReadiness',
    'drawerCashiers',
    'counterSignStatus',
  ])
    mocks.queries[name] = query();
  // DEV-929: no maximum discount is set unless a test says otherwise.
  mocks.queries.discountMaximum = query({ maxDiscountBps: 10_000, canChange: false });
  // DEV-956: the whole-bill discount is off unless a test switches it on.
  mocks.queries.billDiscountSetting = query({ enabled: false, canChange: false });
  // DEV-97: the operator takes payment unless a test says otherwise.
  mocks.queries.settlementAccess = query({
    authorized: true,
    userId: 'account-a',
    organizationId: 'org-a',
  });
  // A counter taking cash has an open drawer; tests about a closed drawer say so.
  mocks.queries.tradingDayStatus = query({ dayClosed: false });
  mocks.queries.drawerStatus = query({ openDrawer: { id: 'drawer-default' } });
  mocks.queries.counterBranches = query({
    branches: [{ id: 'branch-a', name: 'Synthetic branch', code: 'MT1' }],
  });
  mocks.queries.counterCart = { ...query(cart()), refetch: mocks.refetch };
  mocks.queries.counterReceipt!.refetch = mocks.receiptRefetch;
  for (const name of [
    'counterSaveKeymap',
    'create',
    'addLine',
    'changeLine',
    'removeLine',
    'transition',
    'tender',
    'counterReceiptBrowserPrint',
    'counterReceiptBrowserPrintDispatched',
    'counterReceiptBrowserPrintFailed',
    'openDrawer',
    'captureDemand',
    'setDemandOutcome',
    'declineSubstitute',
    'linkCustomer',
    'scanLoyaltyCard',
    'khataSignup',
    'redeemPoints',
    'authenticatePack',
    'handoverDrawer',
    'applyBillDiscount',
  ])
    mocks.mutations[name] = vi.fn();
  mocks.mutations.tender!.mockResolvedValue(accepted());
  const copyCounts = new Map<string, number>();
  mocks.mutations.counterReceiptBrowserPrint!.mockImplementation(
    async (input: { branchId: string; saleId: string }) => {
      const key = `${input.branchId}:${input.saleId}`;
      const copyNumber = (copyCounts.get(key) ?? 0) + 1;
      copyCounts.set(key, copyNumber);
      return { copyNumber, reprint: copyNumber > 1 };
    }
  );
  mocks.mutations.counterReceiptBrowserPrintDispatched!.mockResolvedValue({ recorded: true });
  mocks.mutations.counterReceiptBrowserPrintFailed!.mockResolvedValue({ recorded: true });
  mocks.searchFetch
    .mockReset()
    .mockImplementation((...args: unknown[]) => mocks.searchQuery(...args));
  mocks.cancel.mockResolvedValue(undefined);
  mocks.receiptInvalidate.mockResolvedValue(undefined);
  mocks.refetch.mockImplementation(async () => {
    Object.assign(mocks.queries.counterCart!, {
      isSuccess: true,
      isError: false,
      isFetching: false,
      isStale: false,
    });
    return mocks.queries.counterCart;
  });
  mocks.khataAccounts.mockResolvedValue([
    { id: 'family-a', displayName: 'Family A', balanceMinor: 0, creditLimitMinor: 100000 },
  ]);
  mocks.khataApprovers.mockResolvedValue([]);
  mocks.scannedPackApprovers.mockReset().mockResolvedValue([]);
  mocks.discountApprovers.mockReset().mockResolvedValue([]);
  mocks.signIn.mockResolvedValue({ ok: true });
  mocks.cartRead.mockReset().mockResolvedValue(cart());
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function stageControlledMedicine() {
  const row = barcodeRow();
  mocks.searchProps.mock.lastCall![0].onSelect({
    ...row,
    restriction: { ...row.restriction, controlled: true },
  });
}

describe('DEV-498 counter workspace', () => {
  it.each([undefined, 'sale-a'])(
    'keeps controlled authorization absent for an ordinary bill (%s)',
    (saleId) => {
      render(<PharmacyCounterConsole initialSaleId={saleId} initialBranchId="branch-a" />);
      expect(screen.queryByTestId('controlled-authorization')).not.toBeInTheDocument();
      act(() => mocks.searchProps.mock.lastCall![0].onSelect(barcodeRow()));
      expect(screen.queryByTestId('controlled-authorization')).not.toBeInTheDocument();
    }
  );

  it('offers authorization before a controlled line is added and removes it when an ordinary medicine is selected', () => {
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    act(stageControlledMedicine);
    expect(screen.getByTestId('controlled-authorization')).toBeInTheDocument();
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
    act(() => mocks.searchProps.mock.lastCall![0].onSelect(barcodeRow()));
    expect(screen.queryByTestId('controlled-authorization')).not.toBeInTheDocument();
  });

  it('keeps authorization available for a controlled bill while searching for an ordinary medicine', () => {
    const bill = cart();
    mocks.queries.counterCart!.data = cart({
      lines: bill.lines.map((line) => ({ ...line, controlled: true })),
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() => mocks.searchProps.mock.lastCall![0].onSelect(barcodeRow()));
    expect(screen.getByTestId('controlled-authorization')).toBeInTheDocument();
  });

  it('keeps the cart beside the payment rail and internal branch codes out of the counter', () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    // DEV-977 (owner-approved Counter v2): the bill lines take the main column, directly
    // under the search, and the payment rail sits beside them; they no longer share a box.
    const rail = screen.getByLabelText('Bill total');
    const cartRegion = screen.getByRole('region', { name: 'Cart' });
    expect(rail).not.toContainElement(cartRegion);
    expect(document.getElementById('counter-scan-search')).not.toContainElement(cartRegion);
    expect(
      cartRegion.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.getByLabelText('Branch')).not.toHaveTextContent('MT1');
    expect(document.body).not.toHaveTextContent(/(?:POS|CRM)-\d|Phase 0/);
  });

  it('floats the drawer confirmation, dismisses it automatically, and keeps the header status', async () => {
    vi.useFakeTimers();
    mocks.queries.drawerStatus = query({ openDrawer: null });
    mocks.mutations.openDrawer!.mockResolvedValue({ id: 'drawer-new' });
    const view = render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    fireEvent.change(screen.getByLabelText('Opening cash', { exact: true }), {
      target: { value: '0' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open drawer' })));
    const toast = screen
      .getByText('Cash drawer opened for this counter.')
      .closest('[role="status"]');
    expect(toast).toHaveClass('fixed');
    mocks.queries.drawerStatus = query({ openDrawer: { id: 'drawer-new' } });
    view.rerender(<PharmacyCounterConsole initialBranchId="branch-a" />);
    await act(async () => vi.advanceTimersByTime(5000));
    expect(screen.queryByText('Cash drawer opened for this counter.')).not.toBeInTheDocument();
    expect(within(document.querySelector('header')!).getByText('Drawer open')).toBeInTheDocument();
  });
});

describe('PharmacyCounterConsole authoritative bill state', () => {
  it('shows the counter skeleton while branches load', () => {
    mocks.queries.counterBranches = { ...query(), isLoading: true };
    const { container } = render(<PharmacyCounterConsole />);
    expect(screen.getByRole('status', { name: 'Loading pharmacy counter' })).toBeInTheDocument();
    expect(container.querySelector('[data-counter-skeleton-bill]')).toBeInTheDocument();
    expect(container.querySelector('[data-counter-skeleton-total]')).toBeInTheDocument();
  });

  it.each([
    'missing',
    'loading',
    'fetching',
    'error',
    'denied',
    'stale',
    'placeholder',
    'wrong-sale',
    'held',
    'open-zero',
    'empty',
    'invalid-totals',
  ])('never settles or tenders a %s bill', (state) => {
    const settled = cart({
      status: 'COMPLETED',
      receiptNumber: 42,
      totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 25000 },
    });
    const current = mocks.queries.counterCart!;
    current.data = settled;
    if (state === 'missing') current.data = undefined;
    if (state === 'loading') Object.assign(current, { isLoading: true, isSuccess: false });
    if (state === 'fetching') current.isFetching = true;
    if (state === 'error' || state === 'denied')
      Object.assign(current, {
        isError: true,
        isSuccess: false,
        error: refused(state === 'denied' ? 'FORBIDDEN' : 'INTERNAL_SERVER_ERROR'),
      });
    if (state === 'stale') current.isStale = true;
    if (state === 'placeholder') current.isPlaceholderData = true;
    if (state === 'wrong-sale') current.data = { ...settled, saleId: 'sale-other' };
    if (state === 'held') current.data = { ...settled, status: 'HELD' };
    if (state === 'open-zero') current.data = { ...settled, status: 'OPEN' };
    if (state === 'empty') current.data = { ...settled, lines: [] };
    if (state === 'invalid-totals')
      current.data = { ...settled, totals: { ...settled.totals, netMinor: NaN } };
    mocks.queries.counterReceipt!.data = {
      saleId: 'sale-a',
      patientName: 'Cached receipt must stay hidden',
    };
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(screen.queryByText('Settled')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeDisabled();
    expect(mocks.mutations.tender).not.toHaveBeenCalled();
    expect(mocks.receiptProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ receipt: null, state: 'idle' })
    );
  });

  it('opens receipts on the branch saved paper and keeps a cashier change for the session', () => {
    mocks.queries.counterReceiptFormat = query({
      layout: { version: 1, paperWidth: 80, browserPaper: 'A4' },
      revision: 3,
    });
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(mocks.queryOptions).toHaveBeenCalledWith(
      'counterReceiptFormat',
      expect.objectContaining({ enabled: true })
    );
    const last = () =>
      mocks.receiptProps.mock.lastCall![0] as {
        format: string;
        onFormatChange: (format: string) => void;
      };
    expect(last().format).toBe('A4');
    act(() => last().onFormatChange('THERMAL_58'));
    expect(last().format).toBe('THERMAL_58');
  });

  it('falls back to the 80 mm thermal paper when no branch format is readable', () => {
    mocks.queries.counterReceiptFormat = { ...query(), isError: true, isSuccess: false };
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect((mocks.receiptProps.mock.lastCall![0] as { format: string }).format).toBe('THERMAL');
  });

  it('tells the counter when no earn rate is set, and not once one is (DEV-746)', () => {
    const snapshot = (earnRateSet: boolean) =>
      query({
        customer: { id: 'customer-a', displayName: 'Retail name', creditLimitMinor: 0 },
        pointsBalance: 35,
        earnRateSet,
        creditBalanceMinor: 0,
        availableCreditMinor: 0,
        pointsHistory: [],
        pointsCount: 0,
        pointsPage: 1,
        history: [],
      });
    const notice = 'Points are not being earned: set an earn rate in Loyalty settings';
    mocks.queries.customerSnapshot = snapshot(false);
    const { unmount } = renderPayment(<PharmacyCounterConsole />);
    fireEvent.click(screen.getByRole('button', { name: '35 loyalty points', hidden: true }));
    expect(screen.getByText(notice)).toBeInTheDocument();
    expect(screen.getByText('35 points · Khata', { exact: false })).toBeInTheDocument();
    unmount();
    mocks.queries.customerSnapshot = snapshot(true);
    renderPayment(<PharmacyCounterConsole />);
    fireEvent.click(screen.getByRole('button', { name: '35 loyalty points', hidden: true }));
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
  });

  it.each([
    // DEV-943: 19:30 UTC is already 00:30 the next day in Karachi; 18:59 UTC is still 23:59.
    ['Asia/Karachi', '2026-11-18T19:30:00.000Z', '2026-11-19'],
    ['Asia/Karachi', '2026-11-18T18:59:00.000Z', '2026-11-18'],
    // A UTC organisation keeps the UTC day, as before.
    ['UTC', '2026-11-18T19:30:00.000Z', '2026-11-18'],
  ])('dates a %s points-ledger entry at %s on the shop’s day', (timezone, occurredAt, day) => {
    mocks.queries.counterBranches = query({
      branches: [{ id: 'branch-a', name: 'Synthetic branch', code: 'MT1' }],
      timezone,
    });
    mocks.queries.customerSnapshot = query({
      customer: { id: 'customer-a', displayName: 'Retail name', creditLimitMinor: 0 },
      pointsBalance: 35,
      earnRateSet: true,
      creditBalanceMinor: 0,
      availableCreditMinor: 0,
      pointsHistory: [
        { id: 'points-a', kind: 'EARN', points: 5, occurredAt, sale: { receiptNumber: 7 } },
      ],
      pointsCount: 1,
      pointsPage: 1,
      history: [],
    });
    renderPayment(<PharmacyCounterConsole />);
    fireEvent.click(screen.getByRole('button', { name: '35 loyalty points', hidden: true }));
    const ledger = screen.getByRole('list', { name: 'Points ledger', hidden: true });
    expect(ledger).toHaveTextContent(`EARN · Receipt 7 · ${day}`);
  });

  it('does not settle an idle counter', () => {
    renderPayment(<PharmacyCounterConsole />);
    expect(screen.queryByText('Settled')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeDisabled();
  });

  it('allows an empty bill to recover without locking bill actions or claiming settlement', async () => {
    mocks.queries.counterCart!.data = cart({
      lines: [],
      totals: { grossMinor: 0, discountMinor: 0, netMinor: 0, tenderedMinor: 0 },
    });
    mocks.queries.counterCart!.isError = true;
    mocks.queries.counterCart!.isSuccess = false;
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh bill' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Hold/, hidden: true })).toBeEnabled()
    );
    expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeDisabled();
    expect(screen.queryByText('Settled')).not.toBeInTheDocument();
    expect(mocks.mutations.tender).not.toHaveBeenCalled();
  });

  it('shows settlement only for a fresh completed bill with a known balance and receipt number', () => {
    mocks.queries.counterCart!.data = cart({
      status: 'COMPLETED',
      receiptNumber: 42,
      totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 25000 },
    });
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(screen.getByText('Settled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeDisabled();
  });
});

describe('PharmacyCounterConsole split tender (#722)', () => {
  it('sends two equal cash rows as distinct payments and lists each recorded row', async () => {
    const cash = (index: number) => ({
      tenderId: `cash-${index}`,
      type: 'CASH',
      amountMinor: 12500,
    });
    mocks.mutations.tender!.mockImplementation(async () => {
      const count = mocks.mutations.tender!.mock.calls.length;
      return { ...accepted(count === 2 ? 0 : 12500), tenderId: `cash-${count - 1}` };
    });
    mocks.refetch.mockImplementation(async () => {
      const count = mocks.mutations.tender!.mock.calls.length;
      mocks.queries.counterCart!.data = cart({
        status: count === 2 ? 'COMPLETED' : 'OPEN',
        receiptNumber: count === 2 ? 42 : null,
        tenders: Array.from({ length: count }, (_, index) => cash(index)),
        totals: {
          grossMinor: 25000,
          discountMinor: 0,
          netMinor: 25000,
          tenderedMinor: count * 12500,
        },
      });
      return mocks.queries.counterCart;
    });
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '125.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment', hidden: true }));
    await waitFor(() =>
      expect(screen.getByLabelText('Recorded payments').children).toHaveLength(1)
    );
    expect(screen.queryByText('Settled')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeEnabled()
    );
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '125.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment', hidden: true }));
    await screen.findByText('Settled');
    expect(mocks.mutations.tender!.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([
      'counter-tender:sale-a:CASH:12500',
      'counter-tender:sale-a:CASH:12500:after:12500',
    ]);
    // The settled receipt drawer hides the panel from assistive tech; the rows remain.
    await waitFor(() =>
      expect(screen.getByLabelText('Recorded payments').children).toHaveLength(2)
    );
  });
});

describe('PharmacyCounterConsole Sindh cash-memo buyer (#708)', () => {
  afterEach(() => {
    cashMemoHold.live = undefined;
  });

  it('hides the buyer name and sends none while the cash memo is held for counsel', async () => {
    mocks.queries.counterBranches = query({
      branches: [{ id: 'branch-a', name: 'Synthetic branch', code: 'MT1', provinceCode: 'PK-SD' }],
    });
    mocks.mutations.tender!.mockResolvedValue(accepted(0));
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(screen.queryByLabelText('Buyer name (cash memo, optional)')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Take payment', hidden: true }));
    await waitFor(() => expect(mocks.mutations.tender).toHaveBeenCalledTimes(1));
    expect(mocks.mutations.tender).toHaveBeenCalledWith(
      expect.not.objectContaining({ buyerName: expect.anything() })
    );
  });

  it('keeps the replayable balance key when a buyer name is sent', async () => {
    cashMemoHold.live = true; // As the memo will behave once counsel lifts the hold.
    mocks.queries.counterBranches = query({
      branches: [{ id: 'branch-a', name: 'Synthetic branch', code: 'MT1', provinceCode: 'PK-SD' }],
    });
    mocks.mutations.tender!.mockResolvedValue(accepted(0));
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.change(screen.getByLabelText('Buyer name (cash memo, optional)'), {
      target: { value: 'Synthetic Buyer' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment', hidden: true }));
    // A repeated tap at the same balance replays the first payment; a changed buyer
    // conflicts on the payload hash instead of recording a second payment.
    await waitFor(() =>
      expect(mocks.mutations.tender).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          buyerName: 'Synthetic Buyer',
          idempotencyKey: 'counter-tender:sale-a:CASH:25000',
        })
      )
    );
  });
});

describe('DEV-499 exact cash with F9 then Enter', () => {
  it('takes the prefilled balance as exact cash with F9 then Enter', async () => {
    mocks.mutations.tender!.mockResolvedValue(accepted(0));
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(screen.getByLabelText('Cash received')).toHaveValue('250.00');
    // F9 focuses the tender panel itself; Enter there is the second and last step.
    await waitFor(() =>
      expect(document.activeElement).toContainElement(screen.getByLabelText('Cash received'))
    );
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    await waitFor(() =>
      expect(mocks.mutations.tender).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ type: 'CASH', amountMinor: 25000 })
      )
    );
    expect(Object.hasOwn(mocks.mutations.tender!.mock.calls[0]![0], 'cashReceivedMinor')).toBe(
      false
    );
  });
});

describe('PharmacyCounterConsole offline indicator (DEV-641)', () => {
  function goOffline(onLine: { mockReturnValue: (value: boolean) => unknown }, offline = true) {
    onLine.mockReturnValue(!offline);
    act(() => {
      window.dispatchEvent(new Event(offline ? 'offline' : 'online'));
    });
  }

  it('shows an offline banner and the queued payment until the connection returns', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    try {
      let resolve!: (value: ReturnType<typeof accepted>) => void;
      mocks.mutations.tender!.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          })
      );
      renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      expect(screen.queryByText(/^Offline —/)).not.toBeInTheDocument();

      goOffline(onLine);
      expect(
        screen.getByText('Offline — this counter cannot reach the server.')
      ).toBeInTheDocument();
      expect(
        screen.getByText('Search, bill changes and payments wait until the connection returns.')
      ).toBeInTheDocument();

      // React Query holds the mutation while offline instead of sending it.
      mocks.pausedMutations.add('tender');
      enterPayment();
      expect(mocks.mutations.tender).toHaveBeenCalledTimes(1);
      expect(
        screen.getByText('Offline — the payment will be sent when the connection returns.')
      ).toBeInTheDocument();
      expect(screen.getByText('1 payment waiting')).toBeInTheDocument();
      expect(screen.getByText(/^Offline — this payment will be sent/)).toBeInTheDocument();
      expect(screen.queryByText('Taking payment… Keep this bill open.')).not.toBeInTheDocument();

      mocks.pausedMutations.delete('tender');
      goOffline(onLine, false);
      expect(screen.queryByText(/^Offline —/)).not.toBeInTheDocument();
      expect(screen.queryByText('1 payment waiting')).not.toBeInTheDocument();
      expect(screen.getByText('Taking payment… Keep this bill open.')).toBeInTheDocument();
      await act(async () => resolve(accepted()));
      expect(mocks.mutations.tender).toHaveBeenCalledTimes(1);
    } finally {
      mocks.pausedMutations.clear();
      onLine.mockRestore();
    }
  });

  it('never calls a dispatched payment queued when the connection drops', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    try {
      let resolve!: (value: ReturnType<typeof accepted>) => void;
      mocks.mutations.tender!.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          })
      );
      renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      enterPayment();
      goOffline(onLine);
      expect(
        screen.getByText('Offline — this payment is waiting for the server to confirm it.')
      ).toBeInTheDocument();
      expect(screen.queryByText('1 payment waiting')).not.toBeInTheDocument();
      expect(screen.queryByText(/payment will be sent/)).not.toBeInTheDocument();
      expect(screen.getByText('Taking payment… Keep this bill open.')).toBeInTheDocument();
      goOffline(onLine, false);
      await act(async () => resolve(accepted()));
      expect(mocks.mutations.tender).toHaveBeenCalledTimes(1);
    } finally {
      onLine.mockRestore();
    }
  });
});

describe('PharmacyCounterConsole tender recovery', () => {
  it('#710 submits manual evidence and clears its recovery record only after acceptance', async () => {
    mocks.queries.manualPaymentSettings = query({
      settings: { RAAST: { destination: 'Merchant till', allowReferenceSkip: false } },
      revision: 0,
    });
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    chooseTender('RAAST');
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '125.50' } });
    fireEvent.change(screen.getByLabelText('Payer’s name'), { target: { value: 'Ayesha' } });
    fireEvent.change(screen.getByLabelText('Transaction ID (last 4–6 digits)'), {
      target: { value: '001234' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment', hidden: true }));
    await waitFor(() =>
      expect(mocks.mutations.tender).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'RAAST',
          providerRef: '001234',
          payerName: 'Ayesha',
          amountMinor: 12550,
        })
      )
    );
    await waitFor(() =>
      expect(
        readTenderAttempt({ organizationId: 'org-a', accountId: 'account-a', branchId: 'branch-a' })
      ).toEqual({ status: 'empty' })
    );
    expect(screen.queryByText(TENDER_STORAGE_MESSAGE)).not.toBeInTheDocument();
  });
  it.each([
    ['BAD_REQUEST', 'DRAWER_NOT_OPEN', 'CASH'],
    ['FORBIDDEN', 'Access refused.', 'CASH'],
    ['UNAUTHORIZED', 'Sign in required.', 'CASH'],
    ['BAD_REQUEST', 'INVALID_MANUAL_CAPTURE', 'CARD'],
    ['BAD_REQUEST', 'CONSENT_REQUIRED', 'BANK_TRANSFER'],
  ])('retains a %s / %s rejection on the same bill', async (code, message, type) => {
    mocks.mutations.tender!.mockRejectedValue(refused(code!, message));
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    enterPayment(type);
    await screen.findByText(/Payment was not accepted/);
    expect(screen.getByLabelText('Amount')).toHaveValue('125.50');
    expect(tenderButton(type)).toHaveAttribute('aria-pressed', 'true');
    if (type === 'CASH') expect(screen.getByLabelText('Cash received')).toHaveValue('200.00');
    expect(mocks.mutations.tender).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        branchId: 'branch-a',
        saleId: 'sale-a',
        amountMinor: 12550,
        type,
        // DEV-713: a manual card attempt carries a fresh key, like other manual tenders.
        idempotencyKey:
          type === 'CARD'
            ? expect.stringMatching(/^counter-tender:sale-a:CARD:[0-9a-f-]{36}$/)
            : `counter-tender:sale-a:${type}:12550`,
        ...(type === 'CARD' ? { providerRef: '4242', approvalCode: 'A1B2C3' } : {}),
      })
    );
    expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeDisabled();
    expect(screen.queryByText('Settled')).not.toBeInTheDocument();
  });

  it('cannot tender after a failed read retry; a valid read preserves the draft and original key', async () => {
    mocks.mutations.tender!.mockRejectedValue(refused('BAD_REQUEST', 'DRAWER_NOT_OPEN'));
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    enterPayment();
    await screen.findByText(/Payment was not accepted/);
    mocks.refetch.mockRejectedValueOnce(new Error('Read failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh bill' }));
    await waitFor(() => expect(mocks.refetch).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh bill' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeEnabled()
    );
    expect(screen.getByLabelText('Amount')).toHaveValue('125.50');
    expect(screen.getByLabelText('Cash received')).toHaveValue('200.00');
    fireEvent.click(screen.getByRole('button', { name: 'Take payment', hidden: true }));
    await waitFor(() => expect(mocks.mutations.tender).toHaveBeenCalledTimes(2));
    expect(mocks.mutations.tender!.mock.calls[1]![0]).toEqual(
      mocks.mutations.tender!.mock.calls[0]![0]
    );
  });

  it.each(['lost', 'internal', 'malformed', 'malformed-replay'])(
    'locks a %s acknowledgement without replay even after a completed read',
    async (kind) => {
      if (kind === 'lost') mocks.mutations.tender!.mockRejectedValue(new Error('Connection lost'));
      if (kind === 'internal')
        mocks.mutations.tender!.mockRejectedValue(refused('INTERNAL_SERVER_ERROR'));
      if (kind === 'malformed') mocks.mutations.tender!.mockResolvedValue({ settled: true });
      if (kind === 'malformed-replay')
        mocks.mutations.tender!.mockResolvedValue({ replayed: true });
      renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      enterPayment();
      await screen.findByText(/Payment outcome is unknown/);
      expect(screen.getByLabelText('Amount')).toHaveValue('125.50');
      expect(screen.getByLabelText('Cash received')).toHaveValue('200.00');
      expect(screen.getByRole('button', { name: /^Hold/, hidden: true })).toBeDisabled();
      mocks.queries.counterCart!.data = cart({
        status: 'COMPLETED',
        receiptNumber: 42,
        totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 25000 },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Refresh bill' }));
      await waitFor(() => expect(mocks.refetch).toHaveBeenCalledTimes(1));
      expect(screen.queryByText('Settled')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Take payment', hidden: true }));
      expect(mocks.mutations.tender).toHaveBeenCalledTimes(1);
      expect(mocks.mutationOptions).toHaveBeenCalledWith('tender', { retry: false });
    }
  );

  it.each(['throws', 'error-result'])(
    'keeps acknowledged payment accepted when refresh %s',
    async (kind) => {
      if (kind === 'throws') mocks.refetch.mockRejectedValue(new Error('Read failed'));
      else mocks.refetch.mockResolvedValue({ isSuccess: false, isError: true, data: cart() });
      renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      enterPayment();
      await screen.findByText('Payment recorded.');
      expect(
        screen.getByText(/Payment recorded, but the bill refresh is incomplete/)
      ).toBeInTheDocument();
      expect(screen.getByLabelText('Amount')).toHaveValue('');
      expect(screen.getByLabelText('Cash received')).toHaveValue('');
      expect(screen.queryByText(/Payment outcome is unknown/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeDisabled();
      expect(mocks.mutations.tender).toHaveBeenCalledTimes(1);
    }
  );

  it('accepts a validated replay acknowledgement without claiming the bill settled', async () => {
    mocks.mutations.tender!.mockResolvedValue({ ...accepted(), replayed: true });
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    enterPayment();
    await screen.findByText('Payment recorded.');
    expect(screen.getByLabelText('Amount')).toHaveValue('');
    expect(screen.queryByText('Settled')).not.toBeInTheDocument();
  });

  it.each([
    'refetch',
    'custom-shortcut',
    'time',
    'read-error',
    'cart-refetch',
    'next-bill',
    'typing',
    'close',
    'denied',
    'unauthorized',
    'not-found',
    'branch',
    'account',
  ])(
    'retains an issued receipt safely through %s after a confirmed full payment',
    async (scenario) => {
      if (scenario === 'custom-shortcut') {
        mocks.queries.counterKeymap!.data = resolveCounterKeymap({
          preset: 'devfathom',
          overrides: { focusSearch: { key: 'r', alt: true } },
        });
      }
      const completeCounterReceipt = issuedReceipt();
      mocks.receiptRefetch.mockImplementationOnce(async () => {
        mocks.queries.counterReceipt!.data = completeCounterReceipt;
        return { isSuccess: true, data: completeCounterReceipt };
      });
      mocks.mutations.tender!.mockResolvedValue(accepted(0));
      mocks.refetch.mockImplementation(async () => {
        mocks.queries.counterCart!.data = cart({
          status: 'COMPLETED',
          receiptNumber: 42,
          totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 25000 },
        });
        return mocks.queries.counterCart;
      });
      const view = renderPayment(
        <PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />
      );
      fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '250.00' } });
      fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '300.00' } });
      fireEvent.click(screen.getByRole('button', { name: 'Take payment', hidden: true }));
      await screen.findByText('Payment recorded.');
      expect(screen.getByLabelText('Amount')).toHaveValue('');
      expect(screen.getByLabelText('Cash received')).toHaveValue('');
      expect(screen.getByText('Settled')).toBeInTheDocument();
      // DEV-977: the phone bar's "Take payment" also reads so; the payment panel's is the other.
      const [panelSubmit, ...others] = screen
        .getAllByText('Take payment')
        .filter((text) => !text.closest('[aria-label="Phone payment"]'));
      expect(others).toHaveLength(0);
      expect(panelSubmit!.closest('button')).toBeDisabled();
      const receiptDrawer = screen.getByRole('dialog', { name: 'Receipt preview' });
      expect(within(receiptDrawer).getByRole('region', { name: 'Change due' })).toHaveTextContent(
        '50.00'
      );
      await waitFor(() =>
        expect(receiptDrawer).toContainElement(document.activeElement as HTMLElement)
      );
      fireEvent.keyDown(receiptDrawer, { key: 'F10' });
      await waitFor(() =>
        expect(mocks.printReceipt).toHaveBeenCalledExactlyOnceWith(
          completeCounterReceipt,
          'en',
          'THERMAL',
          false,
          expect.objectContaining({ cancel: browserPrint.cancel })
        )
      );
      expect(mocks.mutations.tender).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ amountMinor: 25000, cashReceivedMinor: 30000 })
      );

      // Background cache invalidation must not make an already presented receipt
      // disappear while the cashier is still reviewing it.
      Object.assign(mocks.queries.counterReceipt!, {
        data: undefined,
        isFetching: true,
        isSuccess: false,
      });
      view.rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      expect(mocks.receiptProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ receipt: completeCounterReceipt, state: 'ready' })
      );
      if (scenario === 'time') {
        vi.useFakeTimers();
        try {
          act(() => vi.advanceTimersByTime(120_000));
          expect(receiptDrawer).toBeVisible();
        } finally {
          vi.useRealTimers();
        }
      }
      const denialCode =
        scenario === 'denied'
          ? 'FORBIDDEN'
          : scenario === 'unauthorized'
            ? 'UNAUTHORIZED'
            : scenario === 'not-found'
              ? 'NOT_FOUND'
              : null;
      if (scenario === 'read-error' || denialCode) {
        Object.assign(mocks.queries.counterReceipt!, {
          isError: true,
          // A failed background refetch can leave the previous data in cache.
          data: denialCode ? completeCounterReceipt : undefined,
          error: denialCode ? refused(denialCode) : new Error('Synthetic network failure'),
        });
      }
      if (scenario === 'cart-refetch') mocks.queries.counterCart!.isFetching = true;
      if (scenario === 'branch') {
        mocks.queries.counterBranches!.data = {
          branches: [
            { id: 'branch-a', name: 'Synthetic branch', code: 'MT1' },
            { id: 'branch-b', name: 'Other branch', code: 'MT2' },
          ],
        };
      }
      view.rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);

      if (denialCode) {
        expect(screen.queryByRole('button', { name: /Last receipt/ })).not.toBeInTheDocument();
        expect(mocks.receiptProps).toHaveBeenLastCalledWith(
          expect.objectContaining({ receipt: null })
        );
        fireEvent.keyDown(receiptDrawer, { key: 'F10' });
        expect(mocks.printReceipt).toHaveBeenCalledTimes(1);
        fireEvent.click(within(receiptDrawer).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(receiptDrawer).not.toBeVisible());

        // Preview must not repopulate the snapshot from denied cached data.
        fireEvent.click(screen.getByRole('button', { name: 'Preview receipt' }));
        const deniedDrawer = await screen.findByRole('dialog', { name: 'Receipt preview' });
        expect(mocks.receiptProps).toHaveBeenLastCalledWith(
          expect.objectContaining({ receipt: null })
        );
        fireEvent.keyDown(deniedDrawer, { key: 'F10' });
        expect(mocks.printReceipt).toHaveBeenCalledTimes(1);
        fireEvent.click(within(deniedDrawer).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(deniedDrawer).not.toBeVisible());

        // Model the new query key: no error, no successful authorized read, and
        // the organization branch list still contains this operator's branch.
        mocks.queries.counterReceipt = { ...query(), refetch: mocks.receiptRefetch };
        fireEvent.click(screen.getByRole('button', { name: 'Start next bill' }));
        expect(screen.queryByRole('button', { name: /Last receipt/ })).not.toBeInTheDocument();
        fireEvent.keyDown(window, { key: 'r', altKey: true });
        expect(screen.queryByRole('dialog', { name: 'Receipt preview' })).not.toBeInTheDocument();
        fireEvent.keyDown(window, { key: 'F10' });
        expect(mocks.printReceipt).toHaveBeenCalledTimes(1);
        expect(mocks.mutations.tender).toHaveBeenCalledTimes(1);
        expect(mocks.mutations.addLine).not.toHaveBeenCalled();
        return;
      }
      if (scenario === 'typing') {
        fireEvent.keyDown(receiptDrawer, { key: '8' });
        await waitFor(() => expect(receiptDrawer).not.toBeVisible());
        expect(screen.getByLabelText('Scan or search')).toHaveValue('8');
      } else if (
        ['close', 'next-bill', 'branch', 'account', 'custom-shortcut'].includes(scenario)
      ) {
        fireEvent.click(within(receiptDrawer).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(receiptDrawer).not.toBeVisible());
      }
      if (scenario === 'next-bill')
        fireEvent.click(screen.getByRole('button', { name: 'Start next bill' }));
      if (scenario === 'branch') {
        fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch-b' } });
      }
      if (scenario === 'account') {
        mocks.session.data!.user!.id = 'account-b';
        view.rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      }
      if (scenario === 'branch' || scenario === 'account') {
        expect(screen.queryByRole('button', { name: /Last receipt/ })).not.toBeInTheDocument();
        expect(mocks.receiptProps).toHaveBeenLastCalledWith(
          expect.objectContaining({ receipt: null })
        );
        return;
      }
      if (scenario === 'typing' || scenario === 'next-bill') {
        fireEvent.keyDown(window, { key: 'F10' });
        expect(mocks.printReceipt).toHaveBeenCalledTimes(1);
      }
      if (['typing', 'next-bill', 'close', 'custom-shortcut'].includes(scenario)) {
        expect(screen.getByRole('button', { name: /Last receipt/ })).toBeVisible();
        if (scenario === 'custom-shortcut') {
          fireEvent.keyDown(window, { key: 'r', altKey: true });
          expect(receiptDrawer).not.toBeVisible();
          expect(screen.getByRole('button', { name: /Last receipt/ })).toHaveAttribute(
            'aria-keyshortcuts',
            'Alt+Shift+R'
          );
          fireEvent.keyDown(window, { key: 'R', altKey: true, shiftKey: true });
        } else fireEvent.keyDown(window, { key: 'r', altKey: true });
        await waitFor(() => expect(receiptDrawer).toBeVisible());
      }
      expect(mocks.receiptProps).toHaveBeenLastCalledWith(
        expect.objectContaining({
          receipt: completeCounterReceipt,
          state: 'ready',
          printing: false,
          ...(scenario === 'next-bill' || scenario === 'typing' ? { evidence: null } : {}),
        })
      );
      fireEvent.keyDown(receiptDrawer, { key: 'F10' });
      await waitFor(() =>
        expect(mocks.printReceipt).toHaveBeenLastCalledWith(
          completeCounterReceipt,
          'en',
          'THERMAL',
          true,
          expect.objectContaining({ cancel: browserPrint.cancel })
        )
      );
      expect(mocks.mutations.counterReceiptBrowserPrint).toHaveBeenLastCalledWith({
        branchId: 'branch-a',
        saleId: completeCounterReceipt.saleId,
        locale: 'en',
      });
      expect(mocks.mutations.tender).toHaveBeenCalledTimes(1);
      expect(mocks.mutations.addLine).not.toHaveBeenCalled();
    }
  );

  it.each(['FORBIDDEN', 'UNAUTHORIZED', 'INTERNAL_SERVER_ERROR'])(
    'handles a retained receipt on counterCart %s after starting the next bill',
    async (code) => {
      const receipt = issuedReceipt();
      mocks.queries.counterCart = query(
        cart({
          status: 'COMPLETED',
          receiptNumber: 42,
          totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 25000 },
        })
      );
      mocks.queries.counterReceipt = query(receipt);
      const view = render(
        <PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Preview receipt' }));
      const receiptDrawer = screen.getByRole('dialog', { name: 'Receipt preview' });
      fireEvent.keyDown(receiptDrawer, { key: 'F10' });
      await waitFor(() =>
        expect(mocks.printReceipt).toHaveBeenCalledExactlyOnceWith(
          receipt,
          'en',
          'THERMAL',
          false,
          expect.objectContaining({ cancel: browserPrint.cancel })
        )
      );
      fireEvent.click(within(receiptDrawer).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(receiptDrawer).not.toBeVisible());
      fireEvent.click(screen.getByRole('button', { name: 'Start next bill' }));

      // Scan into a new open bill. The receipt query is disabled here and the
      // branch list still includes this operator's branch after access changes.
      mocks.queries.counterReceipt = query();
      mocks.queries.counterCart = query();
      mocks.searchQuery.mockResolvedValue({ rows: [barcodeRow()], truncated: false });
      mocks.mutations.create!.mockImplementation(async () => {
        mocks.queries.counterCart = query(cart({ saleId: 'sale-b' }));
        return { id: 'sale-b' };
      });
      mocks.mutations.addLine!.mockResolvedValue({});
      const search = screen.getByLabelText('Scan or search');
      fireEvent.change(search, { target: { value: '123456' } });
      fireEvent.keyDown(search, { key: 'Enter' });
      await screen.findByText('1 × Paracetamol added.');
      expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ saleId: 'sale-b' })
      );
      expect(mocks.queryOptions).toHaveBeenCalledWith('counterReceipt', { enabled: false });
      fireEvent.click(screen.getByRole('button', { name: /Last receipt/ }));
      const savedDrawer = await screen.findByRole('dialog', { name: 'Receipt preview' });
      expect(mocks.receiptProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ receipt, state: 'ready' })
      );

      Object.assign(mocks.queries.counterCart!, {
        isSuccess: false,
        isError: true,
        error: refused(code),
      });
      view.rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      if (code === 'INTERNAL_SERVER_ERROR') {
        expect(screen.getByText(/^Last receipt/)).toBeInTheDocument();
        expect(mocks.receiptProps).toHaveBeenLastCalledWith(
          expect.objectContaining({ receipt, state: 'ready' })
        );
        fireEvent.keyDown(savedDrawer, { key: 'F10' });
        await waitFor(() =>
          expect(mocks.printReceipt).toHaveBeenLastCalledWith(
            receipt,
            'en',
            'THERMAL',
            true,
            expect.objectContaining({ cancel: browserPrint.cancel })
          )
        );
        expect(mocks.printReceipt).toHaveBeenCalledTimes(2);
        return;
      }

      expect(screen.queryByText(/^Last receipt/)).not.toBeInTheDocument();
      expect(mocks.receiptProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ receipt: null, settlement: null })
      );
      fireEvent.keyDown(savedDrawer, { key: 'F10' });
      expect(mocks.printReceipt).toHaveBeenCalledTimes(1);

      // Losing the denial on a later query lifecycle must not restore the snapshot.
      mocks.queries.counterCart = {
        ...query(),
        isSuccess: false,
        isLoading: true,
        isFetching: true,
      };
      view.rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      expect(mocks.receiptProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ receipt: null, settlement: null })
      );
      fireEvent.keyDown(savedDrawer, { key: 'F10' });
      expect(mocks.printReceipt).toHaveBeenCalledTimes(1);
      fireEvent.click(within(savedDrawer).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(savedDrawer).not.toBeVisible());
      expect(screen.queryByRole('button', { name: /Last receipt/ })).not.toBeInTheDocument();
      fireEvent.keyDown(window, { key: 'r', altKey: true });
      expect(screen.queryByRole('dialog', { name: 'Receipt preview' })).not.toBeInTheDocument();
      fireEvent.keyDown(window, { key: 'F10' });
      expect(mocks.printReceipt).toHaveBeenCalledTimes(1);
      expect(mocks.mutations.tender).not.toHaveBeenCalled();
    }
  );

  it.each(['Enter', ' '])(
    'keeps %s in the native tender control and sends once while pending',
    async (key) => {
      let resolve!: (value: ReturnType<typeof accepted>) => void;
      mocks.mutations.tender!.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          })
      );
      renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      const button = screen.getByRole('button', { name: 'Take payment', hidden: true });
      button.focus();
      expect(fireEvent.keyDown(button, { key })).toBe(true);
      fireEvent.keyUp(button, { key });
      fireEvent.click(button);
      fireEvent.click(button);
      expect(mocks.mutations.tender).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Taking payment…' })).toBeDisabled();
      expect(mocks.mutations.addLine).not.toHaveBeenCalled();
      await act(async () => resolve(accepted()));
    }
  );

  it('does not move rejection messages or values to a newly opened bill', async () => {
    mocks.mutations.tender!.mockRejectedValue(refused('BAD_REQUEST', 'DRAWER_NOT_OPEN'));
    mocks.mutations.transition!.mockResolvedValue({});
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    enterPayment();
    await screen.findByText(/Payment was not accepted/);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh bill' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Hold/, hidden: true })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: /^Hold/, hidden: true }));
    await waitFor(() => expect(screen.getByLabelText('Amount')).toHaveValue(''));
    expect(screen.queryByText(/Payment was not accepted/)).not.toBeInTheDocument();
    expect(screen.queryByText('Settled')).not.toBeInTheDocument();
  });

  it.each([
    ['without a prescription', null, false],
    ['with a prescription no pharmacist has signed for this line', 'rx-line-a', false],
  ])(
    'DEV-629: blocks payment for an Rx line the server holds %s, even when the patient has a signed one',
    (_label, prescriptionLineId, prescriptionSigned) => {
      const bill = cart();
      bill.lines[0]!.rx = true;
      bill.lines[0]!.prescriptionLineId = prescriptionLineId;
      bill.lines[0]!.prescriptionSigned = prescriptionSigned;
      mocks.queries.counterCart!.data = bill;
      mocks.queries.counterPatientPanel = query({
        prescriptions: [
          {
            validFrom: '2020-01-01T00:00:00.000Z',
            validUntil: '2999-12-31T00:00:00.000Z',
            lines: [
              {
                prescriptionLineId: 'rx-line-a',
                medicineId: bill.lines[0]!.medicineId,
                verified: true,
                remainingAuthorizedUnits: 10,
              },
            ],
          },
        ],
      });
      renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      expect(
        screen.getAllByText(/This bill carries an unresolved safety block/)[0]
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeDisabled();
      expect(mocks.mutations.tender).not.toHaveBeenCalled();
    }
  );

  it('preserves unresolved prescription safety blocks', () => {
    const bill = cart();
    bill.lines[0]!.rx = true;
    mocks.queries.counterCart!.data = bill;
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(
      screen.getAllByText(/This bill carries an unresolved safety block/)[0]
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeDisabled();
    expect(mocks.mutations.tender).not.toHaveBeenCalled();
  });

  it.each([
    ['Asia/Karachi', '2026-10-21T18:59:59.999Z', false],
    ['Asia/Karachi', '2026-10-21T19:00:00.000Z', true],
    ['Asia/Karachi', '2026-10-22T12:00:00.000Z', true],
    ['Asia/Karachi', '2026-10-22T19:00:00.000Z', false],
    ['America/Los_Angeles', '2026-10-23T06:59:59.999Z', true],
    ['America/Los_Angeles', '2026-10-23T07:00:00.000Z', false],
  ])('gates payment by prescription calendar dates in %s at %s', (timezone, at, current) => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(at) });
    vi.stubEnv('TZ', 'Pacific/Kiritimati');
    try {
      const bill = cart();
      bill.lines[0]!.rx = true;
      bill.lines[0]!.prescriptionLineId = 'rx-line-a';
      bill.lines[0]!.prescriptionSigned = true;
      mocks.queries.counterCart!.data = bill;
      mocks.queries.counterBranches = query({
        branches: [{ id: 'branch-a', name: 'Synthetic branch' }],
        timezone,
      });
      mocks.queries.counterPatientPanel = query({
        prescriptions: [
          {
            validFrom: '2026-10-22T00:00:00.000Z',
            validUntil: '2026-10-22T00:00:00.000Z',
            lines: [
              {
                prescriptionLineId: 'rx-line-a',
                medicineId: 'synthetic-medicine',
                verified: true,
                remainingAuthorizedUnits: 10,
              },
            ],
          },
        ],
      });

      renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);

      const payment = screen.getByRole('button', { name: 'Take payment', hidden: true });
      if (current) {
        expect(payment).toBeEnabled();
        expect(
          screen.queryByText(/This bill carries an unresolved safety block/)
        ).not.toBeInTheDocument();
      } else {
        expect(payment).toBeDisabled();
        expect(
          screen.getAllByText(/This bill carries an unresolved safety block/)[0]
        ).toBeInTheDocument();
      }
      expect(mocks.mutations.tender).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });
});

const scope = { organizationId: 'org-a', accountId: 'account-a', branchId: 'branch-a' };

function savedAttempt(): TenderAttempt {
  return {
    version: 1,
    scope,
    input: {
      branchId: 'branch-a',
      saleId: 'sale-a',
      deviceId: 'original-device',
      businessDate: new Date('2026-09-11T23:59:59.123Z'),
      type: 'CASH',
      amountMinor: 12550,
      cashReceivedMinor: 20000,
      idempotencyKey: 'original-operation-key',
    },
    draft: { amount: ' 00125.50 ', cashReceived: '200.00' },
  };
}

describe('PharmacyCounterConsole durable tender recovery', () => {
  it('recovers the saved cash change after settlement when Amount was blank and the receipt read fails', async () => {
    mocks.queries.counterCart!.data = cart({
      totals: { grossMinor: 5000, discountMinor: 0, netMinor: 5000, tenderedMinor: 0 },
    });
    mocks.mutations.tender!.mockRejectedValue(new Error('Acknowledgement lost'));
    const view = renderPayment(
      <PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />
    );
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '100.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await screen.findByText(/Payment outcome is unknown/);
    const originalInput = mocks.mutations.tender!.mock.calls[0]![0];
    expect(originalInput).toMatchObject({ amountMinor: 5000, cashReceivedMinor: 10000 });
    view.unmount();

    mocks.queries.counterCart!.data = cart({
      status: 'COMPLETED',
      receiptNumber: 42,
      totals: { grossMinor: 5000, discountMinor: 0, netMinor: 5000, tenderedMinor: 5000 },
    });
    mocks.receiptRefetch.mockRejectedValue(new Error('Receipt failed'));
    mocks.queries.counterReceipt!.isError = true;
    mocks.outcomeQuery.mockResolvedValue({
      status: 'ACCEPTED',
      replayUnsafe: true,
      result: accepted(0),
    });
    renderPayment(<PharmacyCounterConsole />);
    expect(screen.getByLabelText('Amount')).toHaveValue('');
    expect(screen.getByLabelText('Cash received')).toHaveValue('100.00');
    expect(screen.queryByRole('region', { name: 'Change due' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check payment outcome' }));
    await waitFor(() => expect(mocks.receiptRefetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByLabelText('Cash received')).toHaveValue(''));
    const change = screen.getByRole('region', { name: 'Change due' });
    expect(within(change).getByText('50.00')).toBeVisible();
    expect(within(change).queryByText('100.00')).not.toBeInTheDocument();
    expect(mocks.outcomeQuery).toHaveBeenCalledExactlyOnceWith(originalInput);
    expect(readTenderAttempt(scope)).toMatchObject({
      status: 'pending',
      attempt: { input: originalInput, draft: { amount: '', cashReceived: '100.00' } },
    });
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
    expect(mocks.mutations.tender).toHaveBeenCalledTimes(1);
  });

  it('persists and reads back before dispatching money', async () => {
    mocks.mutations.tender!.mockImplementation(async (input) => {
      expect(readTenderAttempt(scope)).toEqual({
        status: 'pending',
        attempt: {
          version: 1,
          scope,
          input,
          draft: { amount: '125.50', cashReceived: '200.00' },
        },
      });
      return accepted();
    });
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    enterPayment();
    await screen.findByText('Payment recorded.');
    expect(mocks.mutations.tender).toHaveBeenCalledTimes(1);
    expect(readTenderAttempt(scope)).toEqual({ status: 'empty' });
  });

  it.each(['read', 'write', 'silent-write', 'device'] as const)(
    'never dispatches when storage %s fails',
    async (kind) => {
      if (kind === 'read')
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
          throw new Error('Denied');
        });
      renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      if (kind !== 'read') {
        if (kind !== 'device')
          window.localStorage.setItem('devfathom.pharmacy.counter.device', 'device-a');
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
          if (kind !== 'silent-write') throw new Error('Quota');
        });
        enterPayment();
      }
      await screen.findByText(/Payment recovery storage is unavailable/);
      expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeDisabled();
      expect(mocks.mutations.tender).not.toHaveBeenCalled();
      if (kind !== 'read') expect(screen.getByLabelText('Amount')).toHaveValue('125.50');
    }
  );

  it('restores a timed-out attempt after remount with the original date, cash, device and key', async () => {
    mocks.mutations.tender!.mockRejectedValue(new Error('Timeout'));
    window.localStorage.setItem('devfathom.pharmacy.counter.device', 'original-device');
    const view = render(
      <PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />
    );
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: ' 00125.50 ' } });
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '200.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment', hidden: true }));
    await screen.findByText(/Payment outcome is unknown/);
    const originalInput = mocks.mutations.tender!.mock.calls[0]![0];
    view.unmount();
    window.localStorage.setItem('devfathom.pharmacy.counter.device', 'replacement-device');
    renderPayment(<PharmacyCounterConsole />);
    expect(screen.getByLabelText('Amount')).toHaveValue(' 00125.50 ');
    expect(screen.getByLabelText('Cash received')).toHaveValue('200.00');
    expect(screen.getByRole('button', { name: /^Hold/, hidden: true })).toBeDisabled();
    expect(mocks.outcomeQuery).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check payment outcome' }));
    await screen.findByText(/Payment is still unconfirmed/);
    expect(mocks.outcomeQuery).toHaveBeenCalledExactlyOnceWith(originalInput);
    expect(mocks.mutations.tender).toHaveBeenCalledTimes(1);
  });

  it('restores a persisted full timestamp without regenerating a date or an omitted optional field', async () => {
    const attempt = savedAttempt();
    delete attempt.input.cashReceivedMinor;
    attempt.draft.cashReceived = '';
    persistTenderAttempt(attempt);
    renderPayment(<PharmacyCounterConsole initialSaleId="another-sale" />);
    fireEvent.click(screen.getByRole('button', { name: 'Check payment outcome' }));
    await screen.findByText(/Payment is still unconfirmed/);
    expect(mocks.outcomeQuery).toHaveBeenCalledExactlyOnceWith(attempt.input);
    expect(Object.hasOwn(mocks.outcomeQuery.mock.calls[0]![0], 'cashReceivedMinor')).toBe(false);
    expect(mocks.mutations.tender).not.toHaveBeenCalled();
  });

  it.each(['NOT_FOUND', 'UNKNOWN', 'read-error', 'denied', 'malformed-accepted'])(
    'keeps %s locked across repeated read-only checks and another remount',
    async (kind) => {
      const attempt = savedAttempt();
      persistTenderAttempt(attempt);
      if (kind === 'read-error' || kind === 'denied')
        mocks.outcomeQuery.mockRejectedValue(
          refused(kind === 'denied' ? 'FORBIDDEN' : 'INTERNAL_SERVER_ERROR')
        );
      else if (kind === 'malformed-accepted')
        mocks.outcomeQuery.mockResolvedValue({
          status: 'ACCEPTED',
          replayUnsafe: true,
          result: { settled: true },
        });
      else mocks.outcomeQuery.mockResolvedValue({ status: kind, replayUnsafe: true });
      const view = renderPayment(<PharmacyCounterConsole />);
      for (let index = 0; index < 2; index++) {
        fireEvent.click(screen.getByRole('button', { name: 'Check payment outcome' }));
        await waitFor(() =>
          expect(screen.getByRole('button', { name: 'Check payment outcome' })).toBeEnabled()
        );
      }
      expect(mocks.outcomeQuery).toHaveBeenCalledTimes(2);
      expect(readTenderAttempt(scope)).toEqual({ status: 'pending', attempt });
      expect(screen.getByLabelText('Amount')).toHaveValue(attempt.draft.amount);
      expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeDisabled();
      view.unmount();
      renderPayment(<PharmacyCounterConsole />);
      expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeDisabled();
      expect(mocks.mutations.tender).not.toHaveBeenCalled();
    }
  );

  it.each([0, 12450])(
    'does not use accepted original balance %i as current bill balance',
    async (remainingMinor) => {
      persistTenderAttempt(savedAttempt());
      mocks.outcomeQuery.mockResolvedValue({
        status: 'ACCEPTED',
        replayUnsafe: true,
        result: accepted(remainingMinor),
      });
      mocks.queries.counterCart!.data = cart({
        totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 20000 },
      });
      renderPayment(<PharmacyCounterConsole />);
      fireEvent.click(screen.getByRole('button', { name: 'Check payment outcome' }));
      await screen.findByText('Payment recorded.');
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeEnabled()
      );
      expect(screen.getByLabelText('Amount')).toHaveValue('');
      expect(screen.getByText('50.00', { selector: 'span' })).toBeInTheDocument();
      expect(screen.queryByText('Settled')).not.toBeInTheDocument();
      expect(readTenderAttempt(scope)).toEqual({ status: 'empty' });
      expect(mocks.refetch).toHaveBeenCalledTimes(1);
      expect(mocks.mutations.tender).not.toHaveBeenCalled();
    }
  );

  it.each([0, 12450])(
    'retains accepted %i and its envelope if the fresh bill read fails',
    async (remainingMinor) => {
      const attempt = savedAttempt();
      persistTenderAttempt(attempt);
      mocks.outcomeQuery.mockResolvedValue({
        status: 'ACCEPTED',
        replayUnsafe: true,
        result: accepted(remainingMinor),
      });
      mocks.refetch.mockRejectedValue(new Error('Read failed'));
      const view = renderPayment(<PharmacyCounterConsole />);
      fireEvent.click(screen.getByRole('button', { name: 'Check payment outcome' }));
      await screen.findByText(/Payment recorded, but the bill refresh is incomplete/);
      await waitFor(() => expect(screen.getByLabelText('Amount')).toHaveValue(''));
      expect(screen.queryByText('Settled')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeDisabled();
      expect(readTenderAttempt(scope)).toEqual({ status: 'pending', attempt });
      view.unmount();
      renderPayment(<PharmacyCounterConsole />);
      expect(screen.getByLabelText('Amount')).toHaveValue(attempt.draft.amount);
      expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeDisabled();
      expect(mocks.mutations.tender).not.toHaveBeenCalled();
    }
  );

  it.each(['success', 'failed-receipt', 'invalid-receipt', 'wrong-receipt', 'failed-clear'])(
    'requires current completed cart, receipt and storage resolution: %s',
    async (kind) => {
      const attempt = savedAttempt();
      persistTenderAttempt(attempt);
      mocks.outcomeQuery.mockResolvedValue({
        status: 'ACCEPTED',
        replayUnsafe: true,
        result: accepted(12450),
      });
      mocks.queries.counterCart!.data = cart({
        status: 'COMPLETED',
        receiptNumber: 42,
        totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 25000 },
      });
      if (kind === 'failed-receipt')
        mocks.receiptRefetch.mockRejectedValue(new Error('Receipt failed'));
      if (kind === 'invalid-receipt')
        mocks.receiptRefetch.mockResolvedValue({
          isSuccess: true,
          data: { saleId: 'sale-a', receiptNumber: 42 },
        });
      if (kind === 'wrong-receipt')
        mocks.receiptRefetch.mockResolvedValue({
          isSuccess: true,
          data: { saleId: 'other-sale', receiptNumber: 42 },
        });
      if (kind === 'failed-clear')
        vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
          throw new Error('Denied');
        });
      renderPayment(<PharmacyCounterConsole />);
      fireEvent.click(screen.getByRole('button', { name: 'Check payment outcome' }));
      await waitFor(() => expect(mocks.receiptRefetch).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByLabelText('Amount')).toHaveValue(''));
      if (kind === 'success') {
        expect(screen.getByText('Settled')).toBeInTheDocument();
        expect(await screen.findByRole('dialog', { name: 'Receipt preview' })).toBeVisible();
        expect(mocks.receiptProps).toHaveBeenLastCalledWith(
          expect.objectContaining({
            state: 'ready',
            settlement: expect.objectContaining({ status: 'confirmed', autoPrint: false }),
          })
        );
        expect(mocks.printReceipt).not.toHaveBeenCalled();
        expect(readTenderAttempt(scope)).toEqual({ status: 'empty' });
      } else {
        expect(screen.queryByText('Settled')).not.toBeInTheDocument();
        expect(readTenderAttempt(scope)).toEqual({ status: 'pending', attempt });
      }
      expect(mocks.mutations.tender).not.toHaveBeenCalled();
    }
  );

  it.each(['malformed', 'foreign'])(
    'locks %s data under this scope without displaying it',
    (kind) => {
      const raw =
        kind === 'malformed'
          ? '{'
          : JSON.stringify({ ...savedAttempt(), scope: { ...scope, accountId: 'other-account' } });
      window.localStorage.setItem(tenderAttemptStorageKey(scope), raw);
      renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" />);
      expect(screen.getByLabelText('Amount')).toHaveValue('');
      expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeDisabled();
      expect(
        screen.queryByRole('button', { name: 'Check payment outcome' })
      ).not.toBeInTheDocument();
      expect(window.localStorage.getItem(tenderAttemptStorageKey(scope))).toBe(raw);
    }
  );

  it.each([
    'account',
    'organization',
    'revoked',
    'inactive',
    'loading',
    'module',
    'branch',
    'identity-mismatch',
  ])('does not expose or read recovery after %s access changes', (kind) => {
    persistTenderAttempt(savedAttempt());
    const view = renderPayment(<PharmacyCounterConsole />);
    expect(screen.getByLabelText('Amount')).toHaveValue(' 00125.50 ');
    const get = vi.spyOn(Storage.prototype, 'getItem');
    if (kind === 'account') mocks.session.data.user.id = 'account-b';
    if (kind === 'organization') {
      mocks.session.data.user.organizationId = 'org-b';
      mocks.entitlements.organizationId = 'org-b';
    }
    if (kind === 'revoked') mocks.session.data.user.sessionRevoked = true;
    if (kind === 'inactive') mocks.session.data.user.status = 'INACTIVE';
    if (kind === 'loading') mocks.session.status = 'loading';
    if (kind === 'module') mocks.entitlements.enabledModules = [];
    if (kind === 'branch') mocks.queries.counterBranches!.data = { branches: [] };
    if (kind === 'identity-mismatch') mocks.entitlements.organizationId = 'org-b';
    view.rerender(<PharmacyCounterConsole />);
    expect(screen.queryByDisplayValue(' 00125.50 ')).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalledWith(tenderAttemptStorageKey(scope));
    expect(mocks.mutations.tender).not.toHaveBeenCalled();
  });

  it('guards duplicate checks while pending and preserves keyboard focus after an unconfirmed read', async () => {
    persistTenderAttempt(savedAttempt());
    let resolve!: (value: { status: 'UNKNOWN'; replayUnsafe: true }) => void;
    mocks.outcomeQuery.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    renderPayment(<PharmacyCounterConsole />);
    const button = screen.getByRole('button', { name: 'Check payment outcome' });
    button.focus();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocks.outcomeQuery).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Checking payment outcome…' })).toBeDisabled();
    await act(async () => resolve({ status: 'UNKNOWN', replayUnsafe: true }));
    expect(button).toHaveFocus();
    expect(mocks.mutations.tender).not.toHaveBeenCalled();
  });

  it('does not unlock an uncertain mounted attempt if browser storage is externally deleted', () => {
    persistTenderAttempt(savedAttempt());
    renderPayment(<PharmacyCounterConsole />);
    window.localStorage.clear();
    fireEvent(window, new StorageEvent('storage', { key: null }));
    expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeDisabled();
    expect(screen.getByLabelText('Amount')).toHaveValue(' 00125.50 ');
  });

  it('finds the original nondefault authorized branch on a plain reload', async () => {
    const attempt = savedAttempt();
    attempt.scope = { ...scope, branchId: 'branch-b' };
    attempt.input.branchId = 'branch-b';
    persistTenderAttempt(attempt);
    mocks.queries.counterBranches!.data = {
      branches: [
        { id: 'branch-a', name: 'First branch' },
        { id: 'branch-b', name: 'Original branch' },
      ],
    };
    renderPayment(<PharmacyCounterConsole />);
    expect(screen.getByLabelText('Amount')).toHaveValue(attempt.draft.amount);
    fireEvent.click(screen.getByRole('button', { name: 'Check payment outcome' }));
    await screen.findByText(/Payment is still unconfirmed/);
    expect(mocks.outcomeQuery).toHaveBeenCalledExactlyOnceWith(attempt.input);
    expect(mocks.mutations.tender).not.toHaveBeenCalled();
  });

  it('never reads a saved record from a branch absent from the authorized branch list', () => {
    const attempt = savedAttempt();
    attempt.scope = { ...scope, branchId: 'branch-b' };
    attempt.input.branchId = 'branch-b';
    persistTenderAttempt(attempt);
    const get = vi.spyOn(Storage.prototype, 'getItem');
    renderPayment(<PharmacyCounterConsole />);
    expect(get).not.toHaveBeenCalledWith(tenderAttemptStorageKey(attempt.scope));
    expect(screen.getByLabelText('Amount')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Check payment outcome' })).not.toBeInTheDocument();
  });
});

describe('PharmacyCounterConsole Khata wiring', () => {
  it('persists and dispatches the selected family with no password fields', async () => {
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    chooseTender('KHATA');
    await screen.findByText(/Ledger balance/);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '125.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment', hidden: true }));
    await waitFor(() => expect(mocks.mutations.tender).toHaveBeenCalled());
    expect(mocks.mutations.tender).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'KHATA',
        familyAccountId: 'family-a',
        ownerOverride: false,
        saleId: 'sale-a',
        branchId: 'branch-a',
      })
    );
    expect(mocks.mutations.tender!.mock.calls[0]![0]).not.toHaveProperty('password');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeEnabled()
    );
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '125.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment', hidden: true }));
    await waitFor(() => expect(mocks.mutations.tender).toHaveBeenCalledTimes(2));
    expect(mocks.mutations.tender!.mock.calls[1]![0].idempotencyKey).not.toBe(
      mocks.mutations.tender!.mock.calls[0]![0].idempotencyKey
    );
  });
  it('prints only the statement allowlist as inert text', async () => {
    mocks.khataStatement.mockResolvedValue({
      account: {
        displayName: '<script>family</script>',
        balanceMinor: 100,
        creditLimitMinor: 1000,
      },
      generatedAt: new Date('2026-10-02'),
      truncated: false,
      entries: [
        {
          occurredAt: new Date('2026-10-01'),
          kind: 'CHARGE',
          amountMinor: 100,
          note: 'private note',
        },
      ],
    });
    const windows = installFakePrintWindows();
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    chooseTender('KHATA');
    await screen.findByText(/Ledger balance/);
    fireEvent.click(screen.getByRole('button', { name: 'Print Khata statement' }));
    await waitFor(() => expect(windows.last().printRequests()).toBe(1));
    // DEV-973: the isolated window prints itself; the counter never calls print() on it.
    expect(windows.last().proxy.print).not.toHaveBeenCalled();
    expect(windows.last().document()!.title).toBe('Family Khata statement');
    const body = windows.last().document()!.body;
    expect(body.textContent).toContain('<script>family</script>');
    expect(body.querySelector('script')).toBeNull();
    expect(body.textContent).not.toContain('private note');
    expect(mocks.khataStatement).toHaveBeenCalledWith({
      branchId: 'branch-a',
      saleId: 'sale-a',
      familyAccountId: 'family-a',
    });
  });
});

it.each([404, 200])(
  'reauthenticates through the existing password transport (%s)',
  async (status) => {
    Object.assign(mocks.session.data.user, { email: 'owner@example.test' });
    mocks.khataAccounts.mockResolvedValue([
      { id: 'family-a', displayName: 'Family A', balanceMinor: 0, creditLimitMinor: 0 },
    ]);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ organizations: [{ id: 'org-a', ssoEnforced: false }] }), {
        status,
      })
    );
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    chooseTender('KHATA');
    await screen.findByText(/Ledger balance/);
    fireEvent.click(screen.getByLabelText('Owner or manager: authorize limit increase'));
    fireEvent.click(screen.getByLabelText('I am the only owner or manager: re-enter my password'));
    fireEvent.change(screen.getByLabelText('Reason for exceeding the limit'), {
      target: { value: 'Paying on Friday' },
    });
    fireEvent.change(screen.getByLabelText('Your password (current account)'), {
      target: { value: 'test-only-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment', hidden: true }));
    await waitFor(() => expect(mocks.mutations.tender).toHaveBeenCalledOnce());
    expect(mocks.mutations.tender).toHaveBeenCalledWith(
      expect.objectContaining({ ownerOverride: true, overrideReason: 'Paying on Friday' })
    );
    expect(fetch).toHaveBeenCalledWith(
      '/api/login',
      expect.objectContaining({ method: 'POST', credentials: 'include' })
    );
    expect(mocks.signIn).toHaveBeenCalledWith(
      status === 404 ? 'credentials' : 'login-intent',
      expect.objectContaining(
        status === 404
          ? { email: 'owner@example.test', password: 'test-only-password', redirect: false }
          : { organizationId: 'org-a', redirect: false }
      )
    );
  }
);

it('DEV-290: sends a manager PIN approval with the tender but never stores it', async () => {
  mocks.khataAccounts.mockResolvedValue([
    { id: 'family-a', displayName: 'Family A', balanceMinor: 0, creditLimitMinor: 0 },
  ]);
  mocks.khataApprovers.mockResolvedValue([
    { id: 'staff-manager', name: 'Manager Sana', self: false },
  ]);
  const setItem = vi.spyOn(Storage.prototype, 'setItem');
  renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
  chooseTender('KHATA');
  await screen.findByText(/Ledger balance/);
  fireEvent.click(screen.getByLabelText('Owner or manager: authorize limit increase'));
  await screen.findByRole('option', { name: 'Manager Sana' });
  expect(mocks.khataApprovers).toHaveBeenCalledWith({ branchId: 'branch-a' });
  fireEvent.change(screen.getByLabelText('Reason for exceeding the limit'), {
    target: { value: 'Paying on Friday' },
  });
  fireEvent.change(screen.getByLabelText('Approving manager or owner'), {
    target: { value: 'staff-manager' },
  });
  fireEvent.change(screen.getByLabelText('Approver PIN'), { target: { value: '975310' } });
  fireEvent.click(screen.getByRole('button', { name: 'Take payment', hidden: true }));
  await waitFor(() => expect(mocks.mutations.tender).toHaveBeenCalledOnce());
  expect(mocks.mutations.tender).toHaveBeenCalledWith(
    expect.objectContaining({
      ownerOverride: true,
      overrideReason: 'Paying on Friday',
      overLimitApproval: { staffProfileId: 'staff-manager', pin: '975310' },
    })
  );
  // The recovery attempt was persisted before the write, without the PIN.
  const stored = setItem.mock.calls.filter(([key]) => key.includes('counter.attempt'));
  expect(stored.length).toBeGreaterThan(0);
  for (const [, value] of stored) {
    expect(value).not.toContain('975310');
    expect(value).not.toContain('overLimitApproval');
  }
  setItem.mockRestore();
});

describe('PharmacyCounterConsole cash drawer (POS-07)', () => {
  beforeEach(() => {
    mocks.queries.drawerStatus = query({ openDrawer: null });
  });

  it('DEV-714: a closed drawer flags only Cash and still takes a bank transfer', async () => {
    const message = COUNTER_CASH_DRAWER_CLOSED_MESSAGE;
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(tenderButton('CASH')).toHaveAccessibleDescription(message);
    expect(tenderButton('BANK_TRANSFER')).not.toHaveAccessibleDescription();
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '125.50' } });
    const take = screen.getByRole('button', { name: 'Take payment', hidden: true });
    expect(take).toBeDisabled();
    enterPayment('BANK_TRANSFER');
    await waitFor(() =>
      expect(mocks.mutations.tender).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ type: 'BANK_TRANSFER', amountMinor: 12550 })
      )
    );
  });

  it('DEV-931: F9 opens payment and focuses it before the key event ends', async () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() => screen.getByLabelText('Opening cash').blur());
    // A real keydown on the window listener, outside act(): React would otherwise open the
    // dialog only after the event, and the cashier's next key would land outside it.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F9', bubbles: true }));
    const payment = screen.getByRole('dialog', { name: /^Take payment/ });
    expect(payment).toContainElement(document.activeElement as HTMLElement);
    // A payment method the cashier moves to straight away keeps focus: the dialog's queued
    // initial focus does not take it back.
    const card = within(payment)
      .getByRole('group', { name: 'Payment method' })
      .querySelectorAll('button')[1]!;
    card.focus();
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(card).toHaveFocus();
  });

  it('DEV-714: re-reads the drawer status each time payment opens', () => {
    const drawerStatus = query({ openDrawer: null });
    mocks.queries.drawerStatus = drawerStatus;
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(drawerStatus.refetch).not.toHaveBeenCalled();
    // DEV-725: with the drawer closed the opening step replaces the scan field.
    // Its form keeps its own keys; F9 also remains available outside the field.
    expect(screen.getByLabelText('Opening cash')).toHaveFocus();
    screen.getByLabelText('Opening cash').blur();
    fireEvent.keyDown(window, { key: 'F9' });
    expect(drawerStatus.refetch).toHaveBeenCalledTimes(1);
  });

  it('DEV-714: an unknown drawer status does not flag Cash', () => {
    mocks.queries.drawerStatus = { ...query(), isSuccess: false, isLoading: true };
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(tenderButton('CASH')).not.toHaveAccessibleDescription();
  });

  const openDrawer = {
    id: 'drawer-open',
    businessDate: new Date('2026-10-20T00:00:00.000Z'),
    openedAt: new Date('2026-10-20T04:05:00.000Z'),
    openingFloatMinor: 0,
  };

  it('never offers "Open drawer" while this device already has one open', () => {
    mocks.queries.drawerStatus = query({ openDrawer });
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    expect(screen.queryByRole('button', { name: 'Open drawer' })).not.toBeInTheDocument();
    expect(screen.getByText('Drawer open')).toBeInTheDocument();
  });

  it('DEV-631: says the business day is closed before a bill is built, with no scan or drawer step', () => {
    const drawerStatus = query({ dayClosed: true });
    mocks.queries.tradingDayStatus = drawerStatus;
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    expect(screen.getByRole('status', { name: 'Business day closed' })).toHaveTextContent(
      /New bills, payments and drawer changes are blocked\. The owner or a manager can reopen today for trading on Day close/
    );
    expect(screen.getByText('Day closed')).toBeInTheDocument();
    expect(screen.queryByLabelText('Scan or search')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open drawer' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(drawerStatus.refetch).toHaveBeenCalledTimes(1);
  });

  it('DEV-631: an open business day keeps the scan field', () => {
    openTheDrawer();
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    expect(screen.queryByRole('status', { name: 'Business day closed' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Scan or search')).toBeInTheDocument();
  });

  it('withholds the button until the drawer status is known', () => {
    mocks.queries.drawerStatus = { ...query(), isSuccess: false, isLoading: true };
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    expect(screen.getByRole('button', { name: 'Open drawer' })).toBeDisabled();
    // DEV-725: an unknown drawer never lets a bill be started either.
    expect(screen.queryByLabelText('Scan or search')).not.toBeInTheDocument();
  });

  it('opens the drawer for this device once, then refreshes the status', async () => {
    closeDrawer();
    mocks.mutations.openDrawer!.mockResolvedValue(openDrawer);
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    const button = screen.getByRole('button', { name: 'Open drawer' });
    expect(button).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Opening cash'), { target: { value: '0' } });
    fireEvent.click(button);
    await screen.findByText('Cash drawer opened for this counter.');
    const deviceId = window.localStorage.getItem('devfathom.pharmacy.counter.device');
    expect(deviceId).toMatch(/^counter-/);
    expect(mocks.mutations.openDrawer).toHaveBeenCalledTimes(1);
    expect(mocks.mutations.openDrawer).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 'branch-a', deviceId, openingFloatMinor: 0 })
    );
    await waitFor(() => expect(mocks.drawerStatusInvalidate).toHaveBeenCalled());
  });

  it('makes opening the drawer the first step of the shift, before any bill (DEV-725)', () => {
    closeDrawer();
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    expect(
      screen.getByRole('form', { name: 'Open the cash drawer to start the shift' })
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Bill status')).toHaveTextContent('Drawer closed');
    // No scan field, so no bill can be built that payment would then refuse.
    expect(screen.queryByLabelText('Scan or search')).not.toBeInTheDocument();
    expect(mocks.mutations.create).not.toHaveBeenCalled();
  });

  it('records the opening cash the manager counted, in minor units (DEV-725)', async () => {
    closeDrawer();
    mocks.queries.refundAccess = query({ authorized: true });
    mocks.mutations.openDrawer!.mockResolvedValue(openDrawer);
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    fireEvent.change(screen.getByLabelText('Opening cash'), { target: { value: '5000.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    await screen.findByText('Cash drawer opened for this counter.');
    expect(mocks.mutations.openDrawer).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 'branch-a', openingFloatMinor: 500050 })
    );
  });

  it('shows where the drawer opens and fills a quick amount without opening it (DEV-508)', async () => {
    closeDrawer();
    mocks.queries.refundAccess = query({ authorized: true });
    mocks.mutations.openDrawer!.mockResolvedValue(openDrawer);
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    const details = screen.getByLabelText('Drawer details');
    expect(within(details).getByText('Synthetic branch')).toBeInTheDocument();
    expect(details).not.toHaveTextContent('MT1');
    expect(within(details).getByText(/^Counter [A-Z0-9]{4}$/)).toBeInTheDocument();
    expect(within(details).getByText('Business day')).toBeInTheDocument();

    const quick = screen.getByRole('group', { name: 'Quick amounts' });
    fireEvent.click(within(quick).getByRole('button', { name: 'PKR 2,000' }));
    expect(screen.getByLabelText('Opening cash')).toHaveValue('2000');
    expect(within(quick).getByRole('button', { name: 'PKR 2,000' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    // Choosing an amount is not the confirmation: nothing is written yet.
    expect(mocks.mutations.openDrawer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    await screen.findByText('Cash drawer opened for this counter.');
    expect(mocks.mutations.openDrawer).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 'branch-a', openingFloatMinor: 200000 })
    );
  });

  it.each(['', 'abc', '-5', '1.234'])(
    'refuses to open the drawer without a valid opening cash amount: %j (DEV-725)',
    (value) => {
      closeDrawer();
      mocks.queries.refundAccess = query({ authorized: true });
      render(<PharmacyCounterConsole initialBranchId="branch-a" />);
      const field = screen.getByLabelText('Opening cash');
      fireEvent.change(field, { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
      expect(screen.getByRole('alert')).toHaveTextContent('Enter the opening cash');
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(mocks.mutations.openDrawer).not.toHaveBeenCalled();
    }
  );

  it.each(['cashier', 'failed'])(
    'DEV-873/DEV-933: %s access never invites an opening float and needs a typed count',
    async (access) => {
      closeDrawer();
      mocks.queries.refundAccess =
        access === 'cashier'
          ? query({ authorized: false })
          : { ...query({ authorized: true }), isError: true };
      mocks.mutations.openDrawer!.mockResolvedValue(openDrawer);
      render(<PharmacyCounterConsole initialBranchId="branch-a" />);
      const field = screen.getByLabelText('Opening cash');
      expect(field).toHaveValue('');
      expect(field).not.toHaveAttribute('readonly');
      expect(screen.queryByRole('group', { name: 'Quick amounts' })).not.toBeInTheDocument();
      expect(screen.queryByText(/Count the cash in the drawer/)).not.toBeInTheDocument();
      expect(
        screen.getByText(/Ask a manager or owner to declare any opening float/)
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
      expect(screen.getByRole('alert')).toHaveTextContent('Enter the opening cash');
      expect(mocks.mutations.openDrawer).not.toHaveBeenCalled();
      fireEvent.change(field, { target: { value: '0' } });
      fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
      await screen.findByText('Cash drawer opened for this counter.');
      expect(mocks.mutations.openDrawer).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ openingFloatMinor: 0 })
      );
    }
  );

  it('DEV-933: a slow access check keeps the step waiting with no prefilled count', () => {
    closeDrawer();
    mocks.queries.refundAccess = { ...query(), isSuccess: false, isLoading: true };
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    const field = screen.getByLabelText('Opening cash');
    expect(field).toHaveValue('');
    expect(field).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open drawer' })).toBeDisabled();
    expect(screen.getByText('Checking your access…')).toBeInTheDocument();
    expect(mocks.mutations.openDrawer).not.toHaveBeenCalled();
  });

  it('DEV-873: a server float refusal does not claim the cashier cannot take payments', async () => {
    closeDrawer();
    // Permission may have changed since this presentation-only query succeeded.
    mocks.queries.refundAccess = query({ authorized: true });
    mocks.mutations.openDrawer!.mockRejectedValue(
      Object.assign(new Error('You do not have permission for this action.'), {
        data: { code: 'FORBIDDEN' },
      })
    );
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    fireEvent.change(screen.getByLabelText('Opening cash'), { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only a manager or owner can open with a float. Open with 0 if the drawer is empty, or ask a manager.'
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('does not take payments');
    expect(screen.getByLabelText('Opening cash')).toHaveValue('5000');
    await waitFor(() => expect(mocks.drawerStatusInvalidate).toHaveBeenCalled());
  });

  it('DEV-933: a cashier who types a float above 0 is told in plain words and keeps the value', async () => {
    closeDrawer();
    mocks.queries.refundAccess = query({ authorized: false });
    mocks.mutations.openDrawer!.mockRejectedValue(
      Object.assign(new Error('You do not have permission for this action.'), {
        data: { code: 'FORBIDDEN' },
      })
    );
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    const field = screen.getByLabelText('Opening cash');
    fireEvent.change(field, { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only a manager or owner can open with a float. Open with 0 if the drawer is empty, or ask a manager.'
    );
    expect(screen.getByLabelText('Opening cash')).toHaveValue('5000');
    expect(screen.getByLabelText('Opening cash')).toBeEnabled();
  });

  it('starts a bill only on this device’s open drawer, naming the device (DEV-725)', async () => {
    openTheDrawer();
    mocks.searchQuery.mockResolvedValue({ rows: [barcodeRow()], truncated: false });
    mocks.mutations.create!.mockResolvedValue({ id: 'sale-new' });
    mocks.mutations.addLine!.mockResolvedValue({});
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    expect(
      screen.queryByRole('form', { name: 'Open the cash drawer to start the shift' })
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Bill status')).toHaveTextContent('Drawer open');
    const search = screen.getByLabelText('Scan or search');
    fireEvent.change(search, { target: { value: '123456' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(mocks.mutations.create).toHaveBeenCalledTimes(1));
    const deviceId = window.localStorage.getItem('devfathom.pharmacy.counter.device');
    expect(deviceId).toMatch(/^counter-/);
    expect(mocks.mutations.create).toHaveBeenCalledWith({
      branchId: 'branch-a',
      quotation: false,
      deviceId,
    });
  });

  it('links a scanned loyalty card to the bill instead of searching for it (DEV-748)', async () => {
    openTheDrawer();
    mocks.mutations.create!.mockResolvedValue({ id: 'sale-new' });
    mocks.mutations.scanLoyaltyCard!.mockResolvedValue({
      id: 'customer-a',
      displayName: 'Ayesha',
    });
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    // A scanner with caps lock off types the code in lower case.
    fireEvent.change(search, { target: { value: 'dflcabcdefghijklmnopqrstuvwxyz' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(mocks.mutations.scanLoyaltyCard).toHaveBeenCalledTimes(1));
    expect(mocks.mutations.scanLoyaltyCard).toHaveBeenCalledWith({
      branchId: 'branch-a',
      saleId: 'sale-new',
      cardToken: 'DFLCABCDEFGHIJKLMNOPQRSTUVWXYZ',
    });
    expect(
      await screen.findByText('Loyalty card: Ayesha linked to this bill.')
    ).toBeInTheDocument();
    expect(search).toHaveValue('');
    // The card code is never sent to the medicine search.
    expect(mocks.searchQuery).not.toHaveBeenCalled();
    expect(
      mocks.queryInputs.mock.calls.filter(([, input]) =>
        JSON.stringify(input ?? '').includes('DFLC')
      )
    ).toEqual([]);
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
  });

  it.each([
    // 16:30 UTC on the 21st is already the 22nd in Tokyo, still the 21st on the device.
    ['the workspace zone', 'Asia/Tokyo', '2026-10-21T16:30:00.000Z', '2026-10-22'],
    // A stored zone Intl refuses reads as UTC: 22:30 UTC is the 21st there, the 22nd on the device.
    ['UTC for a stored zone Intl refuses', 'PKT', '2026-10-21T22:30:00.000Z', '2026-10-21'],
  ])(
    'stamps the drawer with today in %s, not the device’s day, as the day close reads it',
    async (_label, timezone, now, day) => {
      // The device is pinned to Karachi whatever zone the test host runs in, so
      // the device's own day differs from the workspace's day on every host:
      // a device-local stamp cannot pass. Node applies a runtime TZ change.
      vi.stubEnv('TZ', 'Asia/Karachi');
      const device = new Intl.DateTimeFormat('en-CA', { day: '2-digit' }).format(new Date(now));
      expect(device).not.toBe(day.slice(8));
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(now) });
      mocks.queries.counterBranches = query({
        branches: [{ id: 'branch-a', name: 'Synthetic branch', code: 'MT1' }],
        timezone,
      });
      closeDrawer();
      mocks.mutations.openDrawer!.mockResolvedValue(openDrawer);
      try {
        render(<PharmacyCounterConsole initialBranchId="branch-a" />);
        fireEvent.change(screen.getByLabelText('Opening cash'), { target: { value: '0' } });
        fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
        await screen.findByText('Cash drawer opened for this counter.');
        expect(mocks.mutations.openDrawer).toHaveBeenCalledWith(
          expect.objectContaining({ businessDate: new Date(`${day}T00:00:00.000Z`) })
        );
      } finally {
        vi.useRealTimers();
        vi.unstubAllEnvs();
      }
    }
  );

  /** #1254: a cash payment refused because the drawer was closed elsewhere. */
  async function refuseCashForClosedDrawer() {
    openTheDrawer();
    mocks.mutations.tender!.mockRejectedValueOnce(refused('BAD_REQUEST', 'DRAWER_NOT_OPEN'));
    const view = renderPayment(
      <PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />
    );
    enterPayment();
    await screen.findByText(/Payment was not accepted/);
    expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeDisabled();
    await waitFor(() => expect(mocks.drawerStatusInvalidate).toHaveBeenCalled());
    // The re-read reports the drawer closed.
    closeDrawer();
    view.rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const payment = screen.getByRole('dialog', { name: /^Take payment/ });
    fireEvent.click(within(payment).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(payment).not.toBeVisible());
  }

  it('#1254: a refused cash payment keeps "Open drawer" usable and re-reads the drawer', async () => {
    await refuseCashForClosedDrawer();
    // The bill itself still needs a re-read before it changes or takes money.
    expect(screen.getByRole('button', { name: /^Hold/ })).toBeDisabled();
    const step = screen.getByRole('form', { name: 'Open the cash drawer to start the shift' });
    expect(within(step).getByLabelText('Opening cash')).toBeEnabled();
    expect(within(step).getByRole('button', { name: 'Open drawer' })).toBeEnabled();
    expect(within(step).queryByText(/Refresh this bill/)).not.toBeInTheDocument();
  });

  it('#1254: opening the drawer after a refusal re-reads the bill so payment can resume', async () => {
    // Declaring a float is a manager action (DEV-873); the re-read is role-independent.
    mocks.queries.refundAccess = query({ authorized: true });
    mocks.mutations.openDrawer!.mockResolvedValue(openDrawer);
    await refuseCashForClosedDrawer();
    expect(mocks.refetch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Opening cash'), { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    await screen.findByText('Cash drawer opened for this counter.');
    expect(mocks.mutations.openDrawer).toHaveBeenCalledWith(
      expect.objectContaining({ openingFloatMinor: 500000 })
    );
    await waitFor(() => expect(mocks.refetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Hold/ })).toBeEnabled());
  });

  it('#1254: a refused non-cash payment does not re-read the drawer', async () => {
    openTheDrawer();
    mocks.mutations.tender!.mockRejectedValueOnce(refused('BAD_REQUEST', 'CARD_DECLINED'));
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    enterPayment('BANK_TRANSFER');
    await screen.findByText(/Payment was not accepted/);
    expect(mocks.drawerStatusInvalidate).not.toHaveBeenCalled();
  });

  it('#1254: a drawer open without a refusal does not re-read the bill', async () => {
    closeDrawer();
    mocks.mutations.openDrawer!.mockResolvedValue(openDrawer);
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.change(screen.getByLabelText('Opening cash'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    await screen.findByText('Cash drawer opened for this counter.');
    await waitFor(() => expect(mocks.drawerStatusInvalidate).toHaveBeenCalled());
    expect(mocks.refetch).not.toHaveBeenCalled();
  });

  it('keeps the drawer step, with a retry, when the drawer status cannot be read (DEV-725)', () => {
    const refetch = vi.fn();
    mocks.queries.drawerStatus = { ...query(), isSuccess: false, isError: true, refetch };
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    expect(screen.queryByLabelText('Scan or search')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('could not check its cash drawer');
    fireEvent.click(screen.getByRole('button', { name: 'Check drawer again' }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Open drawer' })).toBeEnabled();
  });

  it('treats a failed status refresh as an unknown drawer, even over older open data (DEV-725)', () => {
    mocks.queries.drawerStatus = {
      ...query({ openDrawer: { id: 'drawer-stale' } }),
      isSuccess: false,
      isError: true,
    };
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    expect(screen.queryByLabelText('Scan or search')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check drawer again' })).toBeInTheDocument();
    expect(screen.getByLabelText('Bill status')).not.toHaveTextContent('Drawer open');
  });

  it('re-reads the drawer when the server refuses a bill because it was closed elsewhere (DEV-725)', async () => {
    openTheDrawer();
    mocks.searchQuery.mockResolvedValue({ rows: [barcodeRow()], truncated: false });
    mocks.mutations.create!.mockRejectedValue(refused('BAD_REQUEST', 'DRAWER_NOT_OPEN'));
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    fireEvent.change(search, { target: { value: '123456' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(
      await screen.findByText(
        'The cash drawer for this counter is not open. Open it before taking or paying out cash.'
      )
    ).toBeInTheDocument();
    await waitFor(() => expect(mocks.drawerStatusInvalidate).toHaveBeenCalled());
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
  });

  describe('DEV-860: says why a sale cannot start', () => {
    const PROFILE_MISSING_TEXT =
      'This branch has no regulatory profile in force, so it cannot sell yet.';
    const readiness = (canFixSetup: boolean, blockers: string[] = []) =>
      query({ ready: blockers.length === 0, blockers, warnings: [], canFixSetup });

    async function scanRefusedBill() {
      openTheDrawer();
      mocks.searchQuery.mockResolvedValue({ rows: [barcodeRow()], truncated: false });
      mocks.mutations.create!.mockRejectedValue(refused('FORBIDDEN', 'PROFILE_MISSING'));
      render(<PharmacyCounterConsole initialBranchId="branch-a" />);
      const search = screen.getByLabelText('Scan or search');
      fireEvent.change(search, { target: { value: '123456' } });
      fireEvent.keyDown(search, { key: 'Enter' });
      return screen.findByText(PROFILE_MISSING_TEXT);
    }

    it('names the missing setup instead of the generic counter error', async () => {
      mocks.queries.saleReadiness = readiness(false);
      const message = await scanRefusedBill();
      const notice = message.closest('[role="alert"]') as HTMLElement;
      expect(notice).not.toHaveTextContent(COUNTER_UNKNOWN_ERROR_MESSAGE);
      expect(notice).toHaveTextContent('Ask your owner or manager to set this up.');
      expect(within(notice).queryByRole('link')).not.toBeInTheDocument();
      expect(mocks.mutations.addLine).not.toHaveBeenCalled();
    });

    it.each(['create', 'addLine'] as const)(
      'hides unknown %s errors, including internal ids and stack traces',
      async (operation) => {
        openTheDrawer();
        mocks.queries.saleReadiness = readiness(false);
        mocks.searchQuery.mockResolvedValue({ rows: [barcodeRow()], truncated: false });
        mocks.mutations.create!.mockResolvedValue({ id: 'sale-a' });
        mocks.mutations[operation]!.mockRejectedValue(
          new Error('Tenant org-secret failed at /server/private.ts:42: internal-id-123')
        );
        render(<PharmacyCounterConsole initialBranchId="branch-a" />);
        const search = screen.getByLabelText('Scan or search');
        fireEvent.change(search, { target: { value: '123456' } });
        fireEvent.keyDown(search, { key: 'Enter' });
        expect(await screen.findByText(COUNTER_UNKNOWN_ERROR_MESSAGE)).toBeInTheDocument();
        expect(screen.queryByText(/org-secret|private.ts|internal-id-123/)).not.toBeInTheDocument();
      }
    );

    it.each([
      'ORGANIZATION_NOT_ACTIVE',
      'PROFILE_MISSING',
      'BRANCH_INACTIVE',
      'PROFILE_PREMISES_MISMATCH',
      'RULE_SET_UNCONFIRMED',
      'LICENCE_INVALID',
      'QUALIFIED_PERSON_COVERAGE_MISSING',
      'SCHEDULE_NOT_PERMITTED',
      'PHARMACIST_NOT_PRESENT',
    ] as const)('explains an add-line refusal for %s', async (reason) => {
      openTheDrawer();
      mocks.queries.saleReadiness = readiness(false);
      mocks.searchQuery.mockResolvedValue({ rows: [barcodeRow()], truncated: false });
      mocks.mutations.create!.mockResolvedValue({ id: 'sale-a' });
      mocks.mutations.addLine!.mockRejectedValue(refused('FORBIDDEN', reason));
      render(<PharmacyCounterConsole initialBranchId="branch-a" />);
      const search = screen.getByLabelText('Scan or search');
      fireEvent.change(search, { target: { value: '123456' } });
      fireEvent.keyDown(search, { key: 'Enter' });
      const message = await screen.findByText(COUNTER_SETUP_GUIDANCE[reason].message);
      expect(message.closest('[role="alert"]')).toHaveTextContent('Ask your owner or manager');
    });

    it('links an owner or administrator to the setup step', async () => {
      mocks.queries.saleReadiness = readiness(true);
      const message = await scanRefusedBill();
      const notice = message.closest('[role="alert"]') as HTMLElement;
      expect(
        within(notice).getByRole('link', { name: 'Add the branch regulatory profile' })
      ).toHaveAttribute('href', '/pharmacy/regulatory?branch=branch-a');
      expect(notice).not.toHaveTextContent('Ask your owner or manager');
    });

    // Review finding: readiness still loading (or failed) must not demote an administrator.
    it('links an administrator to the setup step before readiness has answered', async () => {
      mocks.queries.saleReadiness = { ...query(), isSuccess: false, isLoading: true };
      mocks.queries.counterBranches = query({
        branches: [{ id: 'branch-a', name: 'Synthetic branch', code: 'MT1' }],
        setupReason: null,
        canFixSetup: true,
      });
      const message = await scanRefusedBill();
      const notice = message.closest('[role="alert"]') as HTMLElement;
      expect(
        within(notice).getByRole('link', { name: 'Add the branch regulatory profile' })
      ).toHaveAttribute('href', '/pharmacy/regulatory?branch=branch-a');
      expect(notice).not.toHaveTextContent('Ask your owner or manager');
    });

    it('names a missing branch assignment from the reason the refusal declares', async () => {
      mocks.queries.saleReadiness = readiness(false);
      openTheDrawer();
      mocks.searchQuery.mockResolvedValue({ rows: [barcodeRow()], truncated: false });
      mocks.mutations.create!.mockRejectedValue(
        Object.assign(new Error('Branch is outside your scope.'), {
          data: { code: 'FORBIDDEN', reason: 'BRANCH_NOT_ASSIGNED' },
        })
      );
      render(<PharmacyCounterConsole initialBranchId="branch-a" />);
      const search = screen.getByLabelText('Scan or search');
      fireEvent.change(search, { target: { value: '123456' } });
      fireEvent.keyDown(search, { key: 'Enter' });
      const message = await screen.findByText(
        'You are not assigned to this branch, so you cannot sell here.'
      );
      expect(message.closest('[role="alert"]')).toHaveTextContent(
        'Ask your owner or manager to set this up.'
      );
    });

    it('lists missing setup before the first scan, for this branch and counter device', () => {
      mocks.queries.saleReadiness = readiness(false, ['LICENCE_INVALID']);
      render(<PharmacyCounterConsole initialBranchId="branch-a" />);
      const panel = screen.getByRole('region', { name: 'This counter cannot sell yet' });
      expect(panel).toHaveTextContent('This branch has no valid licence on file');
      expect(panel).toHaveTextContent('Ask your owner or manager to set this up.');
      expect(mocks.queryInputs).toHaveBeenCalledWith(
        'saleReadiness',
        expect.objectContaining({ branchId: 'branch-a' }),
        expect.objectContaining({ enabled: true })
      );
    });

    // Review finding: an add-line refusal the server words for the operator keeps its words.
    it.each([
      ['FORBIDDEN', () => new CounterApprovalDenied('FEFO_OVERRIDE').message],
      ['BAD_REQUEST', () => new PharmacyRxReferenceError('PRESCRIPTION_PATIENT_MISMATCH').message],
      ['BAD_REQUEST', () => new PharmacyRxReferenceError('PRESCRIPTION_REQUIRED').message],
    ] as const)('keeps a deliberate %s add-line refusal in its own words', async (code, text) => {
      openTheDrawer();
      mocks.queries.saleReadiness = readiness(false);
      mocks.searchQuery.mockResolvedValue({ rows: [barcodeRow()], truncated: false });
      mocks.mutations.create!.mockResolvedValue({ id: 'sale-a' });
      mocks.mutations.addLine!.mockRejectedValue(refused(code, text()));
      render(<PharmacyCounterConsole initialBranchId="branch-a" />);
      const search = screen.getByLabelText('Scan or search');
      fireEvent.change(search, { target: { value: '123456' } });
      fireEvent.keyDown(search, { key: 'Enter' });
      expect(await screen.findByText(text())).toBeInTheDocument();
      expect(screen.queryByText(COUNTER_UNKNOWN_ERROR_MESSAGE)).not.toBeInTheDocument();
    });

    // Review finding: `counterBranches` lists no branch for an unassigned member, so the
    // counter never reaches the ready-to-sell check; the first screen must say why.
    it('tells an unassigned employee to ask their owner, with no setup links', () => {
      mocks.session.data.user.role = 'EMPLOYEE';
      mocks.queries.counterBranches = query({
        branches: [],
        currency: 'PKR',
        timezone: 'UTC',
        paymentSandboxAvailable: false,
        setupReason: 'BRANCH_NOT_ASSIGNED',
        canFixSetup: false,
      });
      render(<PharmacyCounterConsole />);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(
        'You are not assigned to an active branch, so this counter cannot sell.'
      );
      expect(alert).toHaveTextContent('Ask your owner or manager to set this up.');
      expect(screen.queryByText('No active branch is configured yet.')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('link', { name: 'Organization administration' })
      ).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Scan or search')).not.toBeInTheDocument();
      expect(mocks.mutations.create).not.toHaveBeenCalled();
    });

    it('keeps the branch setup checklist for an administrator with no branch', () => {
      mocks.session.data.user.role = 'ADMIN';
      mocks.queries.counterBranches = query({
        branches: [],
        setupReason: null,
        canFixSetup: true,
      });
      render(<PharmacyCounterConsole />);
      expect(screen.getByText('No active branch is configured yet.')).toBeInTheDocument();
      expect(
        screen.getAllByRole('link', { name: 'Organization administration' }).length
      ).toBeGreaterThan(0);
      expect(screen.queryByText(/not assigned to an active branch/)).not.toBeInTheDocument();
    });

    // DEV-970: "Okay" puts the list away; a blocking list stays on screen as one line.
    describe('DEV-970: Okay on the ready-to-sell panel', () => {
      beforeEach(() => {
        clearCounterReadinessOkay();
        window.sessionStorage.clear();
        window.localStorage.setItem('devfathom.pharmacy.counter.device', 'device-a');
      });

      it('shrinks a blocking list to one line that still says why and still re-checks', () => {
        const check = readiness(false, ['LICENCE_INVALID']);
        mocks.queries.saleReadiness = check;
        render(<PharmacyCounterConsole initialBranchId="branch-a" />);
        const panel = screen.getByRole('region', { name: 'This counter cannot sell yet' });
        fireEvent.click(within(panel).getByRole('button', { name: /^Okay/ }));

        const line = screen.getByRole('region', { name: 'Sales are blocked at this counter.' });
        expect(line).not.toHaveTextContent('This branch has no valid licence on file');
        expect(within(line).getByRole('button', { name: 'Show why' })).toHaveFocus();
        fireEvent.click(within(line).getByRole('button', { name: 'Check again' }));
        expect(check.refetch).toHaveBeenCalledTimes(1);

        fireEvent.click(within(line).getByRole('button', { name: 'Show why' }));
        expect(
          screen.getByRole('region', { name: 'This counter cannot sell yet' })
        ).toHaveTextContent('This branch has no valid licence on file');
      });

      it('remembers the Okay for this person, branch and counter computer across a reload', () => {
        mocks.queries.saleReadiness = readiness(false, ['LICENCE_INVALID']);
        const view = render(<PharmacyCounterConsole initialBranchId="branch-a" />);
        fireEvent.click(screen.getByRole('button', { name: /^Okay/ }));
        view.unmount();
        expect(
          window.sessionStorage.getItem(
            counterReadinessOkayKey({
              organizationId: 'org-a',
              accountId: 'account-a',
              branchId: 'branch-a',
              deviceId: 'device-a',
            })
          )
        ).toBe('["LICENCE_INVALID"]');

        render(<PharmacyCounterConsole initialBranchId="branch-a" />);
        expect(
          screen.getByRole('region', { name: 'Sales are blocked at this counter.' })
        ).toBeVisible();
      });

      it('hides a limits-only list and puts focus back on the scan field', () => {
        openTheDrawer();
        mocks.queries.saleReadiness = query({
          ready: true,
          blockers: [],
          warnings: ['PHARMACIST_NOT_PRESENT'],
          canFixSetup: false,
        });
        render(<PharmacyCounterConsole initialBranchId="branch-a" />);
        const panel = screen.getByRole('region', { name: 'Some sales are limited' });
        fireEvent.click(within(panel).getByRole('button', { name: 'Okay, hide this' }));
        expect(
          screen.queryByRole('region', { name: 'Some sales are limited' })
        ).not.toBeInTheDocument();
        expect(screen.getByLabelText('Scan or search')).toHaveFocus();
      });

      it('shows the list in full again once the session has ended', () => {
        mocks.queries.saleReadiness = readiness(false, ['LICENCE_INVALID']);
        const view = render(<PharmacyCounterConsole initialBranchId="branch-a" />);
        fireEvent.click(screen.getByRole('button', { name: /^Okay/ }));
        const signedIn = mocks.session;
        mocks.session = {
          status: 'unauthenticated',
          data: null,
        } as unknown as typeof mocks.session;
        view.rerender(<PharmacyCounterConsole initialBranchId="branch-a" />);
        expect(screen.getByText(/Sign in with an authorized pharmacy account/)).toBeInTheDocument();

        mocks.session = signedIn;
        view.rerender(<PharmacyCounterConsole initialBranchId="branch-a" />);
        expect(screen.getByRole('region', { name: 'This counter cannot sell yet' })).toBeVisible();
      });
    });

    it('does not list setup over an open bill', () => {
      mocks.queries.saleReadiness = readiness(false, ['LICENCE_INVALID']);
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      expect(
        screen.queryByRole('region', { name: 'This counter cannot sell yet' })
      ).not.toBeInTheDocument();
    });
  });

  it('adds no line to an open bill once the drawer is closed elsewhere (DEV-725)', async () => {
    openTheDrawer();
    let resolveSearch:
      ((result: { rows: CounterSearchRow[]; truncated: boolean }) => void) | undefined;
    mocks.searchFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        })
    );
    mocks.mutations.addLine!.mockResolvedValue({});
    const view = render(
      <PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />
    );
    const search = screen.getByLabelText('Scan or search');
    fireEvent.change(search, { target: { value: '123456' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(mocks.searchFetch).toHaveBeenCalled());
    closeDrawer();
    view.rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    await act(async () => resolveSearch!({ rows: [barcodeRow()], truncated: false }));
    expect(
      await screen.findByText(
        'The cash drawer for this counter is not open. Open it before taking or paying out cash.'
      )
    ).toBeInTheDocument();
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
  });

  it('explains blocked site storage instead of waiting on a drawer it cannot read (DEV-725)', () => {
    const blocked = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      closeDrawer();
      mocks.queries.drawerStatus = { ...query(), isSuccess: false };
      render(<PharmacyCounterConsole initialBranchId="branch-a" />);
      expect(screen.getByText(/blocking site storage/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Open drawer' })).toBeDisabled();
      expect(screen.queryByLabelText('Scan or search')).not.toBeInTheDocument();
    } finally {
      blocked.mockRestore();
    }
  });

  it('words a conflicting open for the operator instead of leaking the server failure', async () => {
    closeDrawer();
    mocks.mutations.openDrawer!.mockRejectedValue(refused('CONFLICT', 'OPEN_DRAWER'));
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    fireEvent.change(screen.getByLabelText('Opening cash'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    expect(
      await screen.findByText(
        'A drawer is already open on this counter. Close it before opening another.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/OPEN_DRAWER|prisma|Unique constraint/)).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.drawerStatusInvalidate).toHaveBeenCalled());
  });

  it.each([
    'single',
    'gs1',
    'stockout',
    'stale',
    'error',
    'busy',
    'unmount',
    'unmount-create',
    'stale-create',
  ])('handles %s barcode results without adding an unsafe or stale line', async (mode) => {
    openTheDrawer();
    const row = {
      medicineId: 'med-barcode',
      displayName: 'Paracetamol',
      brandName: null,
      manufacturer: null,
      strength: '500 mg',
      presentationId: 'presentation-a',
      presentation: 'Tablet',
      dosageForm: 'Tablet',
      route: 'Oral',
      matchedOn: 'BARCODE',
      recommendedLotId: 'lot-a',
      packLevelId: 'pack-a',
      unitsPerPack: 1,
      printedMrpMinor: 10000,
      roundingIncrementMinor: 1,
      batchNumber: 'B-1',
      nearestSafeExpiry: '2028-06-30T00:00:00.000Z',
      onHandUnits: 10,
      saleableUnits: [],
      saleUnits: [
        {
          kind: 'UNIT',
          packLevelId: 'pack-a',
          levelLabel: 'UNIT',
          canonicalUnitsPerSaleUnit: 1,
        },
      ],
      restriction: {
        rx: false,
        otc: true,
        restricted: false,
        controlled: false,
        highAlert: false,
        lasa: false,
      },
      storage: {
        coldChain: false,
        locationKind: 'STORE',
        locationCode: 'A',
        locationName: 'Store',
      },
      blocked: [],
    };
    if (mode === 'stockout') row.onHandUnits = 0;
    mocks.queries.counterSearch = query({ rows: [row] });
    let resolveSearch: ((result: { rows: (typeof row)[] }) => void) | undefined;
    if (mode === 'stale' || mode === 'busy' || mode === 'unmount') {
      mocks.searchFetch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSearch = resolve;
          })
      );
    }
    if (mode === 'error') mocks.searchFetch.mockRejectedValueOnce(new Error('Search unavailable'));
    if (mode === 'gs1')
      mocks.mutations.authenticatePack!.mockResolvedValue({
        status: 'VERIFIED',
        parsed: { gtin: '01234567890123' },
        explanation: 'Pack verified',
      });
    let resolveCreate: ((result: { id: string }) => void) | undefined;
    const creating = mode === 'unmount-create' || mode === 'stale-create';
    if (creating) {
      mocks.mutations.create!.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCreate = resolve;
          })
      );
    }
    mocks.mutations.addLine!.mockResolvedValue({});
    const view = render(
      <PharmacyCounterConsole
        initialSaleId={creating ? undefined : 'sale-a'}
        initialBranchId="branch-a"
      />
    );
    const search = screen.getByLabelText('Scan or search');
    fireEvent.change(search, {
      target: { value: mode === 'gs1' ? '(01)01234567890123' : '123456' },
    });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(mocks.searchFetch).toHaveBeenCalled());
    expect(mocks.searchFetch).toHaveBeenCalledWith(
      { branchId: 'branch-a', query: mode === 'gs1' ? '01234567890123' : '123456' },
      { staleTime: 10_000 }
    );
    if (mode === 'unmount') {
      view.unmount();
      await act(async () => resolveSearch!({ rows: [row] }));
      expect(mocks.mutations.create).not.toHaveBeenCalled();
    }
    if (creating) {
      await waitFor(() => expect(mocks.mutations.create).toHaveBeenCalledTimes(1));
      if (mode === 'unmount-create') view.unmount();
      else fireEvent.change(search, { target: { value: 'another medicine' } });
      await act(async () => resolveCreate!({ id: 'sale-created' }));
    }
    if (mode === 'stale') {
      fireEvent.change(search, { target: { value: 'another medicine' } });
      await act(async () => resolveSearch!({ rows: [row] }));
    }
    if (mode === 'busy') {
      // The drawer is closed elsewhere mid-scan; opening it again keeps the counter busy.
      closeDrawer();
      view.rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      mocks.mutations.openDrawer!.mockImplementationOnce(() => new Promise(() => {}));
      fireEvent.change(screen.getByLabelText('Opening cash'), { target: { value: '0' } });
      fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
      await waitFor(() => expect(mocks.mutations.openDrawer).toHaveBeenCalled());
      await act(async () => resolveSearch!({ rows: [row] }));
    }
    if (
      ['stockout', 'stale', 'error', 'busy', 'unmount', 'unmount-create', 'stale-create'].includes(
        mode
      )
    ) {
      await act(async () => {
        await Promise.resolve();
      });
      expect(mocks.mutations.addLine).not.toHaveBeenCalled();
      return;
    }
    await waitFor(() =>
      expect(mocks.mutations.addLine).toHaveBeenCalledWith(
        expect.objectContaining({ medicineId: 'med-barcode', quantity: 1 })
      )
    );
    await screen.findByText('1 × Paracetamol added.');
    expect(mocks.searchQuery).toHaveBeenCalledWith(
      { branchId: 'branch-a', query: mode === 'gs1' ? '01234567890123' : '123456' },
      { staleTime: 10_000 }
    );

    const successMessage = await screen.findByText('1 × Paracetamol added.');
    expect(successMessage).toHaveClass('text-text-body');
    expect(successMessage).not.toHaveClass('text-text-muted');
    expect(successMessage.closest('[role="status"]')).toHaveClass('bg-success/10');

    expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1);
    mocks.mutations.addLine!.mockClear();
    mocks.queries.counterSearch = query({ rows: [row, { ...row, medicineId: 'med-other' }] });
    fireEvent.change(search, { target: { value: '654321' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.searchQuery).toHaveBeenCalledWith(
      { branchId: 'branch-a', query: '654321' },
      { staleTime: 10_000 }
    );
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
  });

  it('does not run F9 while a field is focused or another dialog is open', async () => {
    openTheDrawer();
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() => mocks.searchProps.mock.calls.at(-1)![0].onSelect(barcodeRow({ saleUnits: [] })));
    const quantity = screen.getByLabelText('Requested tablets');
    quantity.focus();
    fireEvent.keyDown(quantity, { key: 'F9' });
    expect(document.activeElement).toBe(quantity);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key: 'F9' });
    expect(screen.queryByRole('dialog', { name: /^Take payment/ })).not.toBeInTheDocument();
    dialog.remove();
    screen.getByLabelText('Scan or search').focus();
    fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key: 'F9' });
    const amount = screen.getByLabelText('Amount');
    await waitFor(() => expect(document.activeElement).toBe(amount.closest('[tabindex="-1"]')));
    amount.focus();
    fireEvent.keyDown(amount, { key: 'F9' });
    expect(document.activeElement).toBe(amount);
  });

  it('announces a held bill as "Bill held." (CRT-003)', async () => {
    openTheDrawer();
    mocks.mutations.transition!.mockResolvedValue({});
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.click(screen.getByRole('button', { name: /^Hold/ }));
    expect(await screen.findByText('Bill held.')).toBeInTheDocument();
  });

  it('runs F9 and Shift+F4 from the scan field, where focus rests for the whole bill (POS-01)', async () => {
    openTheDrawer();
    mocks.mutations.transition!.mockResolvedValue({});
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    const tender = screen.getByLabelText('Amount').closest('[tabindex="-1"]');

    search.focus();
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: 'F9' });
    await waitFor(() => expect(document.activeElement).toBe(tender));
    fireEvent.click(screen.getByRole('button', { name: 'Back to bill' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    search.focus();
    fireEvent.keyDown(search, { key: 'F4', shiftKey: true });
    // DEV-508: the chord only opens the void dialog; nothing is voided until confirmed.
    const voidDialog = await screen.findByRole('dialog', { name: 'Void this bill?' });
    expect(mocks.mutations.transition).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'void' })
    );
    const confirm = within(voidDialog).getByRole('button', { name: 'Void bill' });
    expect(confirm).toBeDisabled();
    fireEvent.click(within(voidDialog).getByRole('radio', { name: 'Wrong items scanned' }));
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(mocks.mutations.transition).toHaveBeenCalledWith(
        expect.objectContaining({
          saleId: 'sale-a',
          action: 'void',
          voidReason: { code: 'WRONG_ITEMS' },
        })
      )
    );
  });

  it("shows the server's refusal when a cashier voids another cashier's bill (DEV-508, DEV-821)", async () => {
    openTheDrawer();
    mocks.mutations.transition!.mockRejectedValue(refused('FORBIDDEN', 'NOT_BILL_OWNER'));
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    search.focus();
    fireEvent.keyDown(search, { key: 'F4', shiftKey: true });
    const voidDialog = await screen.findByRole('dialog', { name: 'Void this bill?' });
    fireEvent.click(within(voidDialog).getByRole('radio', { name: 'Duplicate bill' }));
    fireEvent.click(within(voidDialog).getByRole('button', { name: 'Void bill' }));
    expect(
      await screen.findByText(
        'Another cashier opened this bill. Only that cashier or a manager or owner can void it.'
      )
    ).toBeInTheDocument();
    expect(mocks.mutations.transition).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'void', voidReason: { code: 'DUPLICATE_BILL' } })
    );
    expect(screen.queryByText('Bill voided.')).not.toBeInTheDocument();
  });

  it('cancels a Shift+F4 void without changing the bill (DEV-508)', async () => {
    openTheDrawer();
    mocks.mutations.transition!.mockResolvedValue({});
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    search.focus();
    fireEvent.keyDown(search, { key: 'F4', shiftKey: true });
    const voidDialog = await screen.findByRole('dialog', { name: 'Void this bill?' });
    fireEvent.click(within(voidDialog).getByRole('radio', { name: 'Other' }));
    const confirm = within(voidDialog).getByRole('button', { name: 'Void bill' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(voidDialog).getByLabelText('Describe the reason'), {
      target: { value: '   ' },
    });
    expect(confirm).toBeDisabled();
    fireEvent.click(within(voidDialog).getByRole('button', { name: 'Keep bill' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Void this bill?' })).not.toBeInTheDocument()
    );
    expect(mocks.mutations.transition).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'void' })
    );
  });
});

describe('PharmacyCounterConsole barcode safety', () => {
  const gs1 = '(01)01234567890128(10)B-1';

  function scan(value = '123456') {
    const search = screen.getByLabelText('Scan or search');
    fireEvent.change(search, { target: { value } });
    fireEvent.keyDown(search, { key: 'Enter' });
    return search;
  }

  beforeEach(() => {
    mocks.queries.counterSearch = query({ rows: [barcodeRow()], truncated: false });
    mocks.mutations.addLine!.mockResolvedValue({});
    mocks.mutations.authenticatePack!.mockResolvedValue({
      status: 'VERIFIED',
      explanation: 'Pack verified.',
      parsed: { gtin: '01234567890128' },
    });
  });

  it('adds only the medicine returned for the submitted barcode, ignoring stale hook data', async () => {
    mocks.searchQuery.mockResolvedValue({
      rows: [barcodeRow({ medicineId: 'fresh-medicine', displayName: 'Fresh medicine' })],
      truncated: false,
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    scan();
    await screen.findByText('1 × Fresh medicine added.');
    expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ medicineId: 'fresh-medicine', quantity: 1 })
    );
  });

  it("DEV-66: tells the cashier when the owner's maximum skipped a promotion", async () => {
    mocks.mutations.addLine!.mockResolvedValue({ promotionNotice: 'PROMOTION_ABOVE_MAXIMUM' });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    scan();
    const notice = await screen.findByText(
      "1 × Paracetamol added. This promotion is above the owner's maximum discount, so the item was added at full price."
    );
    // A warning the cashier sees, not the usual green "added" toast.
    expect(notice.closest('[role="alert"]')).toHaveClass('bg-warning/10');
  });

  it('DEV-780: sends a checked voucher and the cashier PIN with the next item, then drops it', async () => {
    mocks.voucherFetch.mockResolvedValue({
      id: 'voucher-a',
      code: 'SAVE-100',
      name: 'Front shop offer',
      discountMinor: 10_000,
      usesLeft: 2,
      maxUses: 3,
      validUntil: new Date('2031-01-01T00:00:00.000Z'),
      status: 'READY',
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.click(screen.getByText('Voucher'));
    fireEvent.change(screen.getByLabelText('Voucher code'), { target: { value: 'save-100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check voucher' }));
    await screen.findByText(/2 of 3 uses left/);
    expect(mocks.voucherFetch).toHaveBeenCalledWith({ branchId: 'branch-a', code: 'save-100' });
    fireEvent.change(screen.getByLabelText('Your PIN'), { target: { value: '4321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use on next item' }));
    // DEV-972: one short line on the bill side; the full sentence is its hover text.
    expect(
      (await screen.findByText('Voucher SAVE-100 applied: Rs 100.00 off')).closest(
        '[role="status"]'
      )
    ).toHaveAttribute(
      'title',
      'Voucher SAVE-100 (Front shop offer) takes Rs 100.00 off the next non-drug item you add.'
    );
    scan();
    await screen.findByText('1 × Paracetamol added with voucher SAVE-100.');
    expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ voucherId: 'voucher-a', voucherPin: '4321' })
    );
    // The voucher and its PIN belong to that one add.
    expect(screen.queryByRole('button', { name: 'Remove voucher' })).not.toBeInTheDocument();
    mocks.mutations.addLine!.mockClear();
    scan();
    await waitFor(() => expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1));
    expect(mocks.mutations.addLine).toHaveBeenCalledWith(
      expect.not.objectContaining({ voucherId: expect.anything() })
    );
  });

  describe('DEV-956 whole-bill discount at the counter', () => {
    it('shows nothing new while the owner has it off', () => {
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      expect(screen.queryByText('Discount the whole bill')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Discount' })).toBeInTheDocument();
      expect(mocks.mutations.applyBillDiscount).not.toHaveBeenCalled();
    });

    it('gives it on the open bill through the approval dialog and re-reads the bill', async () => {
      mocks.queries.billDiscountSetting = query({ enabled: true, canChange: false });
      mocks.discountApprovers.mockResolvedValue([
        { id: 'staff-manager', name: 'Manager', self: false },
      ]);
      mocks.mutations
        .applyBillDiscount!.mockRejectedValueOnce(
          refused('FORBIDDEN', 'A discount needs a manager to approve it with their PIN.')
        )
        .mockResolvedValueOnce({
          status: 'APPLIED',
          totalMinor: 2_500,
          previousTotalMinor: 0,
          lines: [{ saleLineId: 'line-a', discountMinor: 2_500 }],
          excluded: [],
        });
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      fireEvent.click(screen.getByText('Discount the whole bill'));
      fireEvent.change(screen.getByLabelText('Bill discount (%)'), { target: { value: '10' } });
      fireEvent.click(screen.getByRole('button', { name: 'Apply to bill' }));
      const dialog = await screen.findByRole('dialog', { name: 'Approve this discount?' });
      expect(dialog).toHaveTextContent('Whole bill: a discount of 10% off the bill.');
      await within(dialog).findByRole('option', { name: 'Manager' });
      fireEvent.change(within(dialog).getByLabelText('Approving manager or owner'), {
        target: { value: 'staff-manager' },
      });
      fireEvent.change(within(dialog).getByLabelText('Approver PIN'), {
        target: { value: '975310' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Approve discount' }));
      await screen.findByText(
        'A whole-bill discount of Rs 25.00 is on the bill, shared over 1 item.'
      );
      expect(mocks.mutations.applyBillDiscount).toHaveBeenLastCalledWith({
        branchId: 'branch-a',
        saleId: 'sale-a',
        discount: { kind: 'PERCENT', bps: 1_000 },
        discountApproval: { staffProfileId: 'staff-manager', pin: '975310' },
      });
      expect(mocks.refetch).toHaveBeenCalled();
    });

    it('tells the cashier when adding an item removed the bill discount, to give it again', async () => {
      mocks.mutations.addLine!.mockResolvedValueOnce({ billDiscountClearedMinor: 2_500 });
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      scan();
      await screen.findByText(
        '1 × Paracetamol added. The whole-bill discount of Rs 25.00 was removed because the bill changed. Give it again to include this item.'
      );
    });

    it('is not offered to change once the bill has taken a payment', () => {
      mocks.queries.billDiscountSetting = query({ enabled: true, canChange: false });
      mocks.queries.counterCart = {
        ...query(
          cart({
            totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 5000 },
          })
        ),
        refetch: mocks.refetch,
      };
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      fireEvent.click(screen.getByText('Discount the whole bill'));
      expect(screen.getByRole('button', { name: 'Apply to bill' })).toBeDisabled();
    });
  });

  describe('DEV-929 manual discount at the counter', () => {
    // DEV-972: the discount panel opens from the bill side's "Discount" button.
    function openDiscount() {
      if (!screen.queryByRole('button', { name: 'Apply to next item' }))
        fireEvent.click(screen.getByRole('button', { name: 'Discount' }));
    }

    function giveDiscount(
      value: string,
      kind: 'Percentage (%)' | 'Amount (Rs)' = 'Percentage (%)'
    ) {
      openDiscount();
      fireEvent.click(screen.getByRole('button', { name: kind }));
      fireEvent.change(
        screen.getByLabelText(kind === 'Amount (Rs)' ? 'Discount (Rs)' : 'Discount (%)'),
        { target: { value } }
      );
      fireEvent.click(screen.getByRole('button', { name: 'Apply to next item' }));
    }

    it('says plainly when the owner has set no maximum', () => {
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      openDiscount();
      expect(
        screen.getByText(/The owner has not set a maximum discount\./, { exact: false })
      ).toBeInTheDocument();
      expect(mocks.queryInputs).toHaveBeenCalledWith(
        'discountMaximum',
        { branchId: 'branch-a' },
        undefined
      );
    });

    it('a cashier with the discount right gives it without a PIN, and it is dropped after', async () => {
      mocks.queries.discountMaximum = query({ maxDiscountBps: 1_500, canChange: false });
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      openDiscount();
      expect(
        screen.getByText("The owner's maximum discount is 15% of an item's price.")
      ).toBeInTheDocument();
      giveDiscount('10');
      await screen.findByText('10% off the next item');
      scan();
      await screen.findByText('1 × Paracetamol added with a discount of Rs 10.00.');
      const [input] = mocks.mutations.addLine!.mock.calls[0]!;
      expect(input).toMatchObject({ discountKind: 'DISCOUNT', discountMinor: 1_000 });
      expect(input).not.toHaveProperty('discountApproval');
      expect(mocks.discountApprovers).not.toHaveBeenCalled();
      // The discount belongs to that one item.
      expect(screen.queryByRole('button', { name: 'Remove discount' })).not.toBeInTheDocument();
      mocks.mutations.addLine!.mockClear();
      scan();
      await waitFor(() => expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1));
      expect(mocks.mutations.addLine).toHaveBeenCalledWith(
        expect.not.objectContaining({ discountMinor: expect.anything() })
      );
    });

    it('sends an amount in rupees as the discount', async () => {
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      giveDiscount('25.50', 'Amount (Rs)');
      await screen.findByText('Rs 25.50 off the next item');
      scan();
      await screen.findByText('1 × Paracetamol added with a discount of Rs 25.50.');
      expect(mocks.mutations.addLine).toHaveBeenCalledWith(
        expect.objectContaining({ discountKind: 'DISCOUNT', discountMinor: 2_550 })
      );
    });

    it.each([false, true])(
      "a cashier without the right is asked for a manager's PIN (solo owner: %s)",
      async (self) => {
        mocks.discountApprovers.mockResolvedValue([
          { id: 'staff-manager', name: self ? 'Owner' : 'Manager', self },
        ]);
        mocks.mutations
          .addLine!.mockRejectedValueOnce(
            refused('FORBIDDEN', 'A discount needs a manager to approve it with their PIN.')
          )
          .mockResolvedValueOnce({});
        render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
        giveDiscount('5');
        await screen.findByRole('button', { name: 'Remove discount' });
        scan();
        const dialog = await screen.findByRole('dialog', { name: 'Approve this discount?' });
        expect(dialog).toHaveTextContent('Paracetamol: a discount of Rs 5.00.');
        expect(mocks.discountApprovers).toHaveBeenCalledWith({ branchId: 'branch-a' });
        await within(dialog).findByRole('option', { name: self ? 'Owner (you)' : 'Manager' });
        fireEvent.change(within(dialog).getByLabelText('Approving manager or owner'), {
          target: { value: 'staff-manager' },
        });
        fireEvent.change(within(dialog).getByLabelText('Approver PIN'), {
          target: { value: '975310' },
        });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Approve discount' }));
        await screen.findByText('1 × Paracetamol added with a discount of Rs 5.00.');
        const [first, second] = mocks.mutations.addLine!.mock.calls.map(([input]) => input);
        expect(first).toMatchObject({ discountMinor: 500 });
        expect(first).not.toHaveProperty('discountApproval');
        expect(second).toEqual({
          ...first,
          discountApproval: { staffProfileId: 'staff-manager', pin: '975310' },
        });
      }
    );

    it('says so when the PIN does not approve the discount, and adds nothing', async () => {
      const denied = () =>
        refused('FORBIDDEN', 'A discount needs a manager to approve it with their PIN.');
      mocks.discountApprovers.mockResolvedValue([
        { id: 'staff-manager', name: 'Manager', self: false },
      ]);
      mocks.mutations.addLine!.mockRejectedValueOnce(denied()).mockRejectedValueOnce(denied());
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      giveDiscount('5');
      await screen.findByRole('button', { name: 'Remove discount' });
      scan();
      const dialog = await screen.findByRole('dialog', { name: 'Approve this discount?' });
      await within(dialog).findByRole('option', { name: 'Manager' });
      fireEvent.change(within(dialog).getByLabelText('Approving manager or owner'), {
        target: { value: 'staff-manager' },
      });
      fireEvent.change(within(dialog).getByLabelText('Approver PIN'), {
        target: { value: '0000' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Approve discount' }));
      await screen.findByText(
        'That PIN did not approve the discount, so the item was not added. A manager or owner must enter their own PIN.'
      );
      expect(mocks.mutations.addLine).toHaveBeenCalledTimes(2);
    });

    it("refuses a share above the owner's maximum before sending it", () => {
      mocks.queries.discountMaximum = query({ maxDiscountBps: 1_000, canChange: false });
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      giveDiscount('12.5');
      expect(screen.getByRole('alert')).toHaveTextContent(
        "12.5% is above the owner's maximum discount of 10%. Give a smaller discount, or ask the owner to raise the maximum."
      );
      expect(screen.getByLabelText('Discount (%)')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.queryByRole('button', { name: 'Remove discount' })).not.toBeInTheDocument();
    });

    it.each([
      [
        'DISCOUNT_ABOVE_MAXIMUM',
        "This discount or voucher is above the owner's maximum discount. Give a smaller discount, or ask the owner to raise the maximum.",
      ],
      [
        'MARGIN_GUARDRAIL',
        "This discount would take the item below its cost or the branch's minimum margin. Give a smaller discount.",
      ],
    ])('shows the server refusing %s in plain words', async (reason, message) => {
      mocks.mutations.addLine!.mockRejectedValueOnce(refused('BAD_REQUEST', reason));
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      giveDiscount('100', 'Amount (Rs)');
      await screen.findByRole('button', { name: 'Remove discount' });
      scan();
      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(mocks.discountApprovers).not.toHaveBeenCalled();
    });

    it('never holds a discount and a voucher for the same item', async () => {
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      giveDiscount('5');
      await screen.findByRole('button', { name: 'Remove discount' });
      fireEvent.click(screen.getByRole('button', { name: 'Voucher' }));
      expect(screen.getByRole('button', { name: 'Check voucher' })).toBeDisabled();
    });
  });

  async function holdVoucher() {
    mocks.voucherFetch.mockResolvedValue({
      id: 'voucher-a',
      code: 'SAVE-100',
      name: 'Front shop offer',
      discountMinor: 10_000,
      usesLeft: 2,
      maxUses: 3,
      validUntil: new Date('2031-01-01T00:00:00.000Z'),
      status: 'READY',
    });
    fireEvent.click(screen.getByText('Voucher'));
    fireEvent.change(screen.getByLabelText('Voucher code'), { target: { value: 'SAVE-100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check voucher' }));
    fireEvent.change(await screen.findByLabelText('Your PIN'), { target: { value: '4321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use on next item' }));
    await screen.findByRole('button', { name: 'Remove voucher' });
  }

  it('DEV-780: a voucher held at one branch is discarded, not hidden, when the branch changes', async () => {
    mocks.queries.counterBranches = query({
      branches: [
        { id: 'branch-a', name: 'A' },
        { id: 'branch-b', name: 'B' },
      ],
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    await holdVoucher();
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch-b' } });
    expect(screen.queryByRole('button', { name: 'Remove voucher' })).not.toBeInTheDocument();
    // Switching back does not restore the earlier customer's voucher or the cashier PIN.
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch-a' } });
    expect(screen.queryByRole('button', { name: 'Remove voucher' })).not.toBeInTheDocument();
    expect(screen.getByText('Voucher')).toBeInTheDocument();
  });

  it('DEV-780: a retry after a lost voucher add reuses its key, so it cannot add the item twice', async () => {
    mocks.mutations.addLine!.mockRejectedValueOnce(new Error('Synthetic network failure'));
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    await holdVoucher();
    scan();
    await waitFor(() => expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1));
    // The voucher and its PIN are dropped after the uncertain add.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove voucher' })).not.toBeInTheDocument()
    );
    scan();
    await waitFor(() => expect(mocks.mutations.addLine).toHaveBeenCalledTimes(2));
    const [first, retry] = mocks.mutations.addLine!.mock.calls.map(
      ([input]) => input as { idempotencyKey: string; voucherId?: string }
    );
    expect(first).toMatchObject({ voucherId: 'voucher-a', voucherPin: '4321' });
    expect(retry!.voucherId).toBeUndefined();
    // Same key: the server replays a committed line or refuses the changed voucher.
    expect(retry!.idempotencyKey).toBe(first!.idempotencyKey);
  });

  it('DEV-780: refuses to hold a voucher that reached its use limit', async () => {
    mocks.voucherFetch.mockResolvedValue({
      id: 'voucher-a',
      code: 'SAVE-100',
      name: 'Front shop offer',
      discountMinor: 10_000,
      usesLeft: 0,
      maxUses: 3,
      validUntil: new Date('2031-01-01T00:00:00.000Z'),
      status: 'USED_UP',
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.click(screen.getByText('Voucher'));
    fireEvent.change(screen.getByLabelText('Voucher code'), { target: { value: 'SAVE-100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check voucher' }));
    expect(await screen.findByText('This voucher has reached its use limit.')).toHaveAttribute(
      'role',
      'alert'
    );
    expect(screen.queryByLabelText('Your PIN')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use on next item' })).not.toBeInTheDocument();
  });

  describe('DEV-972 voucher and discount sit on the bill side, not in the search column', () => {
    const searchColumn = () => document.getElementById('counter-scan-search')!;
    const billSide = () => screen.getByRole('complementary', { name: 'Bill total' });
    const nextItemControls = () =>
      within(billSide()).getByRole('group', { name: 'Voucher and discount for the next item' });

    it('puts nothing between the search box and its results', () => {
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      const column = searchColumn();
      expect(within(column).queryByRole('button', { name: 'Voucher' })).not.toBeInTheDocument();
      expect(within(column).queryByRole('button', { name: 'Discount' })).not.toBeInTheDocument();
      expect(within(column).queryByText('Give a discount')).not.toBeInTheDocument();
      expect(within(column).queryByLabelText('Voucher code')).not.toBeInTheDocument();
      expect(within(nextItemControls()).getByRole('button', { name: 'Voucher' })).toBeEnabled();
      expect(within(nextItemControls()).getByRole('button', { name: 'Discount' })).toBeEnabled();
      // Closed, they take no room: the panels are not on the page until opened.
      expect(screen.queryByLabelText('Voucher code')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Discount (%)')).not.toBeInTheDocument();
    });

    it('shows a held voucher as one short line with its remove action on the bill side', async () => {
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      await holdVoucher();
      const line = within(nextItemControls()).getByRole('status');
      expect(line).toHaveTextContent('Voucher SAVE-100 applied: Rs 100.00 off');
      expect(line).toHaveAttribute(
        'title',
        'Voucher SAVE-100 (Front shop offer) takes Rs 100.00 off the next non-drug item you add.'
      );
      expect(within(searchColumn()).queryByText(/SAVE-100 applied/)).not.toBeInTheDocument();
      // The panel closed and focus is back in search, ready for the item.
      expect(screen.queryByLabelText('Voucher code')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Scan or search')).toHaveFocus();
      fireEvent.click(within(line).getByRole('button', { name: 'Remove voucher' }));
      expect(within(nextItemControls()).getByRole('button', { name: 'Voucher' })).toBeEnabled();
      scan();
      await waitFor(() => expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1));
      expect(mocks.mutations.addLine).toHaveBeenCalledWith(
        expect.not.objectContaining({ voucherId: expect.anything() })
      );
    });

    it('shows a held discount as one short line with its remove action on the bill side', async () => {
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      fireEvent.click(within(nextItemControls()).getByRole('button', { name: 'Discount' }));
      fireEvent.change(screen.getByLabelText('Discount (%)'), { target: { value: '10' } });
      fireEvent.click(screen.getByRole('button', { name: 'Apply to next item' }));
      const line = await within(nextItemControls()).findByRole('status');
      expect(line).toHaveTextContent('10% off the next item');
      expect(line).toHaveAttribute('title', 'A discount of 10% comes off the next item you add.');
      expect(within(searchColumn()).queryByText('10% off the next item')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Discount (%)')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Scan or search')).toHaveFocus();
      fireEvent.click(within(line).getByRole('button', { name: 'Remove discount' }));
      expect(within(nextItemControls()).getByRole('button', { name: 'Discount' })).toBeEnabled();
      scan();
      await waitFor(() => expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1));
      expect(mocks.mutations.addLine).toHaveBeenCalledWith(
        expect.not.objectContaining({ discountMinor: expect.anything() })
      );
    });

    it.each([
      ['Voucher', 'Voucher code'],
      ['Discount', 'Discount (%)'],
    ])('the %s panel closes with Escape and focus returns to search', async (button, field) => {
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      expect(screen.getByLabelText('Scan or search')).toHaveFocus();
      fireEvent.click(within(nextItemControls()).getByRole('button', { name: button }));
      const input = screen.getByLabelText(field);
      await waitFor(() => expect(input).toHaveFocus());
      fireEvent.keyDown(input, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByLabelText(field)).not.toBeInTheDocument());
      await waitFor(() => expect(screen.getByLabelText('Scan or search')).toHaveFocus());
    });

    it('keeps the search help beside the heading, not between the box and its results', () => {
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      const help = document.getElementById('counter-search-help')!;
      const heading = within(searchColumn()).getByRole('heading', { name: 'Scan or search' });
      expect(help.parentElement).toBe(heading.parentElement);
      expect(screen.getByLabelText('Scan or search')).toHaveAttribute(
        'aria-describedby',
        'counter-search-help'
      );
      expect(help).toHaveTextContent('F2 focuses search.');
    });

    it('is not offered while the drawer still has to be opened', () => {
      closeDrawer();
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      expect(screen.getByRole('button', { name: 'Open drawer' })).toBeInTheDocument();
      expect(
        screen.queryByRole('group', { name: 'Voucher and discount for the next item' })
      ).not.toBeInTheDocument();
    });
  });

  it('reads the scanner Enter value even before a change render commits', async () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.keyDown(screen.getByLabelText('Scan or search'), {
      key: 'Enter',
      target: { value: '123456' },
    });
    await screen.findByText('1 × Paracetamol added.');
    expect(mocks.searchQuery).toHaveBeenCalledExactlyOnceWith(
      {
        branchId: 'branch-a',
        query: '123456',
      },
      { staleTime: 10_000 }
    );
  });

  // DEV-90: shelf stickers name one lot; a scan never bills a different batch silently.
  const labelLot = (overrides: Partial<NonNullable<CounterSearchRow['labelLot']>> = {}) => ({
    inventoryLotId: 'lot-label',
    batchNumber: 'B-LABEL',
    expiresAt: '2027-01-01T00:00:00.000Z',
    printedMrpMinor: 10000,
    sellableUnits: 10,
    blockedBy: null,
    ...overrides,
  });

  it('clears the selection and adds nothing when the shelf-label batch cannot be sold', async () => {
    mocks.searchQuery.mockResolvedValue({
      rows: [barcodeRow({ labelLot: labelLot({ sellableUnits: 0, blockedBy: 'RECALLED' }) })],
      truncated: false,
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    scan('7100000000000411');
    await screen.findByText(/Batch B-LABEL on this shelf label cannot be sold: it is recalled/);
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Add to cart/ })).not.toBeInTheDocument();
  });

  it('stages a non-FEFO shelf-label batch as an override and waits for a reason', async () => {
    mocks.searchQuery.mockResolvedValue({
      rows: [barcodeRow({ labelLot: labelLot() })],
      truncated: false,
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    scan('7100000000000411');
    await screen.findByText(/Shelf label batch B-LABEL is not the batch FEFO sells first/);
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Add to cart/ })).toBeInTheDocument();
  });

  it('adds a shelf-label scan straight away when its batch is the FEFO batch', async () => {
    mocks.searchQuery.mockResolvedValue({
      rows: [barcodeRow({ labelLot: labelLot({ inventoryLotId: 'lot-a', batchNumber: 'B-1' }) })],
      truncated: false,
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    scan('7100000000000411');
    await screen.findByText('1 × Paracetamol added.');
    expect(mocks.mutations.addLine).toHaveBeenCalledWith(
      expect.objectContaining({ shelfLabelLotId: 'lot-a' })
    );
    expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
      expect.not.objectContaining({ override: expect.anything() })
    );
  });

  it('drops the shelf-label lot pin when the operator picks another batch', async () => {
    mocks.queries.counterLotOptions = query([
      {
        inventoryLotId: 'lot-a',
        batchNumber: 'B-1',
        expiresAt: '2028-01-01',
        sellableUnits: 10,
        blockedBy: null,
      },
      {
        inventoryLotId: 'lot-b',
        batchNumber: 'B-2',
        expiresAt: '2028-06-01',
        sellableUnits: 10,
        blockedBy: null,
      },
    ]);
    mocks.searchQuery.mockResolvedValue({
      rows: [barcodeRow({ labelLot: labelLot() })],
      truncated: false,
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    scan('7100000000000411');
    await screen.findByText(/Shelf label batch B-LABEL is not the batch FEFO sells first/);
    fireEvent.click(screen.getByRole('radio', { name: /Batch B-2/ }));
    fireEvent.change(screen.getByLabelText('Override reason'), {
      target: { value: 'Patient request' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add to cart/ }));
    await waitFor(() => expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1));
    const line = mocks.mutations.addLine!.mock.calls[0]![0];
    expect(line).not.toHaveProperty('shelfLabelLotId');
    expect(line.override).toEqual(expect.objectContaining({ inventoryLotId: 'lot-b' }));
  });

  it('keeps the shelf-label lot pin while the batch picker is merely opened', async () => {
    const pinned = barcodeRow({
      labelLot: labelLot({ inventoryLotId: 'lot-a', batchNumber: 'B-1' }),
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() => mocks.searchProps.mock.lastCall![0].onSelect(pinned));
    fireEvent.click(screen.getByRole('button', { name: 'Sell a different batch' }));
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: /Add to cart/ }));
    await screen.findByText('1 × Paracetamol added.');
    await waitFor(() => expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1));
    expect(mocks.mutations.addLine!.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ shelfLabelLotId: 'lot-a' })
    );
  });

  it('drops the shelf-label lot pin when the operator picks another batch', async () => {
    mocks.queries.counterLotOptions = query([
      {
        inventoryLotId: 'lot-a',
        batchNumber: 'B-1',
        expiresAt: '2028-01-01',
        sellableUnits: 10,
        blockedBy: null,
      },
      {
        inventoryLotId: 'lot-b',
        batchNumber: 'B-2',
        expiresAt: '2028-06-01',
        sellableUnits: 10,
        blockedBy: null,
      },
    ]);
    mocks.searchQuery.mockResolvedValue({
      rows: [barcodeRow({ labelLot: labelLot() })],
      truncated: false,
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    scan('7100000000000411');
    await screen.findByText(/Shelf label batch B-LABEL is not the batch FEFO sells first/);
    fireEvent.click(screen.getByRole('radio', { name: /Batch B-2/ }));
    fireEvent.change(screen.getByLabelText('Override reason'), {
      target: { value: 'Patient request' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add to cart/ }));
    await waitFor(() => expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1));
    const line = mocks.mutations.addLine!.mock.calls[0]![0];
    expect(line).not.toHaveProperty('shelfLabelLotId');
    expect(line.override).toEqual(expect.objectContaining({ inventoryLotId: 'lot-b' }));
  });

  it('does not carry a staged shelf-label lot into the next product-barcode scan', async () => {
    mocks.searchQuery
      .mockResolvedValueOnce({ rows: [barcodeRow({ labelLot: labelLot() })], truncated: false })
      .mockResolvedValueOnce({ rows: [barcodeRow()], truncated: false });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    scan('7100000000000411');
    await screen.findByText(/Shelf label batch B-LABEL is not the batch FEFO sells first/);
    scan('8964000000012');
    await screen.findByText('1 × Paracetamol added.');
    expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
      expect.not.objectContaining({ shelfLabelLotId: expect.anything() })
    );
    expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
      expect.not.objectContaining({ override: expect.anything() })
    );
  });

  it.each(['complete', 'missing reason'])(
    'does not reuse a previous batch override with a %s reason',
    async (reason) => {
      mocks.queries.counterLotOptions = query([
        {
          inventoryLotId: 'lot-a',
          batchNumber: 'B-1',
          expiresAt: '2028-01-01',
          sellableUnits: 10,
          blockedBy: null,
        },
        {
          inventoryLotId: 'lot-b',
          batchNumber: 'B-2',
          expiresAt: '2028-06-01',
          sellableUnits: 10,
          blockedBy: null,
        },
      ]);
      mocks.searchQuery.mockResolvedValue({
        rows: [barcodeRow({ medicineId: 'next-medicine', displayName: 'Next medicine' })],
        truncated: false,
      });
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      act(() => mocks.searchProps.mock.lastCall![0].onSelect(barcodeRow()));
      fireEvent.click(screen.getByRole('button', { name: 'Sell a different batch' }));
      fireEvent.click(screen.getByRole('radio', { name: /Batch B-2/ }));
      if (reason === 'complete')
        fireEvent.change(screen.getByLabelText('Override reason'), {
          target: { value: 'Patient request' },
        });
      scan();
      await screen.findByText('1 × Next medicine added.');
      expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ medicineId: 'next-medicine' })
      );
      expect(mocks.mutations.addLine!.mock.calls[0]![0]).not.toHaveProperty('override');
      expect(screen.queryByLabelText('Override reason')).not.toBeInTheDocument();
    }
  );

  it.each(['edit', 'branch', 'unmount'])('discards a pending scan after %s', async (change) => {
    let resolveSearch!: (value: unknown) => void;
    mocks.searchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        })
    );
    mocks.queries.counterBranches = query({
      branches: [
        { id: 'branch-a', name: 'A' },
        { id: 'branch-b', name: 'B' },
      ],
    });
    const view = render(
      <PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />
    );
    const search = scan();
    await waitFor(() => expect(mocks.searchQuery).toHaveBeenCalledTimes(1));
    if (change === 'edit') fireEvent.change(search, { target: { value: 'other medicine' } });
    if (change === 'branch')
      fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch-b' } });
    if (change === 'unmount') view.unmount();
    await act(async () => {
      resolveSearch({ rows: [barcodeRow()], truncated: false });
    });
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
    expect(mocks.searchSetData).not.toHaveBeenCalled();
  });

  it('keeps a single scan in flight until its add finishes', async () => {
    let resolveSearch!: (value: unknown) => void;
    mocks.searchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        })
    );
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = scan();
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(mocks.searchQuery).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolveSearch({ rows: [barcodeRow()], truncated: false });
    });
    await screen.findByText('1 × Paracetamol added.');
    expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1);
    expect(search).toBeEnabled();
  });

  it('allows a newer barcode to replace a pending scan and ignores the old result', async () => {
    let resolveOldSearch!: (value: unknown) => void;
    mocks.searchQuery.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldSearch = resolve;
        })
    );
    mocks.searchQuery.mockResolvedValue({
      rows: [barcodeRow({ medicineId: 'new-medicine', displayName: 'New medicine' })],
      truncated: false,
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    scan();
    await waitFor(() => expect(mocks.searchQuery).toHaveBeenCalledTimes(1));
    scan('654321');
    await screen.findByText('1 × New medicine added.');
    await act(async () => {
      resolveOldSearch({ rows: [barcodeRow()], truncated: false });
    });
    expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ medicineId: 'new-medicine' })
    );
  });

  it('retries the same barcode on a new branch while the cancelled lookup is still pending', async () => {
    let resolveOldSearch!: (value: unknown) => void;
    mocks.searchQuery.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldSearch = resolve;
        })
    );
    mocks.searchQuery.mockResolvedValue({
      rows: [barcodeRow({ medicineId: 'branch-b-medicine', displayName: 'Branch B medicine' })],
      truncated: false,
    });
    mocks.mutations.create!.mockResolvedValue({ id: 'sale-b' });
    mocks.queries.counterBranches = query({
      branches: [
        { id: 'branch-a', name: 'A' },
        { id: 'branch-b', name: 'B' },
      ],
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    scan();
    await waitFor(() => expect(mocks.searchQuery).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch-b' } });
    scan();
    await waitFor(() =>
      expect(mocks.searchQuery).toHaveBeenLastCalledWith(
        { branchId: 'branch-b', query: '123456' },
        { staleTime: 10_000 }
      )
    );
    await screen.findByText('1 × Branch B medicine added.');
    await act(async () => {
      resolveOldSearch({ rows: [barcodeRow()], truncated: false });
    });
    expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ medicineId: 'branch-b-medicine' })
    );
  });

  it('shows lookup failures and releases the scan field for a retry', async () => {
    mocks.searchQuery.mockRejectedValueOnce(new Error('Search unavailable.'));
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = scan();
    await screen.findByText('Search unavailable.');
    expect(search).toBeEnabled();
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
    scan();
    await screen.findByText('1 × Paracetamol added.');
  });

  it.each(['VERIFIED', 'FLAGGED', 'NOT_VERIFIABLE'])(
    'allows an advisory %s GS1 scan',
    async (status) => {
      mocks.mutations.authenticatePack!.mockResolvedValue({
        status,
        explanation: 'Pack authentication advice.',
        parsed: { gtin: '01234567890128' },
      });
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      scan(gs1);
      await screen.findByText('1 × Paracetamol added.');
      expect(mocks.searchQuery).toHaveBeenCalledExactlyOnceWith(
        { branchId: 'branch-a', query: '01234567890128' },
        { staleTime: 10_000 }
      );
      expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1);
    }
  );

  describe('DEV-889 scanned-pack first-expiry approval', () => {
    const payload = `${gs1}(21)SERIAL-889`;
    function preparePack() {
      const row = barcodeRow();
      mocks.searchQuery.mockResolvedValue({
        rows: [{ ...row, saleUnits: [{ ...row.saleUnits[0]!, kind: 'PACK' }] }],
        truncated: false,
      });
      mocks.mutations.authenticatePack!.mockResolvedValue({
        status: 'VERIFIED',
        explanation: 'Pack verified.',
        parsed: { gtin: '01234567890128', serial: 'SERIAL-889' },
      });
      mocks.scannedPackApprovers.mockResolvedValue([
        { id: 'staff-manager', name: 'Manager', self: false },
      ]);
      mocks.mutations.addLine!.mockRejectedValueOnce(new Error('SERIAL_FEFO_APPROVAL_REQUIRED'));
    }

    it.each([false, true])(
      'retries exactly the refused pack with a fresh PIN (self: %s)',
      async (self) => {
        preparePack();
        mocks.scannedPackApprovers.mockResolvedValue([
          { id: 'staff-manager', name: self ? 'Owner' : 'Manager', self },
        ]);
        render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
        scan(payload);
        const dialog = await screen.findByRole('dialog', { name: 'Approve this scanned pack?' });
        expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1);
        expect(mocks.scannedPackApprovers).toHaveBeenCalledWith({ branchId: 'branch-a' });
        const confirm = within(dialog).getByRole('button', { name: 'Approve pack' });
        expect(confirm).toBeDisabled();
        await within(dialog).findByRole('option', { name: self ? 'Owner (you)' : 'Manager' });
        fireEvent.change(within(dialog).getByLabelText('Approving manager or owner'), {
          target: { value: 'staff-manager' },
        });
        fireEvent.change(within(dialog).getByLabelText('Approver PIN'), {
          target: { value: '12' },
        });
        expect(confirm).toBeDisabled();
        fireEvent.change(within(dialog).getByLabelText('Approver PIN'), {
          target: { value: '975310' },
        });
        fireEvent.click(confirm);
        await screen.findByText('1 × Paracetamol added.');
        const [first, second] = mocks.mutations.addLine!.mock.calls.map(([input]) => input);
        expect(second).toEqual({
          ...first,
          scannedPack: { payload, approval: { staffProfileId: 'staff-manager', pin: '975310' } },
        });
        expect(second).toMatchObject({ saleId: 'sale-a', saleUnit: 'PACK', quantity: 1 });
        expect(mocks.mutations.addLine).toHaveBeenCalledTimes(2);
        for (const value of Object.values(window.localStorage))
          expect(value).not.toContain('975310');
      }
    );

    it('cancels without retrying the refused sale', async () => {
      preparePack();
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      scan(payload);
      const dialog = await screen.findByRole('dialog', { name: 'Approve this scanned pack?' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('1 × Paracetamol added.')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Scan or search')).toBeEnabled();
    });

    it('discards a refused PIN and requires a fresh PIN on the next scan', async () => {
      preparePack();
      // The server refuses a wrong PIN deliberately (FORBIDDEN), so its words are shown (DEV-860).
      mocks.mutations.addLine!.mockRejectedValueOnce(
        Object.assign(new Error('PIN refused.'), { data: { code: 'FORBIDDEN' } })
      );
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      scan(payload);
      const dialog = await screen.findByRole('dialog', { name: 'Approve this scanned pack?' });
      await within(dialog).findByRole('option', { name: 'Manager' });
      fireEvent.change(within(dialog).getByLabelText('Approving manager or owner'), {
        target: { value: 'staff-manager' },
      });
      fireEvent.change(within(dialog).getByLabelText('Approver PIN'), {
        target: { value: '975310' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Approve pack' }));
      await screen.findByText('PIN refused.');
      expect(mocks.mutations.addLine).toHaveBeenCalledTimes(2);
      expect(screen.queryByText('1 × Paracetamol added.')).not.toBeInTheDocument();
      mocks.mutations.addLine!.mockRejectedValueOnce(new Error('SERIAL_FEFO_APPROVAL_REQUIRED'));
      scan(payload);
      const next = await screen.findByRole('dialog', { name: 'Approve this scanned pack?' });
      expect(within(next).getByLabelText('Approver PIN')).toHaveValue('');
      expect(within(next).getByRole('button', { name: 'Approve pack' })).toBeDisabled();
      expect(mocks.mutations.addLine).toHaveBeenLastCalledWith(
        expect.objectContaining({ scannedPack: { payload } })
      );
    });

    it('shows approver failures, allows a retry, and blocks approval with no eligible PIN', async () => {
      preparePack();
      mocks.scannedPackApprovers
        .mockRejectedValueOnce(new Error('Unavailable'))
        .mockResolvedValueOnce([]);
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      scan(payload);
      const dialog = await screen.findByRole('dialog', { name: 'Approve this scanned pack?' });
      await within(dialog).findByText('Approvers could not be loaded.');
      expect(within(dialog).getByRole('button', { name: 'Approve pack' })).toBeDisabled();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
      await within(dialog).findByText(/No manager or owner has an active staff PIN/);
      // DEV-931: the notice says where a manager or owner creates their own PIN.
      expect(within(dialog).getByRole('link', { name: 'Set up your PIN' })).toHaveAttribute(
        'href',
        '/pharmacy/settings/pin'
      );
      expect(within(dialog).getByRole('button', { name: 'Approve pack' })).toBeDisabled();
      expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1);
    });

    it('keeps earliest-expiry packs on the normal scan path', async () => {
      preparePack();
      mocks.mutations.addLine!.mockReset().mockResolvedValue({});
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      scan(payload);
      await screen.findByText('1 × Paracetamol added.');
      expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          scannedPack: { payload },
        })
      );
      expect(mocks.scannedPackApprovers).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('keeps a recalled GS1 pack blocked even if another lot of that medicine is saleable', async () => {
    mocks.mutations.authenticatePack!.mockResolvedValue({
      status: 'BLOCKED_RECALL',
      explanation: 'This batch is under recall.',
      parsed: { gtin: '01234567890128' },
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = scan(gs1);
    await screen.findByText('This batch is under recall.');
    expect(search).toBeEnabled();
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
  });

  it.each(['barcode', 'GS1', 'manual'])(
    'requires authorization for the current controlled %s row',
    async (entry) => {
      const row = barcodeRow();
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      scan();
      await screen.findByText('1 × Paracetamol added.');
      mocks.mutations.addLine!.mockClear();
      const controlledRow = {
        ...row,
        medicineId: 'controlled-medicine',
        restriction: { ...row.restriction, controlled: true },
      };
      mocks.searchQuery.mockResolvedValue({ rows: [controlledRow], truncated: false });
      if (entry === 'manual') {
        act(() => mocks.searchProps.mock.lastCall![0].onSelect(controlledRow));
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '1' } });
        fireEvent.click(screen.getByRole('button', { name: /Add to cart/ }));
      } else scan(entry === 'GS1' ? gs1 : '654321');
      await screen.findByText(/Controlled medicine needs the patient address/);
      expect(mocks.mutations.addLine).not.toHaveBeenCalled();
    }
  );

  it.each(['prescription', 'emergency'])(
    'sends %s authorization for a controlled scan and clears the PIN',
    async (authorization) => {
      const row = barcodeRow();
      mocks.searchQuery.mockResolvedValue({
        rows: [{ ...row, restriction: { ...row.restriction, controlled: true } }],
        truncated: false,
      });
      mocks.queries.counterPatientPanel = query({
        patientId: 'patient-a',
        displayName: 'Patient',
        address: 'Patient address',
        dispensingConsent: true,
        prescriptions: [],
        cnic: null,
        phone: null,
      });
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      act(stageControlledMedicine);
      act(() => {
        const props = mocks.rxPanelProps.mock.lastCall![0];
        props.onSelectPatient('patient-a');
        props.controlled!.onChange('staffProfileId', 'pharmacist-a');
        props.controlled!.onChange('pin', '1234');
        if (authorization === 'prescription')
          props.controlled!.onChange('prescriptionLineId', 'rx-line-a');
        else {
          props.controlled!.onChange('emergency', true);
          props.controlled!.onChange('prescriberName', 'Prescriber');
        }
      });
      // DEV-977B: a scan adds in one step and leaves no line form; the authorization panel then
      // stays for the controlled line the bill now holds, read back after the add.
      const added = mocks.mutations.addLine!.getMockImplementation() as
        ((...args: unknown[]) => unknown) | undefined;
      mocks.mutations.addLine!.mockImplementation(async (...args: unknown[]) => {
        mocks.queries.counterCart!.data = cart({
          lines: [{ ...cart().lines[0]!, controlled: true }],
        });
        return added ? added(...args) : {};
      });
      scan();
      await screen.findByText('1 × Paracetamol added.');
      expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          controlledAuthorization: expect.objectContaining({
            patientId: 'patient-a',
            patientAddress: 'Patient address',
            staffProfileId: 'pharmacist-a',
            pin: '1234',
            ...(authorization === 'prescription'
              ? { prescriptionLineId: 'rx-line-a' }
              : { emergency: true, prescriberName: 'Prescriber' }),
          }),
        })
      );
      expect(mocks.rxPanelProps.mock.lastCall![0].controlled!.pin).toBe('');
    }
  );

  it('DEV-629: adds a prescription-only scan without a reference when the patient has none', async () => {
    const row = barcodeRow();
    mocks.searchQuery.mockResolvedValue({
      rows: [{ ...row, restriction: { ...row.restriction, rx: true, otc: false } }],
      truncated: false,
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    scan();
    await screen.findByText('1 × Paracetamol added.');
    expect(mocks.mutations.addLine).toHaveBeenCalledOnce();
    expect(mocks.mutations.addLine!.mock.calls[0]![0]).not.toHaveProperty('prescription');
  });

  it('DEV-629: sends the patient current prescription line with a prescription-only scan', async () => {
    const row = barcodeRow();
    mocks.searchQuery.mockResolvedValue({
      rows: [{ ...row, restriction: { ...row.restriction, rx: true, otc: false } }],
      truncated: false,
    });
    const rxLine = (id: string, presentationId: string) => ({
      prescriptionLineId: id,
      medicineId: row.medicineId,
      presentationId,
      verified: true,
      remainingAuthorizedUnits: 10,
    });
    mocks.queries.counterPatientPanel = query({
      patientId: 'patient-a',
      displayName: 'Patient',
      address: 'Patient address',
      dispensingConsent: true,
      prescriptions: [
        { inDate: false, lines: [rxLine('rx-line-expired', row.presentationId)] },
        {
          inDate: true,
          lines: [
            rxLine('rx-line-other-form', 'presentation-b'),
            rxLine('rx-line-a', row.presentationId),
          ],
        },
      ],
      cnic: null,
      phone: null,
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() => mocks.rxPanelProps.mock.lastCall![0].onSelectPatient('patient-a'));
    scan();
    await screen.findByText('1 × Paracetamol added.');
    expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        prescription: { prescriptionLineId: 'rx-line-a', patientId: 'patient-a' },
        controlledAuthorization: undefined,
      })
    );
  });
});

describe('DEV-712 the counter advances to a new bill after payment', () => {
  const settled = () =>
    cart({
      status: 'COMPLETED',
      receiptNumber: 42,
      totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 25000 },
    });

  function scan(value = '123456') {
    const search = screen.getByLabelText('Scan or search');
    fireEvent.change(search, { target: { value } });
    fireEvent.keyDown(search, { key: 'Enter' });
  }

  beforeEach(() => {
    mocks.queries.counterSearch = query({ rows: [barcodeRow()], truncated: false });
    mocks.mutations.create!.mockResolvedValue({ id: 'sale-b' });
    mocks.mutations.addLine!.mockResolvedValue({});
  });

  it('pays, then puts the very next scan on a new bill without a refresh', async () => {
    mocks.mutations.tender!.mockResolvedValue(accepted(0));
    mocks.refetch.mockImplementation(async () => {
      Object.assign(mocks.queries.counterCart!, { data: settled(), isSuccess: true });
      return mocks.queries.counterCart;
    });
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    chooseTender('BANK_TRANSFER');
    fireEvent.change(screen.getByLabelText('Transfer reference'), {
      target: { value: 'BANK-001' },
    });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '250.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment', hidden: true }));
    await waitFor(() => expect(mocks.mutations.tender).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.receiptRefetch).toHaveBeenCalled());

    scan();

    await screen.findByText('New bill started. 1 × Paracetamol added.');
    expect(mocks.mutations.create).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch-a',
      quotation: false,
      deviceId: expect.any(String),
    });
    expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ saleId: 'sale-b', medicineId: 'med-barcode' })
    );
    expect(mocks.mutations.addLine).not.toHaveBeenCalledWith(
      expect.objectContaining({ saleId: 'sale-a' })
    );
  });

  it('re-reads a bill the server says moved on and carries the scan to a new bill', async () => {
    mocks.mutations.addLine!.mockRejectedValueOnce(refused('BAD_REQUEST', 'INVALID_STATE'));
    mocks.refetch.mockImplementationOnce(async () => {
      Object.assign(mocks.queries.counterCart!, { data: settled(), isSuccess: true });
      return mocks.queries.counterCart;
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);

    scan();

    await screen.findByText('New bill started. 1 × Paracetamol added.');
    expect(mocks.refetch).toHaveBeenCalled();
    expect(mocks.mutations.create).toHaveBeenCalledTimes(1);
    expect(mocks.mutations.addLine.mock.calls.map(([input]) => input.saleId)).toEqual([
      'sale-a',
      'sale-b',
    ]);
    expect(screen.queryByText(/Refresh the counter/)).not.toBeInTheDocument();
  });

  it('links a loyalty card scanned after payment to a new bill, not the paid one (DEV-748)', async () => {
    openTheDrawer();
    Object.assign(mocks.queries.counterCart!, { data: settled(), isSuccess: true });
    mocks.mutations.scanLoyaltyCard!.mockResolvedValue({ id: 'customer-a', displayName: 'Ayesha' });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);

    scan('DFLCABCDEFGHIJKLMNOPQRSTUVWXYZ');

    await screen.findByText('Loyalty card: Ayesha linked to this bill.');
    expect(mocks.mutations.create).toHaveBeenCalledTimes(1);
    expect(mocks.mutations.scanLoyaltyCard).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        branchId: 'branch-a',
        saleId: 'sale-b',
        cardToken: 'DFLCABCDEFGHIJKLMNOPQRSTUVWXYZ',
      })
    );
  });

  it('re-reads a bill paid on another screen and links the card to a new bill (DEV-748)', async () => {
    openTheDrawer();
    mocks.mutations
      .scanLoyaltyCard!.mockRejectedValueOnce(refused('BAD_REQUEST', 'SALE_NOT_OPEN'))
      .mockResolvedValueOnce({ id: 'customer-a', displayName: 'Ayesha' });
    mocks.refetch.mockImplementationOnce(async () => {
      Object.assign(mocks.queries.counterCart!, { data: settled(), isSuccess: true });
      return mocks.queries.counterCart;
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);

    scan('DFLCABCDEFGHIJKLMNOPQRSTUVWXYZ');

    await screen.findByText('Loyalty card: Ayesha linked to this bill.');
    expect(mocks.refetch).toHaveBeenCalled();
    expect(mocks.mutations.create).toHaveBeenCalledTimes(1);
    expect(mocks.mutations.scanLoyaltyCard.mock.calls.map(([input]) => input.saleId)).toEqual([
      'sale-a',
      'sale-b',
    ]);
  });

  it('keeps the card on its bill when the re-read still finds it open (DEV-748)', async () => {
    openTheDrawer();
    mocks.mutations.scanLoyaltyCard!.mockRejectedValueOnce(refused('BAD_REQUEST', 'SALE_NOT_OPEN'));
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);

    scan('DFLCABCDEFGHIJKLMNOPQRSTUVWXYZ');

    await waitFor(() => expect(mocks.mutations.scanLoyaltyCard).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.refetch).toHaveBeenCalled());
    expect(mocks.mutations.create).not.toHaveBeenCalled();
    expect(mocks.mutations.scanLoyaltyCard).toHaveBeenCalledTimes(1);
  });

  it('keeps the bill and shows a neutral notice when the re-read still finds it open', async () => {
    mocks.mutations.addLine!.mockRejectedValueOnce(refused('BAD_REQUEST', 'INVALID_STATE'));
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);

    scan();

    const notice = await screen.findByText(
      'That bill is no longer open: it was paid, voided or put on hold. Resume it if it is on hold, or start the next bill.'
    );
    expect(notice.closest('[role="status"]')).not.toBeNull();
    expect(mocks.mutations.create).not.toHaveBeenCalled();
    expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1);
  });

  // A bill of Rs 251.00 whose recorded tenders total `paidMinor`.
  const billPaid = (paidMinor: number) =>
    cart({
      tenders: paidMinor ? [{ tenderId: 'tender-a', type: 'CASH', amountMinor: paidMinor }] : [],
      totals: { grossMinor: 25100, discountMinor: 0, netMinor: 25100, tenderedMinor: paidMinor },
    });

  it('records a second payment of the same type and amount instead of replaying the first', async () => {
    mocks.queries.counterCart!.data = billPaid(0);
    mocks.refetch.mockImplementation(async () => {
      Object.assign(mocks.queries.counterCart!, { data: billPaid(12550), isSuccess: true });
      return mocks.queries.counterCart;
    });
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    enterPayment();
    await screen.findByText('Payment recorded.');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeEnabled()
    );
    enterPayment();
    await waitFor(() => expect(mocks.mutations.tender).toHaveBeenCalledTimes(2));
    expect(mocks.mutations.tender!.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([
      'counter-tender:sale-a:CASH:12550',
      'counter-tender:sale-a:CASH:12550:after:12550',
    ]);
  });

  function controlledScanSetup() {
    const row = barcodeRow();
    mocks.searchQuery.mockResolvedValue({
      rows: [{ ...row, restriction: { ...row.restriction, controlled: true } }],
      truncated: false,
    });
  }

  function patientPanel(patientId: string) {
    return query({
      patientId,
      displayName: `Patient ${patientId}`,
      address: 'Patient address',
      dispensingConsent: true,
      prescriptions: [],
      cnic: null,
      phone: null,
    });
  }

  function authorize() {
    const props = mocks.rxPanelProps.mock.lastCall![0];
    props.controlled!.onChange('staffProfileId', 'pharmacist-a');
    props.controlled!.onChange('pin', '1234');
    props.controlled!.onChange('prescriptionLineId', 'rx-line-b');
  }

  it('keeps a patient picked for the next customer after the bill was paid', async () => {
    controlledScanSetup();
    mocks.queries.counterCart!.data = settled();
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    mocks.queries.counterPatientPanel = patientPanel('patient-b');
    act(() => mocks.rxPanelProps.mock.lastCall![0].onSelectPatient('patient-b'));
    act(stageControlledMedicine);
    act(() => authorize());

    scan();

    await screen.findByText('New bill started. 1 × Paracetamol added.');
    expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        saleId: 'sale-b',
        controlledAuthorization: expect.objectContaining({ patientId: 'patient-b' }),
      })
    );
  });

  it("drops the paid bill's prescriber details when a new patient is kept", async () => {
    controlledScanSetup();
    mocks.queries.counterPatientPanel = patientPanel('patient-a');
    const view = render(
      <PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />
    );
    act(stageControlledMedicine);
    act(() => {
      const props = mocks.rxPanelProps.mock.lastCall![0];
      props.onSelectPatient('patient-a');
      props.controlled!.onChange('staffProfileId', 'pharmacist-a');
      props.controlled!.onChange('emergency', true);
      props.controlled!.onChange('prescriberName', 'Old prescriber');
      props.controlled!.onChange('refSerial', '77');
    });
    mocks.queries.counterCart!.data = settled();
    view.rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    mocks.queries.counterPatientPanel = patientPanel('patient-b');
    act(() => mocks.rxPanelProps.mock.lastCall![0].onSelectPatient('patient-b'));
    act(stageControlledMedicine);
    act(() => {
      const props = mocks.rxPanelProps.mock.lastCall![0];
      props.controlled!.onChange('staffProfileId', 'pharmacist-b');
      props.controlled!.onChange('pin', '1234');
      props.controlled!.onChange('prescriptionLineId', 'rx-line-b');
    });

    scan();

    await screen.findByText('New bill started. 1 × Paracetamol added.');
    const sent = mocks.mutations.addLine!.mock.calls[0]![0].controlledAuthorization;
    expect(sent).toMatchObject({
      patientId: 'patient-b',
      staffProfileId: 'pharmacist-b',
      prescriptionLineId: 'rx-line-b',
      emergency: false,
    });
    expect(sent.prescriberName).toBeUndefined();
    expect(sent.refSerial).toBeUndefined();
  });

  it('keeps a field re-entered for the new patient with the same value', async () => {
    controlledScanSetup();
    mocks.queries.counterPatientPanel = patientPanel('patient-a');
    const view = render(
      <PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />
    );
    act(stageControlledMedicine);
    act(() => {
      const props = mocks.rxPanelProps.mock.lastCall![0];
      props.onSelectPatient('patient-a');
      props.controlled!.onChange('staffProfileId', 'pharmacist-a');
      props.controlled!.onChange('rxSerialWritten', true);
    });
    mocks.queries.counterCart!.data = settled();
    view.rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    mocks.queries.counterPatientPanel = patientPanel('patient-b');
    act(() => mocks.rxPanelProps.mock.lastCall![0].onSelectPatient('patient-b'));
    act(stageControlledMedicine);
    act(() => {
      const props = mocks.rxPanelProps.mock.lastCall![0];
      props.controlled!.onChange('staffProfileId', 'pharmacist-a');
      props.controlled!.onChange('rxSerialWritten', true);
      props.controlled!.onChange('pin', '1234');
      props.controlled!.onChange('prescriptionLineId', 'rx-line-b');
    });

    scan();

    await screen.findByText('New bill started. 1 × Paracetamol added.');
    expect(mocks.mutations.addLine!.mock.calls[0]![0].controlledAuthorization).toMatchObject({
      patientId: 'patient-b',
      staffProfileId: 'pharmacist-a',
      rxSerialWritten: true,
      prescriptionLineId: 'rx-line-b',
    });
  });

  it("never carries the paid bill's patient onto the next bill", async () => {
    controlledScanSetup();
    mocks.queries.counterPatientPanel = patientPanel('patient-a');
    const view = render(
      <PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />
    );
    act(() => mocks.rxPanelProps.mock.lastCall![0].onSelectPatient('patient-a'));
    act(stageControlledMedicine);
    act(() => authorize());
    mocks.queries.counterCart!.data = settled();
    view.rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);

    scan();

    await screen.findByText(/Controlled medicine needs the patient address/);
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
  });

  it('keeps a bill held on another screen instead of replacing it', async () => {
    mocks.mutations.addLine!.mockRejectedValueOnce(refused('BAD_REQUEST', 'INVALID_STATE'));
    mocks.refetch.mockImplementationOnce(async () => {
      Object.assign(mocks.queries.counterCart!, {
        data: cart({ status: 'HELD' }),
        isSuccess: true,
      });
      return mocks.queries.counterCart;
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);

    scan();

    await screen.findByText(
      'That bill is no longer open: it was paid, voided or put on hold. Resume it if it is on hold, or start the next bill.'
    );
    expect(mocks.refetch).toHaveBeenCalled();
    expect(mocks.mutations.create).not.toHaveBeenCalled();
    expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1);
  });

  it('gives the next payment a new key after Check payment outcome confirms the last one', async () => {
    mocks.queries.counterCart!.data = billPaid(0);
    mocks.mutations.tender!.mockRejectedValueOnce(new Error('Connection lost'));
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    enterPayment();
    await screen.findByText(/Payment outcome is unknown/);
    mocks.outcomeQuery.mockResolvedValue({
      status: 'ACCEPTED',
      replayUnsafe: true,
      result: accepted(),
    });
    mocks.refetch.mockImplementation(async () => {
      Object.assign(mocks.queries.counterCart!, { data: billPaid(12550), isSuccess: true });
      return mocks.queries.counterCart;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check payment outcome' }));
    await screen.findByText('Payment recorded.');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeEnabled()
    );
    enterPayment();
    await waitFor(() => expect(mocks.mutations.tender).toHaveBeenCalledTimes(2));
    expect(mocks.mutations.tender!.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([
      'counter-tender:sale-a:CASH:12550',
      'counter-tender:sale-a:CASH:12550:after:12550',
    ]);
  });

  it('never abandons a bill whose payment outcome is still unknown', async () => {
    mocks.queries.counterCart!.data = settled();
    persistTenderAttempt(savedAttempt());
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);

    scan();

    await screen.findByText(/Payment outcome is unknown/);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(mocks.mutations.create).not.toHaveBeenCalled();
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
  });
});

describe('PharmacyCounterConsole controlled authorization visibility (QA-138)', () => {
  it('hides the controlled authorization panel from an actor who cannot dispense', () => {
    Object.assign(mocks.queries.controlledPharmacists!, {
      isSuccess: false,
      isError: true,
      error: Object.assign(new Error('Forbidden'), { data: { code: 'FORBIDDEN' } }),
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(stageControlledMedicine);
    expect(screen.queryByTestId('controlled-authorization')).toBeNull();
  });

  it('shows the controlled authorization panel to a dispenser', () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(stageControlledMedicine);
    expect(screen.getByTestId('controlled-authorization')).toBeTruthy();
  });
});

describe('PharmacyCounterConsole prescription capture access (DEV-323)', () => {
  function capture() {
    return mocks.rxPanelProps.mock.lastCall![0].canCapturePrescription;
  }

  it('does not offer prescription capture to a counter-only cashier', () => {
    mocks.entitlements.enabledModules = ['pharmacy-counter', 'pharmacy-dispensing'];
    mocks.queries.navigation = query({
      userId: 'account-a',
      organizationId: 'org-a',
      capabilities: ['pharmacy:counter'],
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(capture()).toBe(false);
  });

  it('offers prescription capture to a pharmacist with the dispensing module', () => {
    mocks.entitlements.enabledModules = ['pharmacy-counter', 'pharmacy-dispensing'];
    mocks.queries.navigation = query({
      userId: 'account-a',
      organizationId: 'org-a',
      capabilities: ['pharmacy:counter', 'pharmacy:prescriptions', 'pharmacy:dispense'],
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(capture()).toBe(true);
  });

  it('withholds capture without the dispensing module or for another member', () => {
    mocks.queries.navigation = query({
      userId: 'account-a',
      organizationId: 'org-a',
      capabilities: ['pharmacy:prescriptions'],
    });
    const { unmount } = render(
      <PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />
    );
    expect(capture()).toBe(false);
    unmount();

    mocks.entitlements.enabledModules = ['pharmacy-counter', 'pharmacy-dispensing'];
    mocks.queries.navigation = query({
      userId: 'account-b',
      organizationId: 'org-a',
      capabilities: ['pharmacy:prescriptions'],
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(capture()).toBe(false);
  });
});

describe('PharmacyCounterConsole module boundaries', () => {
  it('neither asks for approving pharmacists nor offers controlled authorization without Pharmacy Safety', () => {
    // Pharmacy Essentials sells the counter without Pharmacy Safety: no read it would refuse.
    mocks.entitlements.enabledModules = ['pharmacy-counter'];
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(mocks.queryOptions).toHaveBeenCalledWith('controlledPharmacists', { enabled: false });
    expect(mocks.queryOptions).not.toHaveBeenCalledWith('controlledPharmacists', {
      enabled: true,
    });
    expect(screen.queryByTestId('controlled-authorization')).toBeNull();
  });

  it('asks for approving pharmacists when Pharmacy Safety is licensed', () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(stageControlledMedicine);
    expect(mocks.queryOptions).toHaveBeenCalledWith('controlledPharmacists', { enabled: true });
    expect(screen.getByTestId('controlled-authorization')).toBeTruthy();
  });
});

describe('PharmacyCounterConsole browser print audit', () => {
  function renderSettledReceipt() {
    mocks.queries.counterCart!.data = cart({
      status: 'COMPLETED',
      receiptNumber: 42,
      totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 25000 },
    });
    mocks.queries.counterReceipt!.data = {
      saleId: 'sale-a',
      receiptNumber: 42,
      branchName: 'Synthetic branch',
      businessDate: '2026-11-10',
      completedAt: '2026-11-10T12:00:00.000Z',
      currency: 'PKR',
      lines: [
        {
          saleLineId: 'line-a',
          medicineName: 'Paracetamol',
          strength: null,
          presentation: 'Tablet',
          batchNumber: 'batch-a',
          expiresAt: '2027-01-01',
          saleUnit: 'UNIT',
          quantity: 1,
          canonicalUnits: 1,
          unitPriceMinor: 25000,
          discountMinor: 0,
          lineTotalMinor: 25000,
        },
      ],
      tenders: [{ tenderId: 'tender-a', type: 'CASH', amountMinor: 25000, changeGivenMinor: 0 }],
      totals: {
        grossMinor: 25000,
        discountMinor: 0,
        netMinor: 25000,
        tenderedMinor: 25000,
        changeMinor: 0,
      },
    };
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const props = mocks.receiptProps.mock.calls.at(-1)![0] as {
      onPrint: () => Promise<boolean>;
    };
    return props.onPrint;
  }

  it.each(['Allow pop-ups for this site.', 'The print window is no longer available.'])(
    'audits preflight failure without allocating and preserves the first successful original: %s',
    async (message) => {
      browserPrint.ready.mockImplementationOnce(() => {
        throw new Error(message);
      });
      let onPrint = renderSettledReceipt();
      await act(async () => {
        expect(await onPrint()).toBe(false);
      });
      expect(mocks.mutations.counterReceiptBrowserPrint).not.toHaveBeenCalled();
      expect(mocks.printReceipt).not.toHaveBeenCalled();
      expect(mocks.mutations.counterReceiptBrowserPrintDispatched).not.toHaveBeenCalled();
      expect(mocks.mutations.counterReceiptBrowserPrintFailed).toHaveBeenCalledExactlyOnceWith({
        branchId: 'branch-a',
        saleId: 'sale-a',
        locale: 'en',
      });
      onPrint = (mocks.receiptProps.mock.calls.at(-1)![0] as { onPrint: () => Promise<boolean> })
        .onPrint;
      await act(async () => {
        expect(await onPrint()).toBe(true);
      });
      expect(mocks.mutations.counterReceiptBrowserPrint).toHaveBeenCalledTimes(1);
      expect(mocks.printReceipt).toHaveBeenCalledWith(
        expect.objectContaining({ saleId: 'sale-a' }),
        'en',
        expect.any(String),
        false,
        expect.anything()
      );
    }
  );

  it('keeps the unconfirmed-printing notice until dismissed (DEV-910)', async () => {
    mocks.mutations.counterReceiptBrowserPrint!.mockResolvedValue({
      copyNumber: 1,
      reprint: false,
    });
    const onPrint = renderSettledReceipt();
    vi.useFakeTimers();
    try {
      await act(async () => {
        expect(await onPrint()).toBe(true);
      });
      expect(screen.getByText(/Physical printing is not confirmed/)).toBeInTheDocument();
      await act(async () => vi.advanceTimersByTime(6000));
      expect(screen.getByText(/Physical printing is not confirmed/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByText(/Physical printing is not confirmed/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('audits invalid receipt rendering without allocating a copy', async () => {
    const onPrint = renderSettledReceipt();
    // The same source is read by the print callback; make it non-dispatchable.
    (mocks.queries.counterReceipt!.data as CounterReceipt).lines = [];
    await act(async () => {
      expect(await onPrint()).toBe(false);
    });
    expect(mocks.mutations.counterReceiptBrowserPrint).not.toHaveBeenCalled();
    expect(mocks.printReceipt).not.toHaveBeenCalled();
    expect(mocks.mutations.counterReceiptBrowserPrintFailed).toHaveBeenCalledTimes(1);
  });

  it('keeps a successful dialog handoff when audit recording fails and retries it idempotently', async () => {
    mocks.printReceipt.mockReset();
    browserPrint.cancel.mockReset();
    mocks.mutations
      .counterReceiptBrowserPrint!.mockResolvedValueOnce({ copyNumber: 1, reprint: false })
      .mockResolvedValueOnce({ copyNumber: 2, reprint: true });
    mocks.mutations
      .counterReceiptBrowserPrintDispatched!.mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ recorded: true });

    let onPrint = renderSettledReceipt();
    let printed: boolean | undefined;
    await act(async () => {
      printed = await onPrint();
    });

    // The dialog opened, so the print is reported as successful, not failed.
    expect(printed).toBe(true);
    expect(mocks.printReceipt).toHaveBeenCalledTimes(1);
    expect(browserPrint.cancel).not.toHaveBeenCalled();
    expect(screen.queryByText('network down')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.mutations.counterReceiptBrowserPrintDispatched).toHaveBeenCalledTimes(1)
    );

    // The pending event is retried for the same copy rather than re-allocated.
    onPrint = (mocks.receiptProps.mock.calls.at(-1)![0] as { onPrint: () => Promise<boolean> })
      .onPrint;
    await act(async () => {
      await onPrint();
    });
    await waitFor(() =>
      expect(mocks.mutations.counterReceiptBrowserPrintDispatched).toHaveBeenCalledTimes(3)
    );
    const recorded = mocks.mutations.counterReceiptBrowserPrintDispatched!.mock.calls.map(
      ([input]) => (input as { copyNumber: number }).copyNumber
    );
    expect(recorded.filter((copy) => copy === 1)).toHaveLength(2);
    expect(recorded.filter((copy) => copy === 2)).toHaveLength(1);
    expect(mocks.mutations.counterReceiptBrowserPrint).toHaveBeenCalledTimes(2);
  });
});
describe('PharmacyCounterConsole search latency (DEV-575)', () => {
  function lastSearchOptions() {
    return mocks.queryOptions.mock.calls.filter(([name]) => name === 'counterSearch').at(-1)?.[1];
  }

  beforeEach(() => {
    mocks.queries.counterSearch = query({ rows: [barcodeRow()], truncated: false });
    mocks.mutations.addLine!.mockResolvedValue({});
  });

  afterEach(() => vi.useRealTimers());

  it('adds 50 consecutive digit bursts as distinct operations with one warm catalogue lookup', async () => {
    const row = barcodeRow({ onHandUnits: 100 });
    mocks.searchQuery.mockResolvedValue({ rows: [row], truncated: false });
    const keys = new Set<string>();
    mocks.mutations.addLine!.mockImplementation(async ({ idempotencyKey }) => {
      keys.add(idempotencyKey);
      return {};
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    const code = '8964000123456';
    const timings: number[] = [];
    for (let scan = 0; scan < 50; scan += 1) {
      const start = performance.now();
      for (let length = 1; length <= code.length; length += 1) {
        expect(search).toBeEnabled();
        fireEvent.change(search, { target: { value: code.slice(0, length) } });
      }
      expect(search).toHaveValue(code);
      await act(async () => {
        fireEvent.keyDown(search, { key: 'Enter' });
      });
      expect(search).toHaveValue('');
      expect(mocks.mutations.addLine).toHaveBeenCalledTimes(scan + 1);
      timings.push(performance.now() - start);
    }
    console.info(
      'DEV-575 local component fixture:',
      JSON.stringify({
        scans: timings.length,
        uniqueWrites: keys.size,
        lookups: mocks.searchQuery.mock.calls.length,
        p95Ms: [...timings].sort((a, b) => a - b)[47],
        maxMs: Math.max(...timings),
      })
    );
    expect(keys.size).toBe(50);
    expect(mocks.searchQuery).toHaveBeenCalledExactlyOnceWith(
      { branchId: 'branch-a', query: code },
      { staleTime: 10_000 }
    );
  }, 30_000);

  it('keeps a failed allocation key for an explicit retry, then rotates it after success', async () => {
    mocks.mutations
      .addLine!.mockRejectedValueOnce(new Error('Response lost.'))
      .mockResolvedValue({});
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    for (let index = 0; index < 3; index += 1) {
      fireEvent.change(search, { target: { value: '8964000123456' } });
      await act(async () => fireEvent.keyDown(search, { key: 'Enter' }));
    }
    const keys = mocks.mutations.addLine!.mock.calls.map(([input]) => input.idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('drops warm catalogue hints after a refused write and reads current restrictions on retry', async () => {
    mocks.searchQuery.mockResolvedValue({ rows: [barcodeRow()], truncated: false });
    mocks.mutations
      .addLine!.mockResolvedValueOnce({})
      .mockResolvedValueOnce({ blocked: 'Stock changed.' });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    for (let index = 0; index < 2; index += 1) {
      fireEvent.change(search, { target: { value: '8964000123456' } });
      await act(async () => fireEvent.keyDown(search, { key: 'Enter' }));
    }
    expect(mocks.searchQuery).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Stock changed.')).toBeInTheDocument();
    const restricted = barcodeRow();
    restricted.restriction.controlled = true;
    mocks.searchQuery.mockResolvedValue({ rows: [restricted], truncated: false });
    fireEvent.change(search, { target: { value: '8964000123456' } });
    await act(async () => fireEvent.keyDown(search, { key: 'Enter' }));
    expect(mocks.searchQuery).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Controlled medicine needs the patient address/)).toBeInTheDocument();
    expect(mocks.mutations.addLine).toHaveBeenCalledTimes(2);
  });

  function typeBurst(search: HTMLElement, code: string, from = 1) {
    // The submitted code stays selected, so each burst replaces it digit by digit.
    for (let length = from; length <= code.length; length += 1)
      fireEvent.change(search, { target: { value: code.slice(0, length) } });
  }

  function heldSaves() {
    const saves: Array<() => void> = [];
    mocks.mutations.addLine!.mockImplementation(
      () => new Promise((resolve) => saves.push(() => resolve({})))
    );
    return saves;
  }

  function rowPerCode() {
    mocks.searchQuery.mockImplementation(async ({ query }: { query: string }) => ({
      rows: [barcodeRow({ medicineId: `med-${query}`, displayName: `Item ${query}` })],
      truncated: false,
    }));
  }

  it('keeps the field live while a line saves and never clears a scan typed meanwhile', async () => {
    const saves = heldSaves();
    rowPerCode();
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    typeBurst(search, '8964000100001');
    await act(async () => fireEvent.keyDown(search, { key: 'Enter' }));
    await waitFor(() => expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1));
    expect(search).toBeEnabled();
    typeBurst(search, '8964000');
    await act(async () => saves.shift()!());
    await screen.findByText('1 × Item 8964000100001 added.');
    expect(search).toHaveValue('8964000');
    // Not selected: the scanner's next digit must extend the draft, not replace it.
    expect(document.activeElement).toBe(search);
    expect((search as HTMLInputElement).selectionStart).toBe(7);
    expect((search as HTMLInputElement).selectionEnd).toBe(7);
    typeBurst(search, '8964000100002', 8);
    await act(async () => fireEvent.keyDown(search, { key: 'Enter' }));
    await waitFor(() => expect(mocks.mutations.addLine).toHaveBeenCalledTimes(2));
    await act(async () => saves.shift()!());
    await screen.findByText('1 × Item 8964000100002 added.');
    expect(mocks.mutations.addLine!.mock.calls.map(([input]) => input.medicineId)).toEqual([
      'med-8964000100001',
      'med-8964000100002',
    ]);
    expect(search).toHaveValue('');
  });

  it('adds 50 rapid scans entered while earlier lines are still saving, in order, none dropped', async () => {
    const saves = heldSaves();
    rowPerCode();
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    const codes = Array.from({ length: 50 }, (_, index) => `89640001${10000 + index}`);
    typeBurst(search, codes[0]!);
    await act(async () => fireEvent.keyDown(search, { key: 'Enter' }));
    await waitFor(() => expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1));
    // The other 49 bursts all arrive while the first line is still saving.
    for (const code of codes.slice(1)) {
      expect(search).toBeEnabled();
      typeBurst(search, code);
      expect(search).toHaveValue(code);
      fireEvent.keyDown(search, { key: 'Enter' });
      expect(search).toHaveValue('');
    }
    expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1);
    for (let saved = 1; saved < codes.length; saved += 1) {
      await act(async () => saves.shift()!());
      await waitFor(() => expect(mocks.mutations.addLine).toHaveBeenCalledTimes(saved + 1));
    }
    await act(async () => saves.shift()!());
    await screen.findByText(`1 × Item ${codes.at(-1)} added.`);
    const calls = mocks.mutations.addLine!.mock.calls.map(([input]) => input);
    expect(calls.map((input) => input.medicineId)).toEqual(codes.map((code) => `med-${code}`));
    expect(new Set(calls.map((input) => input.idempotencyKey)).size).toBe(50);
    expect(mocks.searchQuery.mock.calls.map(([input]) => input.query)).toEqual(codes);
    expect(search).toBeEnabled();
    expect(search).toHaveValue('');
  }, 30_000);

  it('discards scans buffered behind a refused line and says which to scan again', async () => {
    let refuse!: () => void;
    mocks.mutations.addLine!.mockImplementationOnce(
      () => new Promise((resolve) => (refuse = () => resolve({ blocked: 'Stock changed.' })))
    );
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    typeBurst(search, '8964000100001');
    await act(async () => fireEvent.keyDown(search, { key: 'Enter' }));
    await waitFor(() => expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1));
    for (const code of ['8964000100002', '8964000100003']) {
      typeBurst(search, code);
      fireEvent.keyDown(search, { key: 'Enter' });
    }
    await act(async () => refuse());
    expect(
      await screen.findByText('Stock changed. 2 later scans were not added. Scan them again.')
    ).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1);
    expect(search).toBeEnabled();
  });

  it('treats a repeated Enter on the code being saved as a duplicate press', async () => {
    const saves = heldSaves();
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    typeBurst(search, '8964000123456');
    await act(async () => fireEvent.keyDown(search, { key: 'Enter' }));
    await waitFor(() => expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(search, { key: 'Enter' });
    await act(async () => saves.shift()!());
    await screen.findByText('1 × Paracetamol added.');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1);
  });

  it('never sends a typed loyalty card code to the medicine search, even after the debounce (DEV-748)', () => {
    vi.useFakeTimers();
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.change(screen.getByLabelText('Scan or search'), {
      target: { value: 'DFLCABCDEFGHIJKLMNOPQRSTUVWXYZ' },
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(
      mocks.queryInputs.mock.calls.filter(([, input]) =>
        JSON.stringify(input ?? '').includes('DFLC')
      )
    ).toEqual([]);
  });

  it('keeps the focused scan field neutral until a search fails (DEV-44)', () => {
    vi.useFakeTimers();
    const view = render(
      <PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />
    );
    const search = screen.getByLabelText('Scan or search');
    // Focused on load: no error state, and a neutral focus ring instead of the coral one.
    expect(search).toHaveFocus();
    expect(search).not.toHaveAttribute('aria-invalid');
    expect(search).toHaveClass('[--ring:var(--text-muted)]');
    expect(search).not.toHaveClass('[--ring:var(--destructive)]');

    mocks.queries.counterSearch = {
      ...query(),
      isSuccess: false,
      isError: true,
      error: new Error('Search unavailable'),
    };
    fireEvent.change(search, { target: { value: 'para' } });
    act(() => vi.advanceTimersByTime(1000));
    view.rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(mocks.searchProps.mock.lastCall![0]).toMatchObject({ state: 'error' });
    expect(search).toHaveAttribute('aria-invalid', 'true');
    expect(search).toHaveClass('[--ring:var(--destructive)]');
    expect(search).not.toHaveClass('[--ring:var(--text-muted)]');
  });

  it('re-runs a completed name search on the newly selected branch', () => {
    vi.useFakeTimers();
    mocks.queries.counterBranches = query({
      branches: [
        { id: 'branch-a', name: 'A' },
        { id: 'branch-b', name: 'B' },
      ],
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.change(screen.getByLabelText('Scan or search'), { target: { value: 'para' } });
    act(() => vi.advanceTimersByTime(150));
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch-b' } });
    const last = mocks.queryInputs.mock.calls.filter(([name]) => name === 'counterSearch').at(-1);
    expect(last?.[1]).toEqual({ branchId: 'branch-b', query: 'para' });
    expect(lastSearchOptions()).toMatchObject({ enabled: true });
    expect(mocks.searchProps.mock.lastCall![0]).not.toMatchObject({ state: 'loading' });
  });

  it('re-runs a name search whose debounce fires just before a branch change', () => {
    vi.useFakeTimers();
    mocks.queries.counterBranches = query({
      branches: [
        { id: 'branch-a', name: 'A' },
        { id: 'branch-b', name: 'B' },
      ],
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.change(screen.getByLabelText('Scan or search'), { target: { value: 'para' } });
    act(() => vi.advanceTimersByTime(100));
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch-b' } });
    act(() => vi.advanceTimersByTime(50));
    const last = mocks.queryInputs.mock.calls.filter(([name]) => name === 'counterSearch').at(-1);
    expect(last?.[1]).toEqual({ branchId: 'branch-b', query: 'para' });
    expect(lastSearchOptions()).toMatchObject({ enabled: true });
  });

  it('keeps a name typed during a save and searches it once the save finishes', async () => {
    const saves = heldSaves();
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    typeBurst(search, '8964000123456');
    await act(async () => fireEvent.keyDown(search, { key: 'Enter' }));
    await waitFor(() => expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1));
    for (const text of ['p', 'pa', 'par', 'para'])
      fireEvent.change(search, { target: { value: text } });
    await act(async () => saves.shift()!());
    await screen.findByText('1 × Paracetamol added.');
    expect(search).toHaveValue('para');
    await waitFor(() => {
      const last = mocks.queryInputs.mock.calls.filter(([name]) => name === 'counterSearch').at(-1);
      expect(last?.[1]).toEqual({ branchId: 'branch-a', query: 'para' });
      expect(lastSearchOptions()).toMatchObject({ enabled: true });
    });
    expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1);
  });

  it('adds a scan queued for a new branch after the previous branch scan was cancelled', async () => {
    mocks.queries.counterBranches = query({
      branches: [
        { id: 'branch-a', name: 'A' },
        { id: 'branch-b', name: 'B' },
      ],
    });
    mocks.mutations.create!.mockResolvedValue({ id: 'sale-b' });
    const saves = heldSaves();
    let resolveLookup!: () => void;
    mocks.searchQuery.mockImplementation(({ query: code }: { query: string }) => {
      const result = {
        rows: [barcodeRow({ medicineId: `med-${code}`, displayName: `Item ${code}` })],
        truncated: false,
      };
      return code === '8964000100002'
        ? new Promise((resolve) => (resolveLookup = () => resolve(result)))
        : Promise.resolve(result);
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    typeBurst(search, '8964000100001');
    await act(async () => fireEvent.keyDown(search, { key: 'Enter' }));
    await waitFor(() => expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1));
    typeBurst(search, '8964000100002');
    fireEvent.keyDown(search, { key: 'Enter' });
    await act(async () => saves.shift()!());
    // The queued scan's lookup is still pending when the operator changes branch.
    await waitFor(() =>
      expect(mocks.searchQuery).toHaveBeenLastCalledWith(
        { branchId: 'branch-a', query: '8964000100002' },
        { staleTime: 10_000 }
      )
    );
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch-b' } });
    typeBurst(search, '8964000100003');
    fireEvent.keyDown(search, { key: 'Enter' });
    await act(async () => resolveLookup());
    await waitFor(() => expect(mocks.mutations.addLine).toHaveBeenCalledTimes(2));
    expect(mocks.mutations.addLine!.mock.calls[1]![0]).toMatchObject({
      medicineId: 'med-8964000100003',
    });
    expect(screen.queryByText(/later scan was not added/)).not.toBeInTheDocument();
  });

  it('returns results to idle when the field is edited below two characters', () => {
    vi.useFakeTimers();
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    fireEvent.change(search, { target: { value: 'pan' } });
    act(() => vi.advanceTimersByTime(150));
    expect(mocks.searchProps.mock.lastCall![0]).toMatchObject({ query: 'pan' });
    fireEvent.change(search, { target: { value: 'p' } });
    expect(mocks.searchProps.mock.lastCall![0]).toMatchObject({ state: 'idle', query: 'p' });
    fireEvent.change(search, { target: { value: '' } });
    expect(mocks.searchProps.mock.lastCall![0]).toMatchObject({ state: 'idle', query: '' });
  });

  it('submits a typed search 150 ms after the last keystroke and aborts superseded ones', () => {
    vi.useFakeTimers();
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    fireEvent.change(search, { target: { value: 'pa' } });
    fireEvent.change(search, { target: { value: 'para' } });

    act(() => vi.advanceTimersByTime(149));
    expect(lastSearchOptions()).toMatchObject({ enabled: false });

    act(() => vi.advanceTimersByTime(1));
    expect(lastSearchOptions()).toMatchObject({
      enabled: true,
      trpc: { abortOnUnmount: true },
    });
  });

  it('never searches the digits of a scanner burst before its Enter', async () => {
    vi.useFakeTimers();
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    const code = '8964000123456';
    for (let length = 1; length <= code.length; length += 1) {
      fireEvent.change(search, { target: { value: code.slice(0, length) } });
      act(() => vi.advanceTimersByTime(10));
    }
    // A scanner that pauses before its Enter still has not searched a partial code.
    act(() => vi.advanceTimersByTime(1_000));
    expect(
      mocks.queryOptions.mock.calls.filter(
        ([name, options]) => name === 'counterSearch' && (options as { enabled: boolean }).enabled
      )
    ).toEqual([]);
    expect(mocks.searchQuery).not.toHaveBeenCalled();

    vi.useRealTimers();
    fireEvent.keyDown(search, { key: 'Enter' });
    await screen.findByText('1 × Paracetamol added.');
    expect(mocks.searchQuery).toHaveBeenCalledExactlyOnceWith(
      { branchId: 'branch-a', query: code },
      { staleTime: 10_000 }
    );
  });
});

describe('DEV-618 counter composition', () => {
  it('shows the auto-print copy only beside the auto-print checkbox, reworded', () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key: 'F9' });
    const dialog = screen.getByRole('dialog', { name: /^Take payment/ });
    const checkbox = within(dialog).getByRole('checkbox', {
      description: 'Opens the print window after each payment on this computer.',
    });
    expect(checkbox).toHaveAttribute('id', 'counter-auto-print');
    expect(within(dialog).getAllByText(/print window/i)).toHaveLength(1);
    expect(dialog).not.toHaveTextContent('This counter session only');
    expect(dialog).not.toHaveTextContent('Physical printing is not confirmed');
  });

  it.each(['F9', 'desktop', 'phone'])('uses the same payment flow from %s', async (entry) => {
    const scroll = vi.fn();
    const previous = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      if (entry === 'F9') fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key: 'F9' });
      else
        fireEvent.click(
          within(
            screen.getByLabelText(entry === 'phone' ? 'Phone payment' : 'Bill total')
          ).getByRole('button', { name: /^Take payment ?·/ })
        );
      const dialog = screen.getByRole('dialog', { name: /^Take payment/ });
      const amount = within(dialog).getByLabelText('Amount');
      await waitFor(() => expect(document.activeElement).toBe(amount.closest('[tabindex="-1"]')));
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
      enterPayment();
      await waitFor(() =>
        expect(mocks.mutations.tender).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            saleId: 'sale-a',
            branchId: 'branch-a',
            type: 'CASH',
            amountMinor: 12550,
            cashReceivedMinor: 20000,
          })
        )
      );
    } finally {
      HTMLElement.prototype.scrollIntoView = previous;
    }
  });

  it('preserves a payment draft through close/reopen and restores scan focus', async () => {
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const amount = screen.getByLabelText('Amount');
    fireEvent.change(amount, { target: { value: '81.50' } });
    fireEvent.keyDown(amount, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('Scan or search'))
    );
    fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key: 'F9' });
    expect(
      within(screen.getByRole('dialog', { name: /^Take payment/ })).getByLabelText('Amount')
    ).toHaveValue('81.50');
    expect(mocks.mutations.tender).not.toHaveBeenCalled();
  });

  it.each(['', '0', '-1', '1.5', '8.0', '1e2', 'abc', '9007199254740992'])(
    'refuses invalid tablet quantity %j on the add shortcut',
    (value) => {
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      act(() => mocks.searchProps.mock.calls.at(-1)![0].onSelect(barcodeRow()));
      const input = screen.getByLabelText('Quantity');
      fireEvent.change(input, { target: { value } });
      fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key: 'F6' });
      expect(screen.getByRole('button', { name: /Add to cart/ })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Add to cart/ })).toHaveAccessibleDescription(
        /Enter a valid quantity|Not enough stock/
      );
      expect(mocks.mutations.create).not.toHaveBeenCalled();
      expect(mocks.mutations.addLine).not.toHaveBeenCalled();
      expect(input).toHaveAccessibleDescription(
        value === '' || value === '0' ? /Enter a quantity/ : /Enter a whole number/
      );
    }
  );

  it('keeps a cleared draft empty, accepts a replacement quantity, and adds it once', async () => {
    mocks.mutations.addLine!.mockResolvedValue({ saleLineId: 'line-8' });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() => mocks.searchProps.mock.calls.at(-1)![0].onSelect(barcodeRow({ onHandUnits: 100 })));
    const input = screen.getByLabelText('Quantity') as HTMLInputElement;
    expect(input).toHaveValue('1');
    fireEvent.change(input, { target: { value: '1' } });
    input.blur();
    input.focus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(1);
    fireEvent.change(input, { target: { value: '' } });
    expect(input).toHaveValue('');
    fireEvent.change(input, { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: /Add to cart/ }));
    await waitFor(() =>
      expect(mocks.mutations.addLine).toHaveBeenCalledWith(expect.objectContaining({ quantity: 8 }))
    );
    expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1);
  });

  it('shows the stock limit and refuses an overstock quantity', () => {
    const row = barcodeRow({ onHandUnits: 5 });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() => mocks.searchProps.mock.calls.at(-1)![0].onSelect(row));
    const input = screen.getByLabelText('Quantity');
    fireEvent.change(input, { target: { value: '8' } });
    expect(input).toHaveAccessibleDescription(/Only 5 units on hand/);
    fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key: 'F6' });
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
  });

  it.each([0, 10])(
    'explains missing sale units using the selected row stock (%s)',
    (onHandUnits) => {
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      act(() =>
        mocks.searchProps.mock.calls.at(-1)![0].onSelect(barcodeRow({ saleUnits: [], onHandUnits }))
      );
      if (onHandUnits === 0) {
        expect(screen.getByText(/Out of stock/)).toHaveAttribute('role', 'status');
        expect(screen.queryByText(/pack setup does not match/)).not.toBeInTheDocument();
      } else {
        expect(screen.getByText(/pack setup does not match/)).toHaveAttribute('role', 'status');
        expect(screen.queryByText(/Out of stock/)).not.toBeInTheDocument();
      }
      expect(screen.getByRole('button', { name: /Add to cart/ })).toBeDisabled();
      expect(mocks.mutations.addLine).not.toHaveBeenCalled();
    }
  );

  it('clears the shortage draft and records only the replacement quantity', async () => {
    mocks.mutations.captureDemand!.mockResolvedValue({});
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() =>
      mocks.searchProps.mock.calls
        .at(-1)![0]
        .onSelect(barcodeRow({ saleUnits: [], onHandUnits: 0 }))
    );
    const input = screen.getByLabelText('Requested tablets') as HTMLInputElement;
    expect(input.value).toBe('1');
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    expect(screen.queryByRole('button', { name: /Record shortage:/ })).not.toBeInTheDocument();
    expect(mocks.mutations.captureDemand).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record shortage: 8 tablets' }));
    await waitFor(() =>
      expect(mocks.mutations.captureDemand).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ quantity: 8, saleUnit: 'UNIT' })
      )
    );
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
  });

  it('DEV-81 offers optional outcome chips after a shortage and records one tap', async () => {
    mocks.mutations.captureDemand!.mockResolvedValue({ id: 'demand-a' });
    mocks.mutations.setDemandOutcome!.mockResolvedValue({});
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() =>
      mocks.searchProps.mock.calls
        .at(-1)![0]
        .onSelect(barcodeRow({ saleUnits: [], onHandUnits: 0 }))
    );
    fireEvent.change(screen.getByLabelText('Requested tablets'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record shortage: 3 tablets' }));
    await waitFor(() =>
      expect(mocks.mutations.captureDemand).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ quantity: 3, requestedQty: 3, reason: 'STOCKOUT' })
      )
    );
    const chips = await screen.findByRole('region', { name: 'What happened to the short line' });
    expect(chips).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Substitute taken' }));
    await waitFor(() =>
      expect(mocks.mutations.setDemandOutcome).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          branchId: 'branch-a',
          demandId: 'demand-a',
          outcome: 'SUBSTITUTE_TAKEN',
        })
      )
    );
    expect(
      screen.queryByRole('region', { name: 'What happened to the short line' })
    ).not.toBeInTheDocument();
  });

  it('stages real metadata and quantity, switches units with F3/F4/F5, and submits the chosen batch with F6', async () => {
    const row = barcodeRow({
      brandName: 'Panadol',
      unitsPerPack: 10,
      onHandUnits: 100,
      saleUnits: [
        { kind: 'PACK', packLevelId: 'pack-a', levelLabel: 'Pack', canonicalUnitsPerSaleUnit: 10 },
        {
          kind: 'STRIP',
          packLevelId: 'strip-a',
          levelLabel: 'Strip',
          canonicalUnitsPerSaleUnit: 5,
        },
        { kind: 'UNIT', packLevelId: 'unit-a', levelLabel: 'Unit', canonicalUnitsPerSaleUnit: 1 },
      ],
    });
    mocks.queries.counterLotOptions = query([
      {
        inventoryLotId: 'lot-a',
        batchNumber: 'B-1',
        expiresAt: row.nearestSafeExpiry,
        sellableUnits: 50,
        blockedBy: null,
      },
      {
        inventoryLotId: 'lot-later',
        batchNumber: 'B-2',
        expiresAt: '2029-06-30T00:00:00.000Z',
        sellableUnits: 50,
        blockedBy: null,
      },
    ]);
    mocks.mutations.addLine!.mockResolvedValue({ saleLineId: 'added-line' });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() => mocks.searchProps.mock.calls.at(-1)![0].onSelect(row));
    const next = screen.getByRole('region', { name: 'Next line' });
    expect(next).toHaveTextContent('Panadol 500 mg');
    expect(within(next).getByText('Paracetamol')).toHaveClass('block');
    expect(next).toHaveTextContent('Batch B-1');
    expect(next).toHaveTextContent('Store A');
    expect(next).toHaveTextContent('Earliest-expiry batch B-1 is used');
    const quantity = within(next).getByLabelText('Quantity');
    expect(quantity).toHaveValue('1');
    fireEvent.change(quantity, { target: { value: '' } });
    fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key: 'F6' });
    expect(within(next).getByText('Enter a quantity')).toBeVisible();
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
    fireEvent.change(quantity, { target: { value: '1' } });
    expect(quantity).toHaveValue('1');
    expect(within(next).getByText('Covered · 100 units on hand')).toBeInTheDocument();
    for (const [key, name] of [
      ['F5', /^Tablet/],
      ['F4', /^Strip/],
      ['F3', /^Pack/],
    ] as const) {
      fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key });
      expect(within(next).getByRole('radio', { name })).toHaveAttribute('aria-checked', 'true');
    }
    fireEvent.click(within(next).getByRole('button', { name: 'Increase quantity' }));
    expect(within(next).getByLabelText('Quantity')).toHaveValue('2');
    expect(within(next).getByText('Units').nextElementSibling).toHaveTextContent('20');
    expect(within(next).getByText('Line total').nextElementSibling).toHaveTextContent('200.00');
    fireEvent.click(within(next).getByRole('button', { name: 'Sell a different batch' }));
    fireEvent.click(within(next).getByRole('radio', { name: /Batch B-2/ }));
    fireEvent.change(within(next).getByLabelText('Override reason'), {
      target: { value: 'Patient needs longer dating' },
    });
    fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key: 'F6' });
    await waitFor(() =>
      expect(mocks.mutations.addLine).toHaveBeenCalledWith(
        expect.objectContaining({
          quantity: 2,
          saleUnit: 'PACK',
          canonicalUnitsPerSaleUnit: 10,
          override: {
            inventoryLotId: 'lot-later',
            reason: 'Patient needs longer dating',
          },
        })
      )
    );
    const added = await screen.findByText('2 × Paracetamol added with a recorded batch override.');
    expect(added.closest('[role="status"]')).toBeInTheDocument();
    expect(
      added.compareDocumentPosition(screen.getByLabelText('Scan or search')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('switches F5 to the loose unit of a base-level lot and explains when none is sellable', () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() =>
      mocks.searchProps.mock.calls.at(-1)![0].onSelect(
        barcodeRow({
          saleUnits: [
            {
              kind: 'PACK',
              packLevelId: 'unit-a',
              levelLabel: 'UNIT',
              canonicalUnitsPerSaleUnit: 1,
            },
          ],
        })
      )
    );
    fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key: 'F5' });
    expect(screen.queryByText(/not sold by unit/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No loose unit/)).not.toBeInTheDocument();

    act(() =>
      mocks.searchProps.mock.calls.at(-1)![0].onSelect(
        barcodeRow({
          medicineId: 'med-sealed',
          saleUnits: [
            {
              kind: 'PACK',
              packLevelId: 'pack-a',
              levelLabel: 'BOX',
              canonicalUnitsPerSaleUnit: 10,
            },
          ],
        })
      )
    );
    fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key: 'F5' });
    expect(
      screen.getByText('No loose unit is sellable for this medicine. Sell by box.')
    ).toBeInTheDocument();
  });

  it('does not invent batch metadata when no recommended batch exists', () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() =>
      mocks.searchProps.mock.calls
        .at(-1)![0]
        .onSelect(
          barcodeRow({ recommendedLotId: null, batchNumber: null, nearestSafeExpiry: null })
        )
    );
    expect(screen.getByRole('region', { name: 'Next line' })).toHaveTextContent(
      'No batch can be sold here right now.'
    );
    expect(screen.queryByText(/batch B-1 is used/)).not.toBeInTheDocument();
  });

  it('says a medicine with no stock here is out of stock, not a pack-setup problem', () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() =>
      mocks.searchProps.mock.calls.at(-1)![0].onSelect(
        barcodeRow({
          saleUnits: [],
          onHandUnits: 0,
          recommendedLotId: null,
          batchNumber: null,
          nearestSafeExpiry: null,
        })
      )
    );
    const next = screen.getByRole('region', { name: 'Next line' });
    expect(within(next).getByRole('status')).toHaveTextContent(
      'Out of stock at this branch. Receive stock or record it as a shortage.'
    );
    expect(next).toHaveTextContent('No batch of this medicine is in stock here.');
    expect(next).not.toHaveTextContent(/pack hierarchy|pack setup|canonical|FEFO/i);
  });

  it('says blocked stock cannot be sold rather than calling it out of stock', () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() =>
      mocks.searchProps.mock.calls.at(-1)![0].onSelect(
        barcodeRow({
          saleUnits: [],
          onHandUnits: 0,
          recommendedLotId: null,
          batchNumber: null,
          nearestSafeExpiry: null,
          blocked: ['EXPIRED', 'QUARANTINED'],
        })
      )
    );
    const next = screen.getByRole('region', { name: 'Next line' });
    expect(within(next).getByRole('status')).toHaveTextContent(
      'None of the stock here can be sold right now (expired, quarantined). Receive fresh stock or record it as a shortage.'
    );
    expect(next).not.toHaveTextContent('Out of stock');
    expect(next).toHaveTextContent('No batch can be sold here right now.');
  });

  it('names the pack mismatch in shop words and links to the pack setup', () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() =>
      mocks.searchProps.mock.calls.at(-1)![0].onSelect(
        barcodeRow({
          saleUnits: [],
          onHandUnits: 100,
          packMismatch: {
            received: '1 box = 100 tablets',
            setup: '1 box = 12 strips × 10 tablets',
          },
        })
      )
    );
    const status = within(screen.getByRole('region', { name: 'Next line' })).getByRole('status');
    expect(status).toHaveTextContent(
      'This batch was received as 1 box = 100 tablets but the medicine is set up as 1 box = 12 strips × 10 tablets, so it cannot be priced. Open Medicines › Paracetamol › Packs for receiving to fix it.'
    );
    expect(
      within(status).getByRole('link', { name: 'Medicines › Paracetamol › Packs for receiving' })
    ).toHaveAttribute('href', '/pharmacy/medicines');
    expect(status).not.toHaveTextContent('Out of stock');
  });

  it('keeps totals and Hold/Resume/Void under Pay and preserves F7/F8', async () => {
    mocks.mutations.transition!.mockResolvedValue({});
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const rail = screen.getByLabelText('Bill total');
    // DEV-972: the rail also has a "Discount" button now, so the totals are found as terms.
    for (const label of ['Gross', 'Discount', 'Tendered'])
      expect(within(rail).getByText(label, { selector: 'dt' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Cart' })).queryByRole('button', { name: /^Hold/ })
    ).not.toBeInTheDocument();
    const pay = within(rail).getByRole('button', { name: /^Take payment ?·/ });
    const hold = within(rail).getByRole('button', { name: /^Hold/ });
    expect(pay.compareDocumentPosition(hold) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(rail).getByRole('button', { name: /^Resume/ })).toBeDisabled();
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key: 'F7' });
    });
    await waitFor(() =>
      expect(within(rail).getByRole('button', { name: /^Resume/ })).toBeEnabled()
    );
    screen.getByLabelText('Scan or search').focus();
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key: 'F8' });
    });
    await waitFor(() =>
      expect(mocks.mutations.transition).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'resume', saleId: 'sale-a' })
      )
    );
    await waitFor(() => expect(within(rail).getByRole('button', { name: 'Void' })).toBeEnabled());
    fireEvent.click(within(rail).getByRole('button', { name: 'Void' }));
    const voidDialog = await screen.findByRole('dialog', { name: 'Void this bill?' });
    expect(mocks.mutations.transition).not.toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'void' })
    );
    fireEvent.click(within(voidDialog).getByRole('radio', { name: 'Duplicate bill' }));
    fireEvent.click(within(voidDialog).getByRole('button', { name: 'Void bill' }));
    await waitFor(() =>
      expect(mocks.mutations.transition).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'void',
          saleId: 'sale-a',
          voidReason: { code: 'DUPLICATE_BILL' },
        })
      )
    );
  });

  it('hides the unconfirmed preset from a cashier in the shortcuts dialog', () => {
    render(<PharmacyCounterConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Shortcuts' }));
    const dialog = screen.getByRole('dialog', { name: 'Shortcuts' });
    expect(within(dialog).getByLabelText('Keymap')).toHaveValue('devfathom');
    expect(within(dialog).queryByRole('option', { name: 'Legacy Speed' })).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Placeholder|Phase 0/)).not.toBeInTheDocument();
  });

  it.each([false, true])(
    'defaults to DevFathom and saves for an owner/admin without a saved preference or branch assignment (payment recovery available: %s)',
    async (recoveryAvailable) => {
      // Owners and organization admins use the ADMIN session role.
      mocks.session.data.user.role = 'ADMIN';
      // A corrupt recovery record locks sales while leaving the counter mounted.
      // No branches renders the setup checklist instead; covered separately below.
      if (!recoveryAvailable) window.localStorage.setItem(tenderAttemptStorageKey(scope), '{');
      mocks.mutations.counterSaveKeymap!.mockResolvedValueOnce({
        ...resolveCounterKeymap({ preset: 'legacySpeed' }),
        stored: true,
      });
      render(<PharmacyCounterConsole />);
      if (!recoveryAvailable) expect(screen.getByLabelText('Scan or search')).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'More' }));
      fireEvent.click(screen.getByRole('button', { name: 'Shortcuts' }));
      const dialog = screen.getByRole('dialog', { name: 'Shortcuts' });
      const select = within(dialog).getByLabelText('Keymap');
      expect(select).toBeEnabled();
      expect(select).toHaveValue('devfathom');
      expect(mocks.mutations.counterSaveKeymap).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.change(select, { target: { value: 'legacySpeed' } });
      });
      expect(mocks.mutations.counterSaveKeymap).toHaveBeenCalledExactlyOnceWith({
        preset: 'legacySpeed',
        overrides: {},
      });
      expect(select).toBeEnabled();
      expect(select).toHaveValue('legacySpeed');
      expect(within(dialog).getByText('Unconfirmed')).toBeInTheDocument();
      if (!recoveryAvailable) {
        expect(screen.getByLabelText('Scan or search')).toBeDisabled();
        expect(window.localStorage.getItem(tenderAttemptStorageKey(scope))).toBe('{');
      }
      expect(mocks.mutations.tender).not.toHaveBeenCalled();
    }
  );

  it('lets an admin save shortcuts before a branch is available without exposing sales', async () => {
    mocks.session.data.user.role = 'ADMIN';
    mocks.queries.counterBranches = query({ branches: [] });
    mocks.mutations.counterSaveKeymap!.mockResolvedValueOnce({
      ...resolveCounterKeymap({ preset: 'legacySpeed' }),
      stored: true,
    });
    render(<PharmacyCounterConsole />);
    expect(
      screen.getByRole('heading', { name: 'Before this counter can sell' })
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Scan or search')).not.toBeInTheDocument();
    const select = screen.getByLabelText('Keymap');
    expect(select).toBeEnabled();
    expect(select).toHaveValue('devfathom');
    expect(mocks.mutations.counterSaveKeymap).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.change(select, { target: { value: 'legacySpeed' } });
    });
    expect(mocks.mutations.counterSaveKeymap).toHaveBeenCalledExactlyOnceWith({
      preset: 'legacySpeed',
      overrides: {},
    });
    expect(select).toBeEnabled();
    expect(select).toHaveValue('legacySpeed');
    expect(screen.queryByLabelText('Scan or search')).not.toBeInTheDocument();
    expect(mocks.mutations.create).not.toHaveBeenCalled();
    expect(mocks.mutations.tender).not.toHaveBeenCalled();
  });

  it('lets an admin change Legacy Speed during payment recovery and retry a failed save', async () => {
    mocks.session.data.user.role = 'ADMIN';
    mocks.queries.counterKeymap = query({
      ...resolveCounterKeymap({ preset: 'legacySpeed' }),
      stored: true,
    });
    persistTenderAttempt(savedAttempt());
    let rejectSave!: (error: Error) => void;
    mocks.mutations
      .counterSaveKeymap!.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectSave = reject;
          })
      )
      .mockResolvedValueOnce({ ...resolveCounterKeymap({ preset: 'devfathom' }), stored: true });
    render(<PharmacyCounterConsole />);
    expect(screen.getByLabelText('Scan or search')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Shortcuts' }));
    const dialog = screen.getByRole('dialog', { name: 'Shortcuts' });
    const select = within(dialog).getByLabelText('Keymap');
    expect(select).toHaveValue('legacySpeed');
    expect(select).toBeEnabled();
    fireEvent.change(select, { target: { value: 'devfathom' } });
    expect(mocks.mutations.counterSaveKeymap).toHaveBeenCalledExactlyOnceWith({
      preset: 'devfathom',
      overrides: {},
    });
    expect(select).toBeDisabled();
    expect(within(dialog).getByText('Saving keymap…')).toBeInTheDocument();
    await act(async () => rejectSave(new Error('Preference could not be saved.')));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Preference could not be saved.');
    expect(select).toBeEnabled();
    expect(select).toHaveValue('legacySpeed');
    expect(within(dialog).queryByText('Saving keymap…')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.change(select, { target: { value: 'devfathom' } });
    });
    expect(mocks.mutations.counterSaveKeymap).toHaveBeenCalledTimes(2);
    expect(select).toBeEnabled();
    expect(select).toHaveValue('devfathom');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(mocks.keymapSetData).toHaveBeenCalledExactlyOnceWith(undefined, {
      ...resolveCounterKeymap({ preset: 'devfathom' }),
      stored: true,
    });
    expect(readTenderAttempt(scope)).toEqual({ status: 'pending', attempt: savedAttempt() });
    expect(mocks.mutations.tender).not.toHaveBeenCalled();
  });

  it('moves branch/status beside Counter, opens shortcuts from Actions, and changes the branch', async () => {
    mocks.session.data.user.role = 'ADMIN';
    mocks.queries.counterBranches = query({
      branches: [
        { id: 'branch-a', name: 'Model Town', code: 'MT1' },
        { id: 'branch-b', name: 'Gulberg', code: 'GB1' },
      ],
    });
    mocks.queries.drawerStatus = query({ openDrawer: { id: 'drawer-a' } });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const branch = screen.getByRole('combobox', { name: 'Branch' });
    expect(branch.closest('header')).toContainElement(
      screen.getByRole('heading', { name: 'Counter' })
    );
    expect(within(branch).getByRole('option', { name: 'Model Town' })).toBeInTheDocument();
    expect(screen.getByLabelText('Bill status')).toHaveTextContent('Bill open · 1 line');
    expect(screen.getByLabelText('Bill status')).toHaveTextContent('Drawer open');
    expect(screen.getByText('No safety blocks · 0 notes to pass on')).toBeInTheDocument();
    expect(screen.getByText('Loyalty and khata · not linked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'false');
    // DEV-977: collapsed into More until 1280px, where the everyday actions join the row.
    expect(document.getElementById('counter-actions')).toHaveClass('hidden', 'xl:contents');
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Shortcuts' }));
    const dialog = screen.getByRole('dialog', { name: 'Shortcuts' });
    fireEvent.change(within(dialog).getByLabelText('Keymap'), { target: { value: 'legacySpeed' } });
    expect(mocks.mutations.counterSaveKeymap).toHaveBeenCalledWith({
      preset: 'legacySpeed',
      overrides: {},
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.change(branch, { target: { value: 'branch-b' } });
    expect(branch).toHaveValue('branch-b');
    expect(screen.getByLabelText('Bill status')).toHaveTextContent('No open bill');
  });

  it('opens checks from context and Shift+F2 and keeps phone clearance', async () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    expect(search.closest('[data-counter-console]')).toHaveClass('pb-28');
    fireEvent.click(screen.getByRole('button', { name: /No safety blocks/ }));
    let dialog = screen.getByRole('dialog', { name: 'Patient, prescription and checks' });
    const rx = within(dialog).getByTestId('rx-focus-target');
    await waitFor(() => expect(document.activeElement).toBe(rx));
    const scrollBody = rx.parentElement!;
    const close = within(dialog).getByRole('button', { name: 'Close' });
    expect(scrollBody).toHaveClass('overflow-y-auto');
    expect(scrollBody).not.toContainElement(close);
    expect(dialog).toHaveClass('overflow-hidden');
    expect(close.parentElement).toHaveClass('shrink-0');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.keyDown(search, { key: 'F2', shiftKey: true });
    dialog = screen.getByRole('dialog', { name: 'Patient, prescription and checks' });
    expect(dialog).toBeVisible();
  });

  it.each([
    ['Rack A2', 'Rack A2'],
    ['Rear shelf', 'Rear shelf A2'],
  ])('keeps the location code once when the rack name is %s', (locationName, expected) => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() =>
      mocks.searchProps.mock.calls.at(-1)![0].onSelect(
        barcodeRow({
          storage: { coldChain: false, locationKind: 'RACK', locationName, locationCode: 'A2' },
        })
      )
    );
    const next = screen.getByRole('region', { name: 'Next line' });
    expect(next).toHaveTextContent(expected);
    expect(next).not.toHaveTextContent('A2 A2');
  });
});

it.each([
  { copyNumber: 1, reprint: false },
  { copyNumber: 2, reprint: true },
])('prints server copy $copyNumber with F10 inside the receipt drawer', async (allocation) => {
  mocks.queries.counterCart!.data = cart({
    status: 'COMPLETED',
    receiptNumber: 42,
    totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 25000 },
  });
  const receipt = {
    saleId: 'sale-a',
    receiptNumber: 42,
    branchName: 'Synthetic branch',
    businessDate: '2026-11-10',
    completedAt: '2026-11-10T12:00:00.000Z',
    currency: 'PKR',
    lines: [
      {
        saleLineId: 'line-a',
        medicineName: 'Paracetamol',
        strength: null,
        presentation: 'Tablet',
        batchNumber: 'batch-a',
        expiresAt: '2027-01-01',
        saleUnit: 'UNIT',
        quantity: 1,
        canonicalUnits: 1,
        unitPriceMinor: 25000,
        discountMinor: 0,
        lineTotalMinor: 25000,
      },
    ],
    tenders: [{ tenderId: 'tender-a', type: 'CASH', amountMinor: 25000, changeGivenMinor: 0 }],
    totals: {
      grossMinor: 25000,
      discountMinor: 0,
      netMinor: 25000,
      tenderedMinor: 25000,
      changeMinor: 0,
    },
  } satisfies CounterReceipt;
  mocks.queries.counterReceipt!.data = receipt;
  mocks.mutations.counterReceiptBrowserPrint!.mockResolvedValueOnce(allocation);
  render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
  fireEvent.click(screen.getByRole('button', { name: 'Preview receipt' }));
  const drawer = screen.getByRole('dialog', { name: 'Receipt preview' });
  await waitFor(() => expect(drawer).toContainElement(document.activeElement as HTMLElement));
  fireEvent.keyDown(drawer, { key: 'F10' });
  await waitFor(() =>
    expect(mocks.printReceipt).toHaveBeenCalledExactlyOnceWith(
      receipt,
      'en',
      'THERMAL',
      allocation.reprint,
      expect.objectContaining({ cancel: browserPrint.cancel })
    )
  );
  expect(mocks.mutations.counterReceiptBrowserPrint).toHaveBeenCalledExactlyOnceWith({
    branchId: 'branch-a',
    saleId: 'sale-a',
    locale: 'en',
  });
  await waitFor(() =>
    expect(mocks.mutations.counterReceiptBrowserPrintDispatched).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch-a',
      saleId: 'sale-a',
      locale: 'en',
      copyNumber: allocation.copyNumber,
    })
  );
  expect(mocks.mutations.counterReceiptBrowserPrintFailed).not.toHaveBeenCalled();
  expect(mocks.mutations.tender).not.toHaveBeenCalled();
});

it.each(['stale cart', 'fetching cart', 'fetching receipt', 'failed receipt'])(
  'keeps verified change visible after a %s until the next bill',
  async (state) => {
    mocks.queries.counterCart!.data = cart({
      status: 'COMPLETED',
      receiptNumber: 42,
      totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 25000 },
    });
    const receipt = {
      saleId: 'sale-a',
      receiptNumber: 42,
      totals: { changeMinor: 5000 },
    };
    mocks.queries.counterReceipt!.data = receipt;
    const { rerender } = render(
      <PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />
    );
    expect(screen.getByRole('region', { name: 'Change due' })).toHaveTextContent('50.00');
    fireEvent.click(screen.getByRole('button', { name: 'Preview receipt' }));
    expect(
      within(screen.getByRole('dialog', { name: 'Receipt preview' })).getByRole('region', {
        name: 'Change due',
      })
    ).toHaveTextContent('50.00');
    // Model the query transition after settlement, rather than mounting with
    // an already stale cart that has never confirmed this bill's change.
    const changedQuery = state.endsWith('cart')
      ? mocks.queries.counterCart!
      : mocks.queries.counterReceipt!;
    const flag = state.startsWith('stale')
      ? 'isStale'
      : state.startsWith('fetching')
        ? 'isFetching'
        : 'isError';
    changedQuery[flag] = true;
    rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(
      within(screen.getByRole('dialog', { name: 'Receipt preview' })).getByRole('region', {
        name: 'Change due',
      })
    ).toHaveTextContent('50.00');
    expect(mocks.receiptProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ receipt, state: 'ready', printing: false })
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Receipt preview' })).not.toBeInTheDocument()
    );
    expect(screen.getByRole('region', { name: 'Change due' })).toHaveTextContent('50.00');
    expect(
      within(screen.getByLabelText('Bill total')).getByRole('region', { name: 'Change due' })
    ).toHaveTextContent('50.00');
    expect(mocks.mutations.tender).not.toHaveBeenCalled();
    changedQuery[flag] = false;
    rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Start next bill' }));
    expect(screen.queryByRole('region', { name: 'Change due' })).not.toBeInTheDocument();
  }
);

it.each(['branch', 'account'])('clears retained change when switching %s', (scope) => {
  mocks.queries.counterBranches = query({
    branches: [
      { id: 'branch-a', name: 'Synthetic branch', code: 'MT1' },
      { id: 'branch-b', name: 'Other branch', code: 'GB1' },
    ],
  });
  mocks.queries.counterCart!.data = cart({
    status: 'COMPLETED',
    receiptNumber: 42,
    totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 25000 },
  });
  mocks.queries.counterReceipt!.data = {
    saleId: 'sale-a',
    receiptNumber: 42,
    totals: { changeMinor: 5000 },
  };
  const { rerender } = render(
    <PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />
  );
  expect(screen.getByRole('region', { name: 'Change due' })).toHaveTextContent('50.00');
  mocks.queries.counterCart!.isStale = true;
  rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
  expect(screen.getByRole('region', { name: 'Change due' })).toHaveTextContent('50.00');
  if (scope === 'branch') {
    fireEvent.change(screen.getByRole('combobox', { name: 'Branch' }), {
      target: { value: 'branch-b' },
    });
  } else {
    mocks.session.data.user.id = 'account-b';
    rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
  }
  expect(screen.queryByRole('region', { name: 'Change due' })).not.toBeInTheDocument();
});

it('updates retained change from a fresh receipt, including zero, before another background read', () => {
  mocks.queries.counterCart!.data = cart({
    status: 'COMPLETED',
    receiptNumber: 42,
    totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 25000 },
  });
  const receipt = {
    saleId: 'sale-a',
    receiptNumber: 42,
    totals: { changeMinor: 5000 },
  };
  mocks.queries.counterReceipt!.data = receipt;
  const { rerender } = render(
    <PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />
  );
  expect(screen.getByRole('region', { name: 'Change due' })).toHaveTextContent('50.00');

  mocks.queries.counterReceipt!.data = { ...receipt, totals: { changeMinor: 2500 } };
  rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
  expect(screen.getByRole('region', { name: 'Change due' })).toHaveTextContent('25.00');
  mocks.queries.counterReceipt!.isFetching = true;
  rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
  expect(screen.getByRole('region', { name: 'Change due' })).toHaveTextContent('25.00');

  mocks.queries.counterReceipt!.isFetching = false;
  mocks.queries.counterReceipt!.data = { ...receipt, totals: { changeMinor: 0 } };
  rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
  expect(screen.queryByRole('region', { name: 'Change due' })).not.toBeInTheDocument();
  mocks.queries.counterReceipt!.isFetching = true;
  rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
  expect(screen.queryByRole('region', { name: 'Change due' })).not.toBeInTheDocument();
});

it.each(['foreign sale', 'wrong receipt', 'fetching', 'failed'])(
  'withholds a change banner from a %s receipt',
  (state) => {
    mocks.queries.counterCart!.data = cart({
      status: 'COMPLETED',
      receiptNumber: 42,
      totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 25000 },
    });
    mocks.queries.counterReceipt!.data = {
      saleId: state === 'foreign sale' ? 'foreign' : 'sale-a',
      receiptNumber: state === 'wrong receipt' ? 43 : 42,
      totals: { changeMinor: 5000 },
    };
    if (state === 'fetching') mocks.queries.counterReceipt!.isFetching = true;
    if (state === 'failed') mocks.queries.counterReceipt!.isError = true;
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(screen.queryByRole('region', { name: 'Change due' })).not.toBeInTheDocument();
  }
);

describe('PharmacyCounterConsole fast typing (DEV-42)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function enabledSearches() {
    return mocks.queryInputs.mock.calls
      .filter(
        ([name, , options]) =>
          name === 'counterSearch' && (options as { enabled?: boolean })?.enabled
      )
      .map(([, input]) => (input as { query: string }).query);
  }

  it('keeps every typed character while results refresh and debounces the search', () => {
    vi.useFakeTimers();
    const view = render(
      <PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />
    );
    const search = screen.getByLabelText<HTMLInputElement>('Scan or search');
    const typed = 'panadol';

    // The cashier pauses after "pa": the debounced search fires once.
    fireEvent.change(search, { target: { value: 'p' } });
    fireEvent.change(search, { target: { value: 'pa' } });
    act(() => vi.advanceTimersByTime(300));
    expect(enabledSearches().at(-1)).toBe('pa');
    const searchesBeforeBurst = enabledSearches().length;

    // Then types the rest quickly while the "pa" results refetch and land.
    for (let index = 3; index <= typed.length; index += 1) {
      const value = typed.slice(0, index);
      fireEvent.change(search, { target: { value } });
      mocks.queries.counterSearch = {
        ...query({ rows: [], truncated: false }),
        isFetching: index % 2 === 1,
      };
      view.rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      act(() => vi.advanceTimersByTime(40));
      expect(search.value).toBe(value);
    }

    // No search runs for the partial words typed inside the debounce window.
    expect(enabledSearches().slice(searchesBeforeBurst)).toEqual([]);
    act(() => vi.advanceTimersByTime(300));
    expect(search.value).toBe(typed);
    const burst = enabledSearches().slice(searchesBeforeBurst);
    expect(burst.length).toBeGreaterThan(0);
    expect(new Set(burst)).toEqual(new Set([typed]));
  });
});

describe('DEV-97 counter payment controls follow the settlement grant', () => {
  const denied = () => query({ authorized: false, userId: 'account-a', organizationId: 'org-a' });

  function expectNoPaymentControls() {
    expect(
      screen.queryByRole('button', { name: 'Take payment', hidden: true })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: 'Payment method', hidden: true })
    ).not.toBeInTheDocument();
    for (const button of screen.getAllByRole('button', { name: /^Take payment ?·/ }))
      expect(button).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Khata payment' })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.queryByLabelText('Scan or search') ?? window, { key: 'F9' });
    expect(screen.queryByRole('dialog', { name: /^Take payment/ })).not.toBeInTheDocument();
    expect(mocks.mutations.tender).not.toHaveBeenCalled();
  }

  it('lets a pharmacist without pharmacy:counter build a bill with no drawer step', async () => {
    mocks.queries.settlementAccess = denied();
    closeDrawer();
    mocks.searchQuery.mockResolvedValue({ rows: [barcodeRow()], truncated: false });
    mocks.mutations.create!.mockResolvedValue({ id: 'sale-new' });
    mocks.mutations.addLine!.mockResolvedValue({});
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    expect(
      screen.queryByRole('form', { name: 'Open the cash drawer to start the shift' })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open drawer' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Bill status')).not.toHaveTextContent('Drawer');
    expect(mocks.queryOptions).toHaveBeenCalledWith(
      'drawerStatus',
      expect.objectContaining({ enabled: false })
    );
    const search = screen.getByLabelText('Scan or search');
    fireEvent.change(search, { target: { value: '123456' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(mocks.mutations.create).toHaveBeenCalledTimes(1));
    expect(mocks.mutations.create).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 'branch-a', quotation: false })
    );
    await waitFor(() => expect(mocks.mutations.addLine).toHaveBeenCalledTimes(1));
    expect(mocks.mutations.openDrawer).not.toHaveBeenCalled();
  });

  it('hides the drawer, tender and Take payment from a pharmacist, with a plain note', () => {
    mocks.queries.settlementAccess = denied();
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(screen.getAllByText('Payments are taken by counter staff.').length).toBeGreaterThan(0);
    expect(screen.queryByText('Drawer open')).not.toBeInTheDocument();
    expect(mocks.queryOptions).toHaveBeenCalledWith(
      'manualPaymentSettings',
      expect.objectContaining({ enabled: false })
    );
    expectNoPaymentControls();
  });

  it('keeps the drawer step (DEV-725) but withholds payment while access is unknown', () => {
    mocks.queries.settlementAccess = { ...query(), isSuccess: false, isLoading: true };
    closeDrawer();
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(
      screen.getByRole('form', { name: 'Open the cash drawer to start the shift' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open drawer' })).toBeDisabled();
    expect(screen.queryByLabelText('Scan or search')).not.toBeInTheDocument();
    expect(screen.getByText('Checking payment access…')).toBeInTheDocument();
    expectNoPaymentControls();
    expect(mocks.mutations.openDrawer).not.toHaveBeenCalled();
  });

  it.each([
    { userId: 'other-account', organizationId: 'org-a' },
    { userId: 'account-a', organizationId: 'other-org' },
  ])('ignores a cached grant for another identity ($userId / $organizationId)', (identity) => {
    mocks.queries.settlementAccess = query({ authorized: true, ...identity });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(screen.getByText('Checking payment access…')).toBeInTheDocument();
    expectNoPaymentControls();
  });

  it('removes the payment overlay when the grant is revoked mid-session', () => {
    const access = query({ authorized: true, userId: 'account-a', organizationId: 'org-a' });
    mocks.queries.settlementAccess = access;
    const { rerender } = renderPayment(
      <PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />
    );
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeInTheDocument();
    access.data = { authorized: false, userId: 'account-a', organizationId: 'org-a' };
    rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expectNoPaymentControls();
  });

  it('offers a retry when payment access cannot be checked, even over a cached grant', () => {
    const access = {
      ...query({ authorized: true, userId: 'account-a', organizationId: 'org-a' }),
      isError: true,
    };
    mocks.queries.settlementAccess = access;
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(screen.getByText("Couldn't check payment access.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry payment access' }));
    expect(access.refetch).toHaveBeenCalledOnce();
    expectNoPaymentControls();
  });

  it('keeps the drawer and payment for a counter-authorized operator', async () => {
    closeDrawer();
    mocks.mutations.openDrawer!.mockResolvedValue({ id: 'drawer-new' });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(screen.getByRole('button', { name: 'Khata payment' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Opening cash'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    await screen.findByText('Cash drawer opened for this counter.');
    openTheDrawer();
    fireEvent.keyDown(window, { key: 'F9' });
    enterPayment('BANK_TRANSFER');
    await waitFor(() => expect(mocks.mutations.tender).toHaveBeenCalledOnce());
  });
});

describe('PharmacyCounterConsole open bills (DEV-623)', () => {
  const activeBillKey = () =>
    activeBillStorageKey({ organizationId: 'org-a', accountId: 'account-a', branchId: 'branch-a' });
  const listed = (saleId: string, status: 'OPEN' | 'HELD') => ({
    saleId,
    status,
    createdAt: new Date('2026-11-02T18:15:00.000Z'),
    updatedAt: new Date('2026-11-02T18:15:00.000Z'),
    openedBy: 'Cashier A',
    lineCount: 1,
    reservedUnits: 20,
    netMinor: 25000,
    tenderedMinor: 0,
    customerOrder: false,
  });
  const cartReads = () =>
    mocks.queryInputs.mock.calls
      .filter(([name]) => name === 'counterCart')
      .map(([, input]) => (input as { saleId: string }).saleId);

  it('restores the bill this counter had open after a page reload', async () => {
    window.localStorage.setItem(activeBillKey(), JSON.stringify({ version: 1, saleId: 'sale-a' }));
    // Not in the (capped) Open bills list: the cart read alone decides.
    mocks.queries.openBills = query([]);

    render(<PharmacyCounterConsole />);

    await waitFor(() => expect(cartReads()).toContain('sale-a'));
    expect(mocks.cartRead).toHaveBeenCalledWith({ branchId: 'branch-a', saleId: 'sale-a' });
    expect(await screen.findByText('The open bill on this counter was restored.')).toBeVisible();
    expect(JSON.parse(window.localStorage.getItem(activeBillKey())!)).toEqual({
      version: 1,
      saleId: 'sale-a',
    });
  });

  it.each([
    ['held', () => mocks.cartRead.mockResolvedValue(cart({ status: 'HELD' }))],
    ['completed', () => mocks.cartRead.mockResolvedValue(cart({ status: 'COMPLETED' }))],
    ['voided', () => mocks.cartRead.mockResolvedValue(cart({ status: 'VOID' }))],
    ['gone', () => mocks.cartRead.mockRejectedValue(refused('NOT_FOUND'))],
  ])('forgets a remembered bill that is now %s', async (_state, arrange) => {
    arrange();
    window.localStorage.setItem(activeBillKey(), JSON.stringify({ version: 1, saleId: 'sale-a' }));

    render(<PharmacyCounterConsole />);

    await waitFor(() => expect(window.localStorage.getItem(activeBillKey())).toBeNull());
    expect(cartReads()).not.toContain('sale-a');
  });

  it('keeps a remembered bill when the check fails for a transient reason', async () => {
    mocks.cartRead.mockRejectedValue(refused('INTERNAL_SERVER_ERROR'));
    const remembered = JSON.stringify({ version: 1, saleId: 'sale-a' });
    window.localStorage.setItem(activeBillKey(), remembered);

    render(<PharmacyCounterConsole />);

    await waitFor(() => expect(mocks.cartRead).toHaveBeenCalled());
    await act(async () => undefined);
    expect(window.localStorage.getItem(activeBillKey())).toBe(remembered);
    expect(cartReads()).not.toContain('sale-a');
  });

  it('remembers the bill open on this counter', async () => {
    mocks.queries.openBills = query([]);

    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);

    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(activeBillKey()) ?? 'null')).toEqual({
        version: 1,
        saleId: 'sale-a',
      })
    );
  });

  it('resumes a held bill from Open bills and loads it on the counter', async () => {
    mocks.queries.openBills = query([listed('sale-b', 'HELD')]);
    mocks.mutations.transition!.mockResolvedValue({ id: 'sale-b', status: 'OPEN' });

    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open bills (1)' }));
    const list = await screen.findByRole('list', { name: 'Open and held bills' });
    expect(within(list).getByText(/20 units held/)).toBeInTheDocument();
    await waitFor(() => expect(within(list).getByRole('button', { name: 'Resume' })).toBeEnabled());
    fireEvent.click(within(list).getByRole('button', { name: 'Resume' }));

    await waitFor(() =>
      expect(mocks.mutations.transition).toHaveBeenCalledWith({
        branchId: 'branch-a',
        saleId: 'sale-b',
        action: 'resume',
      })
    );
    await waitFor(() => expect(cartReads()).toContain('sale-b'));
  });

  it('offers no void for a bill that still holds payment, and says why', async () => {
    mocks.queries.openBills = query([{ ...listed('sale-b', 'OPEN'), tenderedMinor: 10000 }]);

    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open bills (1)' }));
    const list = await screen.findByRole('list', { name: 'Open and held bills' });

    const voidButton = within(list).getByRole('button', { name: 'Void' });
    expect(voidButton).toBeDisabled();
    expect(voidButton).toHaveAccessibleDescription(
      'Payment was taken on this bill. A manager or owner must refund it before the bill can be voided.'
    );
    fireEvent.click(voidButton);
    expect(screen.queryByRole('dialog', { name: 'Void this bill?' })).not.toBeInTheDocument();
    expect(mocks.mutations.transition).not.toHaveBeenCalled();
  });

  it('voids a stranded bill from Open bills only after confirmation', async () => {
    mocks.queries.openBills = query([listed('sale-b', 'OPEN')]);
    mocks.mutations.transition!.mockResolvedValue({ id: 'sale-b', status: 'VOID' });

    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open bills (1)' }));
    const list = await screen.findByRole('list', { name: 'Open and held bills' });
    await waitFor(() => expect(within(list).getByRole('button', { name: 'Void' })).toBeEnabled());
    fireEvent.click(within(list).getByRole('button', { name: 'Void' }));
    expect(mocks.mutations.transition).not.toHaveBeenCalled();
    // DEV-508: the void needs a reason and an explicit confirm here too.
    const voidDialog = await screen.findByRole('dialog', { name: 'Void this bill?' });
    const confirm = within(voidDialog).getByRole('button', { name: 'Void bill' });
    expect(confirm).toBeDisabled();
    fireEvent.click(
      within(voidDialog).getByRole('radio', { name: 'Customer left without paying' })
    );
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(mocks.mutations.transition).toHaveBeenCalledWith({
        branchId: 'branch-a',
        saleId: 'sale-b',
        action: 'void',
        voidReason: { code: 'CUSTOMER_LEFT' },
      })
    );
    expect(await screen.findByText('Bill voided. Its stock is back on sale.')).toBeInTheDocument();
    expect(mocks.queries.openBills!.refetch).toHaveBeenCalled();
  });
});

describe('DEV-41 cashier actions', () => {
  it('signs out directly when no sale is open', async () => {
    render(<PharmacyCounterConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('confirms sign-out for an open sale without changing the sale', async () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    const dialog = screen.getByRole('dialog', { name: 'Sign out with an open sale?' });
    expect(mocks.signOut).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep working' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith());
    expect(mocks.mutations.transition).not.toHaveBeenCalled();
  });

  it.each(['COMPLETED', 'VOID'])(
    'does not confirm sign-out for a closed sale (%s)',
    async (status) => {
      mocks.queries.counterCart!.data = cart({
        status,
        receiptNumber: 42,
        totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 25000 },
      });
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
      await waitFor(() => expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith());
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    }
  );

  it.each(['idle', 'loading', 'error', 'empty', 'held'])(
    'explains both disabled Pay buttons for %s',
    (state) => {
      if (state === 'loading') mocks.queries.counterCart!.isFetching = true;
      if (state === 'error') mocks.queries.counterCart!.isError = true;
      if (state === 'empty') mocks.queries.counterCart!.data = cart({ lines: [] });
      if (state === 'held') mocks.queries.counterCart!.data = cart({ status: 'HELD' });
      render(
        <PharmacyCounterConsole
          initialSaleId={state === 'idle' ? undefined : 'sale-a'}
          initialBranchId="branch-a"
        />
      );
      const buttons = screen.getAllByRole('button', { name: /^Take payment ?·/ });
      expect(buttons).toHaveLength(2);
      for (const button of buttons) {
        expect(button).toBeDisabled();
        expect(button).toHaveAccessibleDescription(/Add an item|Checking|Refresh|Resume/);
        const reason = document.getElementById(button.getAttribute('aria-describedby')!);
        expect(reason).toBeVisible();
      }
    }
  );

  it.each([
    [
      'denied',
      () => query({ authorized: false, userId: 'account-a', organizationId: 'org-a' }),
      /Payments are taken by counter staff/,
    ],
    [
      'checking',
      () => ({ ...query(), isSuccess: false, isLoading: true }),
      /Checking payment access/,
    ],
    [
      'unavailable',
      () => ({ ...query(), isError: true, refetch: vi.fn() }),
      /Couldn't check payment access/,
    ],
  ])('explains both Pay buttons when payment access is %s', (_state, access, reason) => {
    mocks.queries.settlementAccess = access();
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const buttons = screen.getAllByRole('button', { name: /^Take payment ?·/ });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(reason);
    }
  });

  it('never displays the payment test sandbox to a cashier', () => {
    mocks.queries.counterBranches!.data = {
      ...(mocks.queries.counterBranches!.data as object),
      paymentSandboxAvailable: true,
    };
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(screen.queryByText('Local terminal sandbox')).not.toBeInTheDocument();
  });

  it('counts a single line as "1 line" in the bill total and payment drawer (CRT-008)', () => {
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(screen.getByLabelText('Bill total')).toHaveTextContent(/1 line(?!s)/);
    expect(screen.getByLabelText('Bill total')).not.toHaveTextContent('1 lines');
    const payment = screen.getByRole('dialog', { name: /^Take payment/ });
    expect(payment).toHaveTextContent(/1 line · Tendered/);
    expect(payment).not.toHaveTextContent('1 lines');
  });

  it('drops the stray saved-receipt text from the checks and loyalty drawers (PNL-003)', () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.click(screen.getByRole('button', { name: /No safety blocks/ }));
    const checks = screen.getByRole('dialog', { name: 'Patient, prescription and checks' });
    expect(checks).not.toHaveAccessibleDescription(/Saved receipt for this branch/);
    expect(checks).not.toHaveTextContent('Saved receipt for this branch');
    fireEvent.click(within(checks).getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Loyalty and khata · not linked' }));
    const loyalty = screen.getByRole('dialog', { name: 'Customer loyalty and khata' });
    expect(loyalty).not.toHaveAccessibleDescription(/Saved receipt for this branch/);
    expect(loyalty).not.toHaveTextContent('Saved receipt for this branch');
  });

  it('shows no internal ticket tags on the counter or its loyalty panel', () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Loyalty and khata · not linked' }));
    expect(screen.getByRole('dialog', { name: 'Customer loyalty and khata' })).toBeVisible();
    expect(document.body).not.toHaveTextContent(/\b(?:AI|RX|CRM|POS)-[A-Z]?\d{2}(?!\d)/);
  });
});

describe('DEV-705 keyboard loose sale', () => {
  // DEV-977B (Counter v2): Enter that beats the debounce runs the search and highlights its first
  // result; nothing the cashier has not seen is added. The next Enter adds it once.
  it('highlights the first fresh result when Enter beats the search debounce, then adds it once', async () => {
    mocks.searchFetch.mockResolvedValue({ rows: [barcodeRow()], truncated: false });
    mocks.queries.counterSearch = query({ rows: [barcodeRow()], truncated: false });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    fireEvent.change(search, { target: { value: 'Panadol' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() =>
      expect(mocks.searchProps.mock.calls.at(-1)![0].activeMedicineId).toBe(barcodeRow().medicineId)
    );
    expect(mocks.searchFetch).toHaveBeenCalledWith(
      { branchId: 'branch-a', query: 'Panadol' },
      { staleTime: 10000 }
    );
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Quantity')).not.toBeInTheDocument();
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() =>
      expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ medicineId: barcodeRow().medicineId, quantity: 1 })
      )
    );
  });
  it('discards a late Enter result after the operator changes the query', async () => {
    let resolveSearch!: (value: unknown) => void;
    mocks.searchFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        })
    );
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    fireEvent.change(search, { target: { value: 'Panadol' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(mocks.searchFetch).toHaveBeenCalled());
    fireEvent.change(search, { target: { value: 'Another' } });
    await act(async () => resolveSearch({ rows: [barcodeRow()], truncated: false }));
    expect(screen.queryByLabelText('Quantity')).not.toBeInTheDocument();
    expect(mocks.searchProps.mock.calls.at(-1)![0].activeMedicineId).toBeNull();
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
  });

  // DEV-977B (Counter v2, A6): Enter adds the highlighted (first) result in one step.
  it('adds the current first text result with Enter in one step, without a line form', async () => {
    mocks.queries.counterSearch = query({ rows: [barcodeRow()], truncated: false });
    mocks.mutations.addLine!.mockResolvedValue({});
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    fireEvent.change(search, { target: { value: 'Panadol' } });
    await waitFor(() => expect(mocks.searchProps.mock.calls.at(-1)![0].state).toBe('ready'));
    expect(mocks.searchProps.mock.calls.at(-1)![0].activeMedicineId).toBe(barcodeRow().medicineId);
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() =>
      expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ medicineId: barcodeRow().medicineId, quantity: 1 })
      )
    );
    expect(screen.queryByLabelText('Quantity')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Next line' })).not.toBeInTheDocument();
  });

  // The line form is still one key away for a quantity or batch chosen before adding.
  it('stages the current first text result with Shift+Enter and moves directly to quantity', async () => {
    mocks.queries.counterSearch = query({ rows: [barcodeRow()], truncated: false });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    fireEvent.change(search, { target: { value: 'Panadol' } });
    await waitFor(() => expect(mocks.searchProps.mock.calls.at(-1)![0].state).toBe('ready'));
    fireEvent.keyDown(search, { key: 'Enter', shiftKey: true });
    expect(screen.getByLabelText('Quantity')).toHaveFocus();
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
  });
  it('does not stage stale results while the current text search failed', async () => {
    mocks.searchFetch.mockRejectedValue(new Error('Search failed'));
    mocks.queries.counterSearch = {
      ...query({ rows: [barcodeRow()], truncated: false }),
      isError: true,
    };
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const search = screen.getByLabelText('Scan or search');
    fireEvent.change(search, { target: { value: 'Panadol' } });
    await waitFor(() => expect(mocks.searchProps.mock.calls.at(-1)![0].state).toBe('error'));
    await act(async () => fireEvent.keyDown(search, { key: 'Enter' }));
    expect(screen.queryByLabelText('Quantity')).not.toBeInTheDocument();
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
  });

  function looseRow(overrides: Partial<CounterSearchRow> = {}) {
    return barcodeRow({
      unitsPerPack: 10,
      printedMrpMinor: 1000,
      onHandUnits: 30,
      saleUnits: [
        { kind: 'PACK', packLevelId: 'pack-a', levelLabel: 'STRIP', canonicalUnitsPerSaleUnit: 10 },
        { kind: 'UNIT', packLevelId: 'pack-a', levelLabel: 'UNIT', canonicalUnitsPerSaleUnit: 1 },
      ],
      ...overrides,
    });
  }
  it('defaults to a tablet, focuses quantity and adds one tablet with Enter', async () => {
    mocks.mutations.addLine!.mockResolvedValue({ saleLineId: 'loose-line' });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() => mocks.searchProps.mock.calls.at(-1)![0].onSelect(looseRow()));
    const quantity = screen.getByLabelText('Quantity');
    expect(screen.getByRole('radio', { name: /Tablet/ })).toHaveAttribute('aria-checked', 'true');
    expect(quantity).toHaveFocus();
    expect(screen.getByText('1 tablet = 1/10 of strip')).toBeVisible();
    fireEvent.change(quantity, { target: { value: '1' } });
    fireEvent.keyDown(quantity, { key: 'Enter' });
    await waitFor(() =>
      expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ saleUnit: 'UNIT', canonicalUnitsPerSaleUnit: 1, quantity: 1 })
      )
    );
    await waitFor(() => expect(screen.getByLabelText('Scan or search')).toHaveFocus());
    fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key: 'F9' });
    expect(screen.getByRole('dialog', { name: /^Take payment/ })).toBeInTheDocument();
  });

  it('DEV-930 leaves focus in payment opened while an add is still settling, so Enter takes it', async () => {
    // The cart shows the line before the add's follow-up reads finish; F9 is allowed then.
    let settle!: () => void;
    const { controlledRegister } = (
      trpc.useUtils as unknown as () => {
        pharmacySafety: { controlledRegister: { invalidate: ReturnType<typeof vi.fn> } };
      }
    )().pharmacySafety;
    controlledRegister.invalidate.mockImplementationOnce(
      () => new Promise<void>((resolve) => (settle = resolve))
    );
    mocks.mutations.addLine!.mockResolvedValue({ saleLineId: 'loose-line' });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() => mocks.searchProps.mock.calls.at(-1)![0].onSelect(looseRow()));
    fireEvent.keyDown(screen.getByLabelText('Quantity'), { key: 'Enter' });
    await waitFor(() => expect(controlledRegister.invalidate).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: 'F9' });
    const payment = screen.getByRole('dialog', { name: /^Take payment/ });
    const panel = within(payment)
      .getByRole('group', { name: 'Payment method' })
      .closest<HTMLElement>('[tabindex="-1"]')!;
    act(() => panel.focus());
    await act(async () => settle());
    expect(payment).toContainElement(document.activeElement as HTMLElement);
    expect(screen.getByLabelText('Scan or search')).not.toHaveFocus();
  });

  it('DEV-930 leaves focus on a control the cashier moved to while an add is still settling', async () => {
    let settle!: () => void;
    const { controlledRegister } = (
      trpc.useUtils as unknown as () => {
        pharmacySafety: { controlledRegister: { invalidate: ReturnType<typeof vi.fn> } };
      }
    )().pharmacySafety;
    controlledRegister.invalidate.mockImplementationOnce(
      () => new Promise<void>((resolve) => (settle = resolve))
    );
    mocks.mutations.addLine!.mockResolvedValue({ saleLineId: 'loose-line' });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() => mocks.searchProps.mock.calls.at(-1)![0].onSelect(looseRow()));
    fireEvent.keyDown(screen.getByLabelText('Quantity'), { key: 'Enter' });
    await waitFor(() => expect(controlledRegister.invalidate).toHaveBeenCalled());
    const patient = screen.getByRole('button', { name: /^Patient/ });
    act(() => patient.focus());
    await act(async () => settle());
    expect(patient).toHaveFocus();
  });
  it('shows every unit with its price and lets the operator switch to the strip', () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() => mocks.searchProps.mock.calls.at(-1)![0].onSelect(looseRow()));
    const strip = screen.getByRole('radio', { name: /Strip of 10.*PKR 10.00/ });
    expect(screen.getByRole('radio', { name: /Tablet.*PKR 1.00/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    fireEvent.click(strip);
    expect(strip).toHaveAttribute('aria-checked', 'true');
  });
  it('explains a single-unit pack without offering a second loose choice', () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() => mocks.searchProps.mock.calls.at(-1)![0].onSelect(barcodeRow()));
    // DEV-977B: the line form's own unit choice ("Adds as" in the search bar is separate).
    expect(
      within(screen.getByRole('region', { name: 'Next line' })).getAllByRole('radio')
    ).toHaveLength(1);
    expect(screen.getByText(/Already sold as one tablet/)).toBeVisible();
  });
  it('keeps controlled loose tablets behind prescription authorization on Enter', async () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() =>
      mocks.searchProps.mock.calls.at(-1)![0].onSelect(
        looseRow({
          restriction: {
            rx: true,
            otc: false,
            controlled: true,
            restricted: true,
            highAlert: false,
            lasa: false,
          },
        })
      )
    );
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '1' } });
    fireEvent.keyDown(screen.getByLabelText('Quantity'), { key: 'Enter' });
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(/patient|prescription/i);
  });
});

describe('DEV-41 remaining disabled explanations', () => {
  it('explains missing bills and clears reasons when Hold and Void become available', () => {
    const view = render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    for (const name of [/^Hold/, /^Void$/]) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(
        'Start or resume an open bill to hold or void it.'
      );
    }
    expect(screen.getByRole('button', { name: /^Resume/ })).toHaveAccessibleDescription(
      'No bill is held on this counter. Use Open bills to find another bill.'
    );
    view.unmount();
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    for (const name of [/^Hold/, /^Void$/]) {
      expect(screen.getByRole('button', { name })).toBeEnabled();
      expect(screen.getByRole('button', { name })).not.toHaveAccessibleDescription();
    }
  });

  it.each(['HELD', 'COMPLETED', 'VOID'] as const)(
    'explains why a %s bill cannot be held or voided',
    (status) => {
      mocks.queries.counterCart!.data = { ...cart(), status };
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      for (const name of [/^Hold/, /^Void$/]) {
        expect(screen.getByRole('button', { name })).toBeDisabled();
        expect(screen.getByRole('button', { name })).toHaveAccessibleDescription(
          status === 'HELD'
            ? 'Resume this held bill before holding or voiding it.'
            : 'This bill is closed. Start or resume an open bill to hold or void it.'
        );
      }
      expect(mocks.mutations.transition).not.toHaveBeenCalled();
    }
  );

  it('explains recovery locks on bill actions and the branch selector', () => {
    window.localStorage.setItem(tenderAttemptStorageKey(scope), '{');
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const reason = 'Browser recovery is unavailable. Review payment status before continuing.';
    for (const name of [/^Hold/, /^Resume/, /^Void$/]) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(reason);
      fireEvent.click(button);
    }
    expect(screen.getByLabelText('Branch')).toBeDisabled();
    expect(screen.getByLabelText('Branch')).toHaveAccessibleDescription(reason);
    expect(screen.getByLabelText('Scan or search')).toHaveAccessibleDescription(
      expect.stringContaining(reason)
    );
    expect(mocks.mutations.transition).not.toHaveBeenCalled();
  });

  it('explains a pending action and restores Resume after holding a bill', async () => {
    let finish!: () => void;
    mocks.mutations.transition!.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.click(screen.getByRole('button', { name: /^Hold/ }));
    for (const name of [/^Hold/, /^Resume/, /^Void$/]) {
      expect(screen.getByRole('button', { name })).toHaveAccessibleDescription(
        'Wait for the current counter action to finish.'
      );
    }
    expect(screen.getByLabelText('Branch')).toHaveAccessibleDescription(
      'Wait for the current counter action to finish.'
    );
    await act(async () => finish());
    expect(screen.getByRole('button', { name: /^Resume/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^Resume/ })).not.toHaveAccessibleDescription();
  });

  it.each(['loading', 'access-loading', 'access-error'] as const)(
    'explains the drawer %s gate',
    (state) => {
      closeDrawer();
      // Quick amounts are offered to managers only (DEV-873), so the preset's
      // disabled explanation is asserted for a manager.
      mocks.queries.refundAccess = query({ authorized: true });
      if (state === 'loading')
        mocks.queries.drawerStatus = { ...query(), isSuccess: false, isLoading: true };
      else
        mocks.queries.settlementAccess = {
          ...query(),
          isSuccess: false,
          isLoading: state === 'access-loading',
          isError: state === 'access-error',
        };
      render(<PharmacyCounterConsole initialBranchId="branch-a" />);
      const reason =
        state === 'loading'
          ? 'Checking the cash drawer. Please wait.'
          : state === 'access-error'
            ? "Couldn't check payment access. Retry payment access before opening the drawer."
            : 'Checking payment access before opening the drawer.';
      const button = screen.getByRole('button', { name: 'Open drawer' });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(reason);
      expect(screen.getByLabelText('Opening cash')).toHaveAccessibleDescription(reason);
      expect(screen.getByRole('button', { name: 'Empty (0)' })).toHaveAccessibleDescription(reason);
      fireEvent.click(button);
      expect(mocks.mutations.openDrawer).not.toHaveBeenCalled();
    }
  );
});

describe('DEV-41 post-merge branch reasons and composed explanations', () => {
  const branchCases = [
    {
      state: 'loading',
      result: { ...query(), isSuccess: false, isLoading: true, isFetching: true },
    },
    {
      state: 'failed',
      result: { ...query(), isSuccess: false, isError: true },
    },
    {
      state: 'failed with cached branches',
      result: {
        ...query({ branches: [{ id: 'branch-a', name: 'Synthetic branch', code: 'MT1' }] }),
        isError: true,
      },
    },
    {
      state: 'empty',
      result: query({ branches: [] }),
    },
    {
      state: 'unavailable',
      result: { ...query(), isSuccess: false },
    },
    {
      state: 'missing data',
      result: query(),
    },
    {
      state: 'unverified cached branch',
      result: {
        ...query({ branches: [{ id: 'branch-a', name: 'Synthetic branch', code: 'MT1' }] }),
        isSuccess: false,
      },
    },
    {
      state: 'unauthorized selection',
      result: query({ branches: [{ id: 'branch-b', name: 'Other branch', code: 'OTHER' }] }),
    },
  ];

  it.each(branchCases)(
    'preserves the $state branch guard without claiming payment recovery is pending',
    ({ state, result }) => {
      enableBranchChildren();
      mocks.queries.counterBranches = result;
      const view = render(
        <PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />
      );
      if (state === 'loading') {
        expect(screen.getByRole('status', { name: 'Loading pharmacy counter' })).toBeVisible();
      } else if (state.startsWith('failed')) {
        expect(screen.getByRole('heading', { name: 'Branches unavailable' })).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        expect(result.refetch).toHaveBeenCalledExactlyOnceWith();
      } else if (state === 'unauthorized selection' || state === 'unverified cached branch') {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'This branch could not be verified for your account.'
        );
      } else {
        expect(screen.getByRole('heading', { name: 'Before this counter can sell' })).toBeVisible();
      }
      for (const name of [/^Hold/, /^Resume/, /^Void$/, /^Open drawer$/, /^Find item$/]) {
        expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
      }
      expect(screen.queryByLabelText('Branch')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Scan or search')).not.toBeInTheDocument();
      expect(
        screen.queryByText('Checking saved payment details. Please wait.')
      ).not.toBeInTheDocument();
      for (const key of ['F6', 'F7', 'F8']) fireEvent.keyDown(window, { key });
      expect(mocks.mutations.transition).not.toHaveBeenCalled();
      expect(mocks.mutations.create).not.toHaveBeenCalled();
      expect(mocks.mutations.addLine).not.toHaveBeenCalled();
      expect(mocks.mutations.openDrawer).not.toHaveBeenCalled();
      expect(mocks.mutations.tender).not.toHaveBeenCalled();
      mocks.queries.counterBranches = query({
        branches: [{ id: 'branch-a', name: 'Synthetic branch', code: 'MT1' }],
      });
      view.rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      expect(screen.getByLabelText('Branch')).toBeEnabled();
      expect(screen.getByLabelText('Branch')).not.toHaveAccessibleDescription();
      expect(screen.getByRole('button', { name: /^Hold/ })).toBeEnabled();
      expect(screen.getByRole('button', { name: /^Hold/ })).not.toHaveAccessibleDescription();
    }
  );

  function enableBranchChildren() {
    mocks.renderBranchChildren = true;
    mocks.queries.counterSearch = query({ rows: [barcodeRow()], truncated: false });
    mocks.queries.upsellSuggestions = query([
      {
        medicineId: 'synthetic-spacer',
        presentationId: 'synthetic-presentation',
        displayName: 'Synthetic spacer',
        presentation: 'Each',
        availableCanonicalUnits: 3,
        packMrpMinor: 100,
        ruleId: 'synthetic-rule',
        reason: 'Often bought together',
      },
    ]);
  }

  it('shares busy explanations with real search and upsell children, then removes them when enabled', async () => {
    enableBranchChildren();
    let reject!: (error: Error) => void;
    mocks.mutations.transition!.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        })
    );
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.change(screen.getByLabelText('Scan or search'), { target: { value: 'para' } });
    const results = await screen.findByRole('list', { name: 'Search results' });
    // DEV-977B: each result is its add button and its "Quantity or batch first" button.
    const [searchButton, optionsButton] = within(results).getAllByRole('button');
    expect(within(results).getAllByRole('button')).toHaveLength(2);
    const upsellButton = screen.getByRole('button', { name: 'Find item' });
    expect(searchButton).toBeEnabled();
    expect(optionsButton).toBeEnabled();
    expect(upsellButton).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /^Hold/ }));
    const reason = 'Wait for the current counter action to finish.';
    const branchArea = screen.getByLabelText('Counter bill').parentElement!;
    expect(within(branchArea).queryAllByText(reason)).toHaveLength(0);
    expect(document.getElementById('counter-branch-reason')).toBeVisible();
    for (const button of [searchButton!, optionsButton!, upsellButton]) {
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(reason);
      expect(button).toHaveAttribute('aria-describedby', 'counter-branch-reason');
      fireEvent.click(button);
    }
    const billReason = document.getElementById('counter-bill-action-reason')!;
    expect(within(billReason.parentElement!).getAllByText(reason)).toHaveLength(1);
    expect(screen.queryByRole('region', { name: 'Next line' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Scan or search')).toHaveValue('para');
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
    await act(async () => reject(new Error('Synthetic refusal')));
    expect(screen.queryByText(reason)).not.toBeInTheDocument();
    for (const button of [
      searchButton!,
      optionsButton!,
      upsellButton,
      screen.getByRole('button', { name: /^Hold/ }),
      screen.getByRole('button', { name: /^Void$/ }),
    ]) {
      expect(button).toBeEnabled();
      expect(button).not.toHaveAccessibleDescription();
    }
    fireEvent.click(upsellButton);
    expect(screen.getByLabelText('Scan or search')).toHaveValue('Synthetic spacer');
  });

  it('keeps the shared upsell description mounted when the drawer step replaces search', () => {
    enableBranchChildren();
    closeDrawer();
    window.localStorage.setItem(tenderAttemptStorageKey(scope), '{');
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const reason = 'Browser recovery is unavailable. Review payment status before continuing.';
    const button = screen.getByRole('button', { name: 'Find item' });
    expect(screen.queryByLabelText('Scan or search')).not.toBeInTheDocument();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-describedby', 'counter-branch-reason');
    expect(button).toHaveAccessibleDescription(reason);
    expect(document.getElementById('counter-branch-reason')).toBeVisible();
    expect(
      within(button.closest('[data-slot="section-card"]')!).queryByText(reason)
    ).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(mocks.mutations.create).not.toHaveBeenCalled();
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
    expect(mocks.mutations.openDrawer).not.toHaveBeenCalled();
  });
});

describe('DEV-878 search alternative uses the normal counter line path', () => {
  it.each(['ordinary', 'controlled', 'server-refusal'])(
    'preserves %s handling when choosing an alternative',
    async (kind) => {
      mocks.renderSearchResults = true;
      const candidate = barcodeRow({
        medicineId: 'stock-alternative',
        displayName: 'Synthetic alternative',
        matchedOn: 'NAME',
        saleableUnits: [
          {
            kind: 'UNIT',
            levelLabel: 'UNIT',
            canonicalUnitsPerSaleUnit: 1,
            wholeUnits: 10,
            unitPriceMinor: 10000,
            proRataCeilingMinor: 10000,
          },
        ],
      });
      if (kind === 'controlled')
        candidate.restriction = { ...candidate.restriction, controlled: true, rx: true };
      const unavailable = barcodeRow({
        medicineId: 'requested-brand',
        displayName: 'Requested brand',
        onHandUnits: 0,
        saleUnits: [],
        stockAlternatives: {
          ingredientRecorded: true,
          exact: [candidate],
          other: [],
          truncated: false,
        },
      });
      mocks.queries.counterSearch = query({ rows: [unavailable], truncated: false });
      if (kind === 'server-refusal')
        mocks.mutations.addLine!.mockRejectedValue(
          refused('FORBIDDEN', 'Pharmacist presence required')
        );
      else mocks.mutations.addLine!.mockResolvedValue({});
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      fireEvent.change(screen.getByLabelText('Scan or search'), {
        target: { value: 'Requested brand' },
      });
      const options = await screen.findByRole('list', {
        name: 'Same ingredient, strength and form',
      });
      expect(mocks.mutations.addLine).not.toHaveBeenCalled();
      fireEvent.click(within(options).getByRole('button'));
      expect(mocks.mutations.addLine).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '1' } });
      fireEvent.click(screen.getByRole('button', { name: /Add to cart/ }));
      if (kind === 'controlled') {
        await screen.findByText(/Controlled medicine needs the patient address/);
        expect(mocks.mutations.addLine).not.toHaveBeenCalled();
      } else {
        await waitFor(() =>
          expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              branchId: 'branch-a',
              saleId: 'sale-a',
              medicineId: 'stock-alternative',
              presentationId: candidate.presentationId,
              packLevelId: 'pack-a',
              saleUnit: 'UNIT',
              quantity: 1,
              canonicalUnitsPerSaleUnit: 1,
              // DEV-575: the same per-attempt add-line key scheme as every other line.
              idempotencyKey: expect.stringMatching(
                /^counter-add:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
              ),
            })
          )
        );
        if (kind === 'server-refusal') {
          await screen.findByText('Pharmacist presence required');
          expect(screen.queryByText(/Synthetic alternative added/)).not.toBeInTheDocument();
        } else await screen.findByText('1 × Synthetic alternative added.');
      }
      expect(mocks.mutations.tender).not.toHaveBeenCalled();
    }
  );
});

describe('DEV-712 supervisor discard of an unknown payment attempt', () => {
  const approvers = [{ id: 'staff-manager', name: 'Synthetic manager', self: false }];

  async function discardWith(reason = 'Customer did not pay') {
    fireEvent.click(screen.getByRole('button', { name: 'Supervisor: discard this attempt' }));
    const approver = await screen.findByLabelText('Approving manager or owner');
    await waitFor(() => expect(approver).toBeEnabled());
    fireEvent.change(approver, { target: { value: 'staff-manager' } });
    fireEvent.change(screen.getByLabelText('Approver PIN'), { target: { value: '4321' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: reason } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard payment attempt' }));
  }

  beforeEach(() => {
    mocks.discardApprovers.mockReset().mockResolvedValue(approvers);
    mocks.discardAttempt.mockReset().mockResolvedValue({ status: 'DISCARDED' });
  });

  it('releases the saved attempt and sends the next payment under a fresh key', async () => {
    mocks.mutations.tender!.mockRejectedValueOnce(new Error('Acknowledgement lost'));
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    enterPayment();
    await screen.findByText(/Payment outcome is unknown/);
    const original = mocks.mutations.tender!.mock.calls[0]![0];
    expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeDisabled();

    await discardWith();
    await screen.findByText(/Payment attempt discarded/);
    expect(mocks.discardAttempt).toHaveBeenCalledExactlyOnceWith({
      attempt: original,
      reason: 'Customer did not pay',
      approval: { staffProfileId: 'staff-manager', pin: '4321' },
    });
    expect(readTenderAttempt(scope)).toEqual({ status: 'empty' });
    expect(mocks.refetch).toHaveBeenCalled();

    mocks.mutations.tender!.mockResolvedValueOnce(accepted());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeEnabled()
    );
    enterPayment();
    await screen.findByText('Payment recorded.');
    const retry = mocks.mutations.tender!.mock.calls[1]![0];
    // Same bill, same amount: the discarded key is never reused.
    expect(retry.amountMinor).toBe(original.amountMinor);
    expect(retry.idempotencyKey).toMatch(
      new RegExp(`^${original.idempotencyKey}:retry:[0-9a-f-]{36}$`)
    );
  });

  it('keeps the attempt locked when the supervisor PIN is refused', async () => {
    const attempt = savedAttempt();
    persistTenderAttempt(attempt);
    mocks.discardAttempt.mockRejectedValue(
      refused(
        'FORBIDDEN',
        'Discarding a payment attempt needs a manager or owner to approve it with their PIN.'
      )
    );
    renderPayment(<PharmacyCounterConsole />);
    await discardWith();
    expect(
      await screen.findAllByText(
        /The attempt was not discarded\. Discarding a payment attempt needs/
      )
    ).not.toHaveLength(0);
    expect(readTenderAttempt(scope)).toEqual({ status: 'pending', attempt });
    expect(screen.getByRole('button', { name: 'Take payment', hidden: true })).toBeDisabled();
    expect(screen.getByLabelText('Approver PIN')).toHaveValue('');
    expect(mocks.mutations.tender).not.toHaveBeenCalled();
  });

  it('records an attempt that reached the shop instead of discarding it', async () => {
    persistTenderAttempt(savedAttempt());
    mocks.discardAttempt.mockResolvedValue({ status: 'ACCEPTED', result: accepted(0) });
    mocks.queries.counterCart!.data = cart({
      status: 'COMPLETED',
      receiptNumber: 42,
      totals: { grossMinor: 12550, discountMinor: 0, netMinor: 12550, tenderedMinor: 12550 },
    });
    renderPayment(<PharmacyCounterConsole />);
    await discardWith();
    await screen.findByText(/Payment recorded\. The attempt was not discarded/);
    await waitFor(() => expect(readTenderAttempt(scope)).toEqual({ status: 'empty' }));
    expect(mocks.mutations.tender).not.toHaveBeenCalled();
  });

  it('needs an approver, a PIN and a reason before it can be sent', async () => {
    persistTenderAttempt(savedAttempt());
    renderPayment(<PharmacyCounterConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'Supervisor: discard this attempt' }));
    const send = screen.getByRole('button', { name: 'Discard payment attempt' });
    expect(send).toBeDisabled();
    const approver = await screen.findByLabelText('Approving manager or owner');
    await waitFor(() => expect(approver).toBeEnabled());
    fireEvent.change(approver, { target: { value: 'staff-manager' } });
    fireEvent.change(screen.getByLabelText('Approver PIN'), { target: { value: '4321' } });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'No money taken' } });
    expect(send).toBeEnabled();
    expect(mocks.discardAttempt).not.toHaveBeenCalled();
  });
});

describe('DEV-633 keyboard-only counter', () => {
  const rows = [
    barcodeRow(),
    barcodeRow({ medicineId: 'second-result', displayName: 'Second item' }),
  ];

  beforeEach(() => {
    mocks.queries.counterSearch = query({ rows, truncated: false });
    mocks.mutations.addLine!.mockResolvedValue({});
  });

  function searchResults() {
    const rendered = render(
      <PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />
    );
    const search = screen.getByLabelText('Scan or search');
    search.focus();
    fireEvent.change(search, { target: { value: 'para' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    return { ...rendered, search };
  }

  it('picks and wraps ready results with arrows while keeping scan focus', () => {
    const { search } = searchResults();
    const active = () => mocks.searchProps.mock.calls.at(-1)![0].activeMedicineId;
    expect(fireEvent.keyDown(search, { key: 'ArrowUp' })).toBe(false);
    expect(active()).toBe('second-result');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(active()).toBe(rows[0]!.medicineId);
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(active()).toBe('second-result');
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    expect(active()).toBe(rows[0]!.medicineId);
    expect(document.activeElement).toBe(search);
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
  });

  it('keeps arrow selection on the results while an alternatives panel is shown (DEV-878)', () => {
    const alternative = barcodeRow({
      medicineId: 'stock-alternative',
      displayName: 'In-stock brand',
    });
    const unavailable = barcodeRow({
      medicineId: 'second-result',
      displayName: 'Second item',
      onHandUnits: 0,
      saleUnits: [],
      stockAlternatives: {
        ingredientRecorded: true,
        exact: [alternative],
        other: [],
        truncated: false,
      },
    });
    mocks.queries.counterSearch = query({ rows: [rows[0]!, unavailable], truncated: false });
    mocks.renderSearchResults = true;
    const { search } = searchResults();
    const active = () => mocks.searchProps.mock.calls.at(-1)![0].activeMedicineId;
    const panel = screen.getByRole('list', { name: 'Same ingredient, strength and form' });
    // Arrows walk the search results only; the nested alternative is not a stop.
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(active()).toBe(rows[0]!.medicineId);
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(active()).toBe('second-result');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(active()).toBe(rows[0]!.medicineId);
    expect(document.activeElement).toBe(search);
    // The alternative is still a button of its own and stages through the same path.
    fireEvent.click(within(panel).getByRole('button'));
    expect(active()).toBe('stock-alternative');
    // From a staged alternative the arrows return to the first search result.
    search.focus();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(active()).toBe(rows[0]!.medicineId);
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
  });

  it.each(['empty', 'loading', 'error', 'placeholder', 'superseded'] as const)(
    'leaves arrows with the field for %s results',
    (state) => {
      const { search, rerender } = searchResults();
      if (state === 'empty') mocks.queries.counterSearch!.data = { rows: [], truncated: false };
      if (state === 'loading') mocks.queries.counterSearch!.isFetching = true;
      if (state === 'error') mocks.queries.counterSearch!.isError = true;
      if (state === 'placeholder') mocks.queries.counterSearch!.isPlaceholderData = true;
      if (state === 'superseded') fireEvent.change(search, { target: { value: 'different' } });
      rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      expect(fireEvent.keyDown(search, { key: 'ArrowDown' })).toBe(true);
      expect(mocks.searchProps.mock.calls.at(-1)![0].activeMedicineId).toBeNull();
      expect(mocks.mutations.addLine).not.toHaveBeenCalled();
    }
  );

  it('claims F6 from a pointer-selected Quantity without repeating the add', async () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() => mocks.searchProps.mock.calls.at(-1)![0].onSelect(rows[0]!));
    const quantity = screen.getByLabelText('Quantity');
    quantity.focus();
    fireEvent.change(quantity, { target: { value: '2' } });
    expect(fireEvent.keyDown(quantity, { key: 'F6' })).toBe(false);
    await waitFor(() =>
      expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ medicineId: rows[0]!.medicineId, quantity: 2 })
      )
    );
  });

  // DEV-977B: the line form opens on purpose with Shift+Enter; Enter alone adds in one step.
  it('moves from a picked result to Quantity, adds once with F6 and restores scan focus', async () => {
    const { search } = searchResults();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter', shiftKey: true });
    const quantity = screen.getByLabelText('Quantity');
    expect(document.activeElement).toBe(quantity);
    expect(quantity).toHaveValue('1');
    expect((quantity as HTMLInputElement).selectionStart).toBe(0);
    expect((quantity as HTMLInputElement).selectionEnd).toBe(1);
    fireEvent.change(quantity, { target: { value: '2' } });
    expect(fireEvent.keyDown(quantity, { key: 'F6' })).toBe(false);
    await waitFor(() =>
      expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ medicineId: rows[0]!.medicineId, quantity: 2 })
      )
    );
    await waitFor(() => expect(document.activeElement).toBe(search));
  });

  // DEV-977B (owner-approved Counter v2): Enter on a highlighted result adds one in one step and
  // its quantity is then changed on the bill line. In the line form, opened with Shift+Enter, the
  // default quantity of 1 stays a proposal until the cashier has looked at it.
  it('adds the highlighted result once with Enter, in one step, with no line form', async () => {
    const { search } = searchResults();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(screen.queryByRole('region', { name: 'Next line' })).not.toBeInTheDocument();
    expect(fireEvent.keyDown(search, { key: 'Enter' })).toBe(false);
    await waitFor(() =>
      expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ medicineId: 'second-result', quantity: 1 })
      )
    );
    expect(screen.queryByLabelText('Quantity')).not.toBeInTheDocument();
  });

  it('keeps the default quantity of 1 as a proposal in the line form: Enter moves to Quantity, a second Enter adds once', async () => {
    const { search } = searchResults();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter', shiftKey: true });
    const quantity = screen.getByLabelText('Quantity');
    expect(quantity).toHaveValue('1');
    search.focus();
    expect(fireEvent.keyDown(search, { key: 'Enter' })).toBe(false);
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(quantity);
    expect(fireEvent.keyDown(quantity, { key: 'Enter' })).toBe(false);
    await waitFor(() =>
      expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ medicineId: rows[0]!.medicineId, quantity: 1 })
      )
    );
  });

  it.each(['scan', 'quantity'] as const)(
    'adds the selected quantity once with Enter from %s',
    async (field) => {
      const { search } = searchResults();
      fireEvent.keyDown(search, { key: 'ArrowDown' });
      fireEvent.keyDown(search, { key: 'Enter', shiftKey: true });
      const quantity = screen.getByLabelText('Quantity');
      fireEvent.change(quantity, { target: { value: '2' } });
      const target = field === 'scan' ? search : quantity;
      target.focus();
      expect(fireEvent.keyDown(target, { key: 'Enter' })).toBe(false);
      await waitFor(() =>
        expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ medicineId: rows[0]!.medicineId, quantity: 2 })
        )
      );
    }
  );

  it('allows F9 from Quantity and blocks F6/F9 while a dialog is open', async () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() => mocks.searchProps.mock.calls.at(-1)![0].onSelect(rows[0]!));
    const quantity = screen.getByLabelText('Quantity');
    quantity.focus();
    fireEvent.change(quantity, { target: { value: '2' } });
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    try {
      expect(fireEvent.keyDown(quantity, { key: 'F6' })).toBe(true);
      expect(fireEvent.keyDown(quantity, { key: 'F9' })).toBe(true);
      expect(mocks.mutations.addLine).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog', { name: /^Take payment/ })).not.toBeInTheDocument();
    } finally {
      dialog.remove();
    }
    expect(fireEvent.keyDown(quantity, { key: 'F9' })).toBe(false);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText('Amount').closest('[tabindex="-1"]')
      )
    );
  });

  it('keeps modified arrows and composing Enter with the scan field', () => {
    const { search } = searchResults();
    expect(fireEvent.keyDown(search, { key: 'ArrowDown', shiftKey: true })).toBe(true);
    // DEV-977B: the first result stays highlighted until a plain arrow moves; the modified
    // arrow moved nothing, so the first plain ArrowDown lands on the first result.
    expect(mocks.searchProps.mock.calls.at(-1)![0].activeMedicineId).toBe(rows[0]!.medicineId);
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(mocks.searchProps.mock.calls.at(-1)![0].activeMedicineId).toBe(rows[0]!.medicineId);
    expect(fireEvent.keyDown(search, { key: 'Enter', isComposing: true })).toBe(true);
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
  });
});

describe('DEV-957 enrolled counter computer', () => {
  const enrolled = (branchId: string) =>
    window.localStorage.setItem(
      'devfathom.pharmacy.counter.enrolled',
      JSON.stringify({
        organizationId: 'org-a',
        branchId,
        deviceId: 'device-enrolled',
        name: 'Front counter',
        enrolledAt: '2026-11-19T08:00:00.000Z',
      })
    );
  const drawerDevices = () =>
    mocks.queryInputs.mock.calls
      .filter(([name]) => name === 'drawerStatus')
      .map(([, input]) => (input as { deviceId: string }).deviceId);

  it('opens the drawer under the enrolled device id at its own branch', () => {
    enrolled('branch-a');
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    expect(drawerDevices().at(-1)).toBe('device-enrolled');
  });

  it('keeps the per-browser id at another branch and when not enrolled', () => {
    window.localStorage.setItem('devfathom.pharmacy.counter.device', 'counter-browser');
    enrolled('branch-other');
    const view = render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    expect(drawerDevices().at(-1)).toBe('counter-browser');
    view.unmount();
    window.localStorage.removeItem('devfathom.pharmacy.counter.enrolled');
    mocks.queryInputs.mockClear();
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    expect(drawerDevices().at(-1)).toBe('counter-browser');
  });

  it('says offline mode is not set up on an unenrolled computer, beside the existing banner', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      render(<PharmacyCounterConsole initialBranchId="branch-a" />);
      expect(
        screen.getByText('Search, bill changes and payments wait until the connection returns.')
      ).toBeInTheDocument();
      expect(screen.getByText(/This computer is not set up for offline mode/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Settings, Counter computers' })).toHaveAttribute(
        'href',
        '/pharmacy/settings/counters'
      );
    } finally {
      onLine.mockRestore();
    }
  });

  it('opens an offline page, not "no branch", when nothing could be loaded with no connection', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      enrolled('branch-a');
      mocks.queries.counterBranches = { ...query(undefined), isSuccess: false };
      render(<PharmacyCounterConsole />);
      expect(screen.getByRole('heading', { name: 'Counter', level: 1 })).toBeInTheDocument();
      expect(
        screen.getByText('Offline — this counter cannot reach the server.')
      ).toBeInTheDocument();
      expect(screen.queryByText('No active branch is configured yet.')).not.toBeInTheDocument();
      // This browser has no IndexedDB here, so it says plainly why offline mode is off.
      expect(
        await screen.findByText(/counter key is missing|blocks local storage/)
      ).toBeInTheDocument();
    } finally {
      onLine.mockRestore();
    }
  });

  it('keeps the counter on screen offline when a session re-check cannot reach the server', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    try {
      const view = render(<PharmacyCounterConsole initialBranchId="branch-a" />);
      onLine.mockReturnValue(false);
      act(() => {
        window.dispatchEvent(new Event('offline'));
      });
      mocks.session = { status: 'unauthenticated', data: null } as unknown as typeof mocks.session;
      view.rerender(<PharmacyCounterConsole initialBranchId="branch-a" />);
      expect(
        screen.getByText('Offline — this counter cannot reach the server.')
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/Sign in with an authorized pharmacy account/)
      ).not.toBeInTheDocument();
      // Online, the live answer is used unchanged.
      onLine.mockReturnValue(true);
      act(() => {
        window.dispatchEvent(new Event('online'));
      });
      expect(screen.getByText(/Sign in with an authorized pharmacy account/)).toBeInTheDocument();
    } finally {
      onLine.mockRestore();
    }
  });
});

describe('DEV-977 Counter v2 sale screen (phase 1: frame, search, bill, totals)', () => {
  it('puts the counter heading, branch, bill status and connection in its own bar', () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const bar = screen.getByRole('banner');
    expect(within(bar).getByRole('heading', { level: 1, name: 'Counter' })).toBeInTheDocument();
    expect(within(bar).getByRole('combobox', { name: 'Branch' })).toBeInTheDocument();
    expect(within(bar).getByLabelText('Bill status')).toHaveTextContent('Bill open · 1 line');
    expect(within(bar).getByText('Online')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('shows Offline in the bar when the connection drops', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      expect(within(screen.getByRole('banner')).getByText('Offline')).toBeInTheDocument();
      expect(within(screen.getByRole('banner')).queryByText('Online')).not.toBeInTheDocument();
    } finally {
      onLine.mockRestore();
    }
  });

  it('closes More on Escape, back to its button, and on a press outside it', () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const more = screen.getByRole('button', { name: 'More' });
    const panel = document.getElementById('counter-actions')!;
    expect(more).toHaveAttribute('aria-controls', 'counter-actions');
    fireEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(panel).toHaveClass('flex');
    // A press inside the menu keeps it open.
    const shortcuts = within(panel).getByRole('button', { name: 'Shortcuts' });
    fireEvent.pointerDown(shortcuts);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    shortcuts.focus();
    fireEvent.keyDown(shortcuts, { key: 'Escape' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(panel).toHaveClass('hidden');
    expect(more).toHaveFocus();
    fireEvent.click(more);
    fireEvent.pointerDown(screen.getByLabelText('Scan or search'));
    expect(more).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps every counter action reachable from the bar', () => {
    mocks.session.data.user.role = 'ADMIN';
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const panel = document.getElementById('counter-actions')!;
    for (const name of ['Returns', 'Sign out', 'Shortcuts'])
      expect(within(panel).getByRole('button', { name })).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Customer orders' })).toHaveAttribute(
      'href',
      '/pharmacy/orders'
    );
    expect(screen.getByRole('banner')).toContainElement(panel);
  });

  it('drops search results over the bill and keeps them for screen readers while idle', async () => {
    mocks.queries.counterSearch = query({ rows: [barcodeRow()], truncated: false });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const results = document.querySelector('[data-counter-results]')!;
    expect(results).toHaveClass('sr-only');
    expect(document.getElementById('counter-scan-search')).toContainElement(results as HTMLElement);
    fireEvent.change(screen.getByLabelText('Scan or search'), { target: { value: 'para' } });
    await waitFor(() => expect(results).toHaveClass('absolute', 'top-full'));
    expect(results).not.toHaveClass('sr-only');
    expect(within(results as HTMLElement).getByText('1 result')).toBeInTheDocument();
  });

  // DEV-977B (phase 2A): the line form opens only on purpose or for an exception, and then in
  // the bill column above the bill. The payment column (totals, Take payment) never moves.
  it('keeps the line form out of the search and out of the payment column', () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const rail = screen.getByRole('complementary', { name: 'Bill total' });
    expect(rail).toHaveClass('lg:row-span-3', 'lg:row-start-1');
    act(() => mocks.searchProps.mock.lastCall![0].onSelect(barcodeRow()));
    const next = screen.getByRole('region', { name: 'Next line' });
    expect(document.getElementById('counter-scan-search')).not.toContainElement(next);
    expect(rail).not.toContainElement(next);
    // It sits in the bill column, which scrolls on its own, above the bill.
    const column = document.querySelector('[data-counter-bill-column]')!;
    expect(column).toContainElement(next);
    expect(column).toContainElement(screen.getByRole('region', { name: 'Cart' }));
    expect(column).toHaveClass('lg:col-start-1', 'lg:row-start-3', 'lg:overflow-y-auto');
    expect(rail).toHaveClass('lg:row-span-3', 'lg:row-start-1');
  });

  it('closes the results once a medicine is chosen, keeps them while arrowing, reopens on typing', async () => {
    mocks.queries.counterSearch = query({
      rows: [
        barcodeRow(),
        barcodeRow({ medicineId: 'med-second', presentationId: 'presentation-b' }),
      ],
      truncated: false,
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const results = document.querySelector('[data-counter-results]')!;
    const search = screen.getByLabelText('Scan or search');
    fireEvent.change(search, { target: { value: 'para' } });
    await waitFor(() => expect(results).toHaveClass('absolute'));
    // DEV-977B: arrowing highlights a row, stages nothing, and keeps the list open.
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(screen.queryByRole('region', { name: 'Next line' })).not.toBeInTheDocument();
    expect(results).toHaveClass('absolute');
    expect(results).not.toHaveClass('hidden');
    // Choosing a row (a click on the results, or Enter) closes the list over the bill and
    // keeps the chosen medicine staged.
    act(() => mocks.searchProps.mock.lastCall![0].onSelect(barcodeRow()));
    expect(results).toHaveClass('hidden');
    expect(screen.getByRole('region', { name: 'Next line' })).toBeInTheDocument();
    expect(search).toHaveValue('para');
    // Arrowing again, or typing, opens it again.
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(results).not.toHaveClass('hidden');
    act(() => mocks.searchProps.mock.lastCall![0].onSelect(barcodeRow()));
    expect(results).toHaveClass('hidden');
    fireEvent.change(search, { target: { value: 'parac' } });
    await waitFor(() => expect(results).not.toHaveClass('hidden'));
  });

  it('shows the server totals, the balance due and Take payment with its key', () => {
    mocks.queries.counterCart!.data = cart({
      totals: { grossMinor: 30000, discountMinor: 5000, netMinor: 25000, tenderedMinor: 10000 },
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const rail = screen.getByLabelText('Bill total');
    const value = (label: string) =>
      within(rail).getByText(label, { selector: 'dt' }).nextElementSibling;
    expect(value('Gross')).toHaveTextContent('300.00');
    expect(value('Discount')).toHaveTextContent('50.00');
    expect(value('Total')).toHaveTextContent('250.00');
    expect(value('Tendered')).toHaveTextContent('100.00');
    expect(within(rail).getByText('Balance due')).toBeInTheDocument();
    expect(within(rail).getByText('150.00')).toBeInTheDocument();
    expect(within(rail).getByRole('button', { name: /^Take payment ?· ?F9$/ })).toBeEnabled();
    expect(
      within(screen.getByLabelText('Phone payment')).getByRole('button', {
        name: /^Take payment ?· ?F9$/,
      })
    ).toBeEnabled();
  });

  it('starts an empty counter with the keys that start a bill', () => {
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    const cartRegion = screen.getByRole('region', { name: 'Cart' });
    expect(within(cartRegion).getByRole('heading', { name: 'Start a bill' })).toBeInTheDocument();
    expect(cartRegion).toHaveTextContent(
      'No bill is open. Search for a medicine and add a line to start one.'
    );
    expect(cartRegion).toHaveTextContent('F2 search');
    expect(cartRegion).toHaveTextContent('F9 take payment');
  });

  it('shows the customer on the bill and links one from the payment column', () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const rail = screen.getByLabelText('Bill total');
    expect(within(rail).getByText('Walk-in customer')).toBeInTheDocument();
    fireEvent.click(within(rail).getByRole('button', { name: 'Link customer' }));
    expect(screen.getByRole('dialog', { name: 'Customer loyalty and khata' })).toBeInTheDocument();
  });
});

describe('DEV-977B Counter v2 phase 2A: one-step add, quantity and unit on the bill line', () => {
  const STRIP = {
    kind: 'STRIP' as const,
    packLevelId: 'pack-a',
    levelLabel: 'STRIP',
    canonicalUnitsPerSaleUnit: 10,
  };
  const LOOSE = {
    kind: 'UNIT' as const,
    packLevelId: 'pack-a',
    levelLabel: 'UNIT',
    canonicalUnitsPerSaleUnit: 1,
  };
  const twoUnitRow = () =>
    barcodeRow({ unitsPerPack: 10, onHandUnits: 50, saleUnits: [STRIP, LOOSE] });
  function editableCart(overrides: Partial<CounterCart['lines'][number]> = {}) {
    const base = cart();
    return cart({
      lines: [
        {
          ...base.lines[0]!,
          medicineId: 'med-barcode',
          saleUnit: 'STRIP',
          quantity: 2,
          canonicalUnits: 20,
          packLevelId: 'pack-a',
          canonicalUnitsPerSaleUnit: 10,
          ...overrides,
        },
      ],
    });
  }

  it('adds a pressed result in one step, in the unit chosen under Adds as', async () => {
    mocks.mutations.addLine!.mockResolvedValue({});
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const addsAs = screen.getByRole('radiogroup', { name: 'Adds as' });
    expect(within(addsAs).getAllByRole('radio')).toHaveLength(3);
    // F4 chooses strip before anything is searched.
    fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key: 'F4' });
    expect(within(addsAs).getByRole('radio', { name: /Strip/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    act(() => mocks.searchProps.mock.lastCall![0].onAdd!(twoUnitRow()));
    await waitFor(() =>
      expect(mocks.mutations.addLine).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          medicineId: 'med-barcode',
          saleUnit: 'STRIP',
          canonicalUnitsPerSaleUnit: 10,
          quantity: 1,
        })
      )
    );
    expect(screen.queryByRole('region', { name: 'Next line' })).not.toBeInTheDocument();
    // F5 then adds loose units.
    fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key: 'F5' });
    act(() => mocks.searchProps.mock.lastCall![0].onAdd!(twoUnitRow()));
    await waitFor(() =>
      expect(mocks.mutations.addLine).toHaveBeenLastCalledWith(
        expect.objectContaining({ saleUnit: 'UNIT', canonicalUnitsPerSaleUnit: 1, quantity: 1 })
      )
    );
  });

  it('opens the line form instead of adding when the stock cannot cover one', () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    act(() =>
      mocks.searchProps.mock.lastCall![0].onAdd!(
        barcodeRow({ unitsPerPack: 10, onHandUnits: 5, saleUnits: [STRIP] })
      )
    );
    expect(screen.getByRole('region', { name: 'Next line' })).toBeInTheDocument();
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
  });

  it('changes the quantity on the bill line through the server, once per change', async () => {
    mocks.queries.counterCart = { ...query(editableCart()), refetch: mocks.refetch };
    mocks.mutations.changeLine!.mockResolvedValue({ line: { id: 'line-b' }, replayed: false });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const cartRegion = screen.getByRole('region', { name: 'Cart' });
    fireEvent.click(within(cartRegion).getByRole('button', { name: '+ Synthetic item' }));
    await waitFor(() =>
      expect(mocks.mutations.changeLine).toHaveBeenCalledExactlyOnceWith({
        branchId: 'branch-a',
        saleId: 'sale-a',
        saleLineId: 'line-a',
        packLevelId: 'pack-a',
        saleUnit: 'STRIP',
        quantity: 3,
        canonicalUnitsPerSaleUnit: 10,
        idempotencyKey: expect.stringMatching(/^counter-change:/),
        // DEV-958B: the counter's device, whose drawer's shift the server checks.
        deviceId: expect.stringMatching(/^counter-/),
      })
    );
    expect(await screen.findByText('Synthetic item: 3 × strip.')).toBeInTheDocument();
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
  });

  it('retries a lost change under the same key, and says who may change another cashier’s bill', async () => {
    mocks.queries.counterCart = { ...query(editableCart()), refetch: mocks.refetch };
    mocks.mutations.changeLine!.mockRejectedValueOnce(new Error('NOT_BILL_OWNER'));
    mocks.mutations.changeLine!.mockRejectedValueOnce(new Error('NOT_BILL_OWNER'));
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const plus = () =>
      within(screen.getByRole('region', { name: 'Cart' })).getByRole('button', {
        name: '+ Synthetic item',
      });
    fireEvent.click(plus());
    expect(
      await screen.findByText(
        'Another cashier opened this bill. Only that cashier or a manager or owner can change its lines.'
      )
    ).toBeInTheDocument();
    fireEvent.click(plus());
    await waitFor(() => expect(mocks.mutations.changeLine).toHaveBeenCalledTimes(2));
    const [first, second] = mocks.mutations.changeLine!.mock.calls.map(
      ([input]) => (input as { idempotencyKey: string }).idempotencyKey
    );
    expect(second).toBe(first);
  });

  it('removes a line from the bill through the server', async () => {
    mocks.queries.counterCart = { ...query(editableCart()), refetch: mocks.refetch };
    mocks.mutations.removeLine!.mockResolvedValue({ saleLineId: 'line-a', removed: true });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Cart' })).getByRole('button', {
        name: 'Remove Synthetic item',
      })
    );
    await waitFor(() =>
      expect(mocks.mutations.removeLine).toHaveBeenCalledExactlyOnceWith({
        branchId: 'branch-a',
        saleId: 'sale-a',
        saleLineId: 'line-a',
        idempotencyKey: expect.stringMatching(/^counter-remove:/),
        // DEV-958B: the counter's device, whose drawer's shift the server checks.
        deviceId: expect.stringMatching(/^counter-/),
      })
    );
    expect(await screen.findByText('Synthetic item removed from the bill.')).toBeInTheDocument();
  });

  it('switches a line to loose units with the unit control on the line', async () => {
    mocks.queries.counterCart = { ...query(editableCart()), refetch: mocks.refetch };
    mocks.queries.counterSearch = query({ rows: [twoUnitRow()], truncated: false });
    mocks.mutations.changeLine!.mockResolvedValue({ line: { id: 'line-b' }, replayed: false });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const units = within(screen.getByRole('region', { name: 'Cart' })).getByRole('radiogroup', {
      name: 'Sold as: Synthetic item',
    });
    fireEvent.click(within(units).getByRole('radio', { name: 'Unit' }));
    await waitFor(() =>
      expect(mocks.mutations.changeLine).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ saleUnit: 'UNIT', canonicalUnitsPerSaleUnit: 1, quantity: 2 })
      )
    );
  });

  it('locks every line once payment has been taken on the bill', () => {
    mocks.queries.counterCart = {
      ...query({
        ...editableCart(),
        totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 1000 },
      }),
      refetch: mocks.refetch,
    };
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const cartRegion = screen.getByRole('region', { name: 'Cart' });
    expect(within(cartRegion).getByRole('button', { name: '+ Synthetic item' })).toBeDisabled();
    expect(
      within(cartRegion).getByRole('button', { name: 'Remove Synthetic item' })
    ).toBeDisabled();
  });

  it('keeps every line read-only while the counter is offline: a change needs the server', () => {
    mocks.queries.counterCart = { ...query(editableCart()), refetch: mocks.refetch };
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      const cartRegion = screen.getByRole('region', { name: 'Cart' });
      for (const name of ['+ Synthetic item', '− Synthetic item', 'Remove Synthetic item']) {
        const button = within(cartRegion).getByRole('button', { name });
        expect(button).toBeDisabled();
        fireEvent.click(button);
      }
      expect(within(cartRegion).getByLabelText('Quantity: Synthetic item')).toBeDisabled();
      expect(mocks.mutations.changeLine).not.toHaveBeenCalled();
      expect(mocks.mutations.removeLine).not.toHaveBeenCalled();
    } finally {
      onLine.mockRestore();
    }
  });

  it('keeps every line read-only between cash shifts, as adding and payment are', () => {
    mocks.queries.counterCart = { ...query(editableCart()), refetch: mocks.refetch };
    // DEV-958B: the drawer runs shifts and none is open; the server refuses a change too.
    mocks.queries.drawerStatus = query({
      openDrawer: { id: 'drawer-default' },
      cashShift: { openShift: null, lastClosedShift: null, currency: 'PKR' },
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const cartRegion = screen.getByRole('region', { name: 'Cart' });
    for (const name of ['+ Synthetic item', '− Synthetic item', 'Remove Synthetic item']) {
      const button = within(cartRegion).getByRole('button', { name });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(within(cartRegion).getByLabelText('Quantity: Synthetic item')).toBeDisabled();
    expect(mocks.mutations.changeLine).not.toHaveBeenCalled();
    expect(mocks.mutations.removeLine).not.toHaveBeenCalled();
  });

  it('closes the results with Escape and keeps what was typed', async () => {
    mocks.queries.counterSearch = query({ rows: [barcodeRow()], truncated: false });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const results = document.querySelector('[data-counter-results]')!;
    const search = screen.getByLabelText('Scan or search');
    fireEvent.change(search, { target: { value: 'para' } });
    await waitFor(() => expect(results).toHaveClass('absolute'));
    expect(fireEvent.keyDown(search, { key: 'Escape' })).toBe(false);
    expect(results).toHaveClass('hidden');
    expect(search).toHaveValue('para');
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
    // Arrowing opens them again.
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(results).not.toHaveClass('hidden');
  });

  it('says a slow search is still running', async () => {
    mocks.queries.counterSearch = { ...query(undefined), isFetching: true };
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.change(screen.getByLabelText('Scan or search'), { target: { value: 'para' } });
    await waitFor(() => expect(mocks.searchProps.mock.lastCall![0].state).toBe('loading'));
    expect(mocks.searchProps.mock.lastCall![0].slow).toBe(false);
    await waitFor(() => expect(mocks.searchProps.mock.lastCall![0].slow).toBe(true), {
      timeout: COUNTER_SLOW_SEARCH_MS + 1500,
    });
  });
});

describe('DEV-977 phase 2B: the counter panels in the Counter v2 sheets', () => {
  it('heads the payment sheet with the bill, names it with the total and puts the counter controls in the summary', () => {
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const payment = screen.getByRole('dialog', { name: 'Take payment · 250.00' });
    expect(payment).toHaveAttribute('data-counter-sheet', 'wide');
    expect(within(payment).getByText(/^Bill · \d+ lines?$/)).toHaveAttribute(
      'data-slot',
      'eyebrow'
    );
    // The full screen below 1024px; a centred dialog up to 1000px from 1024px.
    expect(payment.className).toContain('inset-0');
    expect(payment.className).toContain('lg:w-[min(62.5rem,calc(100vw-4rem))]');
    const summary = within(payment).getByRole('region', { name: 'Payment summary' });
    expect(
      within(summary).getByLabelText('Automatically open print dialog after payment')
    ).toBeInTheDocument();
    expect(within(summary).getByText(/Tendered/)).toBeInTheDocument();
    const back = within(summary).getByRole('button', { name: 'Back to bill' });
    // The close control is an icon with a name; Back to bill still closes the sheet.
    expect(within(payment).getByRole('button', { name: 'Close' }).textContent).toBe('');
    fireEvent.click(back);
    expect(screen.queryByRole('dialog', { name: /^Take payment/ })).not.toBeInTheDocument();
  });

  it('draws the offline banner with its mark, its pill and the price-check-only truth (B2, C7)', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    try {
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      onLine.mockReturnValue(false);
      act(() => {
        window.dispatchEvent(new Event('offline'));
      });
      const banner = document.querySelector('[data-counter-offline]') as HTMLElement;
      expect(banner).toHaveAttribute('role', 'status');
      expect(banner.firstElementChild?.tagName.toLowerCase()).toBe('svg');
      expect(banner.firstElementChild).toHaveAttribute('aria-hidden', 'true');
      const title = screen.getByText('Offline — this counter cannot reach the server.');
      expect(within(title).getByText('Offline')).toHaveAttribute('data-slot', 'status-pill');
      // Offline selling is off: the banner never offers offline bills.
      expect(banner).toHaveTextContent(
        'Search, bill changes and payments wait until the connection returns.'
      );
      expect(banner).not.toHaveTextContent(/as offline bills/);
    } finally {
      onLine.mockRestore();
    }
  });

  it('heads the receipt as a side sheet with its number after a confirmed payment (A3, C5)', async () => {
    const completeCounterReceipt = issuedReceipt();
    mocks.receiptRefetch.mockImplementationOnce(async () => {
      mocks.queries.counterReceipt!.data = completeCounterReceipt;
      return { isSuccess: true, data: completeCounterReceipt };
    });
    mocks.mutations.tender!.mockResolvedValue(accepted(0));
    mocks.refetch.mockImplementation(async () => {
      mocks.queries.counterCart!.data = cart({
        status: 'COMPLETED',
        receiptNumber: 42,
        totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 25000 },
      });
      return mocks.queries.counterCart;
    });
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '250.00' } });
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '300.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment', hidden: true }));
    await screen.findByText('Payment recorded.');
    const receipt = screen.getByRole('dialog', { name: 'Receipt preview' });
    expect(receipt).toHaveAttribute('data-counter-sheet', 'side');
    expect(within(receipt).getByText('Receipt 42')).toHaveAttribute('data-slot', 'eyebrow');
    expect(within(receipt).getByRole('region', { name: 'Change due' })).toHaveTextContent('50.00');
    // The paid bill is marked by a check as well as its words.
    const paid = screen.getByText('Paid · receipt 42');
    expect(paid.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
