import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COUNTER_CASH_DRAWER_CLOSED_MESSAGE } from '@/lib/pharmacy/counter-messages';
import type { ComponentProps } from 'react';

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

const mocks = vi.hoisted(() => ({
  queries: {} as Record<string, Query>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  pausedMutations: new Set<string>(),
  refetch: vi.fn(),
  searchFetch: vi.fn(),
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
  khataApprovers: vi.fn(),
  signIn: vi.fn(),
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

vi.mock('next-auth/react', () => ({ useSession: () => mocks.session, signIn: mocks.signIn }));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => mocks.entitlements,
}));

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
        khataOverLimitApprovers: { query: mocks.khataApprovers },
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
      drawerStatus: { invalidate: mocks.drawerStatusInvalidate },
      counterKeymap: { setData: mocks.keymapSetData, invalidate: vi.fn() },
    },
    pharmacyPrescriptions: { counterPatientPanel: { invalidate: vi.fn() } },
    pharmacySafety: { controlledRegister: { invalidate: vi.fn() } },
  };
  return {
    trpc: {
      useUtils: () => utils,
      pharmacySales: router([
        'manualPaymentSettings',
        'counterBranches',
        'counterReceiptFormat',
        'counterKeymap',
        'counterSaveKeymap',
        'counterSearch',
        'counterCart',
        'counterReceipt',
        'counterLotOptions',
        'counterEvidence',
        'customerSnapshot',
        'drawerStatus',
        'create',
        'addLine',
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
        'khataSignup',
        'redeemPoints',
        'authenticatePack',
        'substituteProposals',
        'refundAccess',
      ]),
      pharmacyPrescriptions: router(['counterPatients', 'counterPatientPanel']),
      pharmacySafety: router(['controlledPharmacists']),
      pharmacyAccess: router(['navigation']),
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
vi.mock('./counter-search-results', () => ({
  CounterSearchResults: (props: ComponentProps<typeof CounterSearchResults>) => {
    mocks.searchProps(props);
    return null;
  },
}));
vi.mock('./counter-substitute-proposals', () => ({ CounterSubstituteProposals: () => null }));
vi.mock('./counter-upsell-suggestions', () => ({ CounterUpsellSuggestions: () => null }));

import { PharmacyCounterConsole } from './counter-console';
import { resolveCounterKeymap } from '@/lib/pharmacy/counter-keymap';
import {
  persistTenderAttempt,
  readTenderAttempt,
  TENDER_STORAGE_MESSAGE,
  tenderAttemptStorageKey,
  type TenderAttempt,
} from './tender-attempt-storage';

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
  return within(screen.getByRole('group', { name: 'Tender', hidden: true })).getByRole('button', {
    name: TENDER_LABELS[type],
    hidden: true,
  });
}

function chooseTender(type: string) {
  fireEvent.click(tenderButton(type));
}

function enterPayment(type = 'CASH') {
  chooseTender(type);
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '125.50' } });
  if (type === 'CASH')
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '200.00' } });
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
  ])
    mocks.queries[name] = query();
  // A counter taking cash has an open drawer; tests about a closed drawer say so.
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
    'khataSignup',
    'redeemPoints',
    'authenticatePack',
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
  mocks.signIn.mockResolvedValue({ ok: true });
  window.localStorage.clear();
});

afterEach(() => vi.restoreAllMocks());

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
    await waitFor(() => expect(screen.getByLabelText('Recorded tenders').children).toHaveLength(1));
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
    await waitFor(() => expect(screen.getByLabelText('Recorded tenders').children).toHaveLength(2));
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
      expect(screen.getByText('Take payment').closest('button')).toBeDisabled();
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
    const body = document.createElement('div');
    const print = vi.fn();
    vi.spyOn(window, 'open').mockReturnValue({
      opener: window,
      document: { title: '', createElement: document.createElement.bind(document), body },
      focus: vi.fn(),
      print,
      close: vi.fn(),
    } as never);
    renderPayment(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    chooseTender('KHATA');
    await screen.findByText(/Ledger balance/);
    fireEvent.click(screen.getByRole('button', { name: 'Print Khata statement' }));
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
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

  it('DEV-714: re-reads the drawer status each time payment opens', () => {
    const drawerStatus = query({ openDrawer: null });
    mocks.queries.drawerStatus = drawerStatus;
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(drawerStatus.refetch).not.toHaveBeenCalled();
    // DEV-725: with the drawer closed the opening step replaces the scan field.
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

  it('records the opening cash the cashier counted, in minor units (DEV-725)', async () => {
    closeDrawer();
    mocks.mutations.openDrawer!.mockResolvedValue(openDrawer);
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    fireEvent.change(screen.getByLabelText('Opening cash'), { target: { value: '5000.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    await screen.findByText('Cash drawer opened for this counter.');
    expect(mocks.mutations.openDrawer).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 'branch-a', openingFloatMinor: 500050 })
    );
  });

  it.each(['', 'abc', '-5', '1.234'])(
    'refuses to open the drawer without a valid opening cash amount: %j (DEV-725)',
    (value) => {
      closeDrawer();
      render(<PharmacyCounterConsole initialBranchId="branch-a" />);
      const field = screen.getByLabelText('Opening cash');
      fireEvent.change(field, { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
      expect(screen.getByRole('alert')).toHaveTextContent('Enter the opening cash');
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(mocks.mutations.openDrawer).not.toHaveBeenCalled();
    }
  );

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
    act(() => mocks.searchProps.mock.calls.at(-1)![0].onSelect(barcodeRow()));
    const quantity = screen.getByLabelText('Quantity');
    quantity.focus();
    fireEvent.keyDown(quantity, { key: 'F9' });
    expect(document.activeElement).toBe(quantity);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key: 'F9' });
    expect(screen.queryByRole('dialog', { name: 'Payment' })).not.toBeInTheDocument();
    dialog.remove();
    screen.getByLabelText('Scan or search').focus();
    fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key: 'F9' });
    const amount = screen.getByLabelText('Amount');
    await waitFor(() => expect(document.activeElement).toBe(amount.closest('[tabindex="-1"]')));
    amount.focus();
    fireEvent.keyDown(amount, { key: 'F9' });
    expect(document.activeElement).toBe(amount);
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
    await waitFor(() =>
      expect(mocks.mutations.transition).toHaveBeenCalledWith(
        expect.objectContaining({ saleId: 'sale-a', action: 'void' })
      )
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
});

describe('PharmacyCounterConsole controlled authorization visibility (QA-138)', () => {
  it('hides the controlled authorization panel from an actor who cannot dispense', () => {
    Object.assign(mocks.queries.controlledPharmacists!, {
      isSuccess: false,
      isError: true,
      error: Object.assign(new Error('Forbidden'), { data: { code: 'FORBIDDEN' } }),
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(screen.queryByTestId('controlled-authorization')).toBeNull();
  });

  it('shows the controlled authorization panel to a dispenser', () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(screen.getByTestId('controlled-authorization')).toBeTruthy();
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
    const dialog = screen.getByRole('dialog', { name: 'Payment' });
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
          ).getByRole('button', { name: /Pay/ })
        );
      const dialog = screen.getByRole('dialog', { name: 'Payment' });
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
      within(screen.getByRole('dialog', { name: 'Payment' })).getByLabelText('Amount')
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
    expect(input).toHaveValue('');
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
    expect(input).toHaveAccessibleDescription(/Only 5 safe units are on hand/);
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
    expect(input.value).toBe('');
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
    expect(quantity).toHaveValue('');
    fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key: 'F6' });
    expect(within(next).getByText('Enter a quantity')).toBeVisible();
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
    fireEvent.change(quantity, { target: { value: '1' } });
    expect(quantity).toHaveValue('1');
    expect(within(next).getByText('Covered · 100 units on hand')).toBeInTheDocument();
    for (const [key, name] of [
      ['F5', /^Unit/],
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
    for (const label of ['Gross', 'Discount', 'Tendered'])
      expect(within(rail).getByText(label)).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Cart' })).queryByRole('button', { name: /^Hold/ })
    ).not.toBeInTheDocument();
    const pay = within(rail).getByRole('button', { name: /Pay/ });
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
    await waitFor(() =>
      expect(mocks.mutations.transition).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'void', saleId: 'sale-a' })
      )
    );
  });

  it('hides the unconfirmed preset from a cashier in the shortcuts dialog', () => {
    render(<PharmacyCounterConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
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
      fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
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
      expect(within(dialog).getByText('Placeholder')).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
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
    expect(within(branch).getByRole('option', { name: 'Model Town · MT1' })).toBeInTheDocument();
    expect(screen.getByLabelText('Bill status')).toHaveTextContent('Bill open · 1 line');
    expect(screen.getByLabelText('Bill status')).toHaveTextContent('Drawer open');
    expect(screen.getByText('No safety blocks · 0 notes to pass on')).toBeInTheDocument();
    expect(screen.getByText('Loyalty and khata · not linked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(document.getElementById('counter-actions')).toHaveClass('hidden', 'md:flex');
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('button', { name: 'Actions' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
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
