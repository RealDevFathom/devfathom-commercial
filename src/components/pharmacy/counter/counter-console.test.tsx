import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';

import type { CounterCart, CounterSearchRow } from '@/lib/pharmacy/counter';
import type { CounterReceipt } from '@/lib/pharmacy/counter-receipt';
import type { CounterReceiptViewProps } from './counter-receipt-view';

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
  refetch: vi.fn(),
  cancel: vi.fn(),
  receiptInvalidate: vi.fn(),
  mutationOptions: vi.fn(),
  receiptProps: vi.fn(),
  renderReceipt: false,
  renderRx: false,
  outcomeQuery: vi.fn(),
  receiptRefetch: vi.fn(),
  liveSearch: false,
  searchFetch: vi.fn(),
  session: {
    status: 'authenticated',
    data: {
      user: { id: 'account-a', organizationId: 'org-a', status: 'ACTIVE', sessionRevoked: false },
    },
  },
  entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'] },
}));

vi.mock('next-auth/react', () => ({ useSession: () => mocks.session }));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => mocks.entitlements,
}));

vi.mock('@/lib/trpc', async () => {
  const { useQuery, QueryClient } = await import('@tanstack/react-query');
  const idleClient = new QueryClient();
  function useCounterSearch(input: unknown, options: { enabled?: boolean; staleTime?: number }) {
    // Exercise the real query cache/observer without issuing requests in the bill-state tests.
    const result = useQuery(
      {
        queryKey: ['counterSearch', input],
        queryFn: () => mocks.searchFetch(input),
        ...options,
        enabled: mocks.liveSearch && options.enabled,
        retry: false,
      },
      mocks.liveSearch ? undefined : idleClient
    );
    return mocks.liveSearch ? result : mocks.queries.counterSearch;
  }
  const router = (names: string[]) =>
    Object.fromEntries(
      names.map((name) => [
        name,
        {
          useQuery: name === 'counterSearch' ? useCounterSearch : () => mocks.queries[name],
          useMutation: (options: unknown) => {
            mocks.mutationOptions(name, options);
            return {
              mutateAsync: mocks.mutations[name],
              mutate: mocks.mutations[name],
              isPending: false,
              error: null,
            };
          },
        },
      ])
    );
  const utils = {
    client: { pharmacySales: { tenderOutcome: { query: mocks.outcomeQuery } } },
    pharmacySales: {
      counterCart: { cancel: mocks.cancel, invalidate: vi.fn() },
      counterReceipt: { invalidate: mocks.receiptInvalidate },
      counterSearch: { invalidate: vi.fn() },
    },
    pharmacyPrescriptions: { counterPatientPanel: { invalidate: vi.fn() } },
    pharmacySafety: { controlledRegister: { invalidate: vi.fn() } },
  };
  return {
    trpc: {
      useUtils: () => utils,
      pharmacySales: router([
        'counterBranches',
        'counterKeymap',
        'counterSaveKeymap',
        'counterSearch',
        'counterCart',
        'counterReceipt',
        'customerSnapshot',
        'create',
        'addLine',
        'transition',
        'tender',
        'openDrawer',
        'captureDemand',
        'declineSubstitute',
        'linkCustomer',
        'redeemPoints',
        'authenticatePack',
        'substituteProposals',
        'lookupReceiptByNumber',
        'returnHistory',
        'returnLine',
        'refundTender',
      ]),
      pharmacyPrescriptions: router(['counterPatients', 'counterPatientPanel']),
      pharmacySafety: router(['controlledPharmacists']),
    },
  };
});

vi.mock('./counter-receipt-view', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./counter-receipt-view')>();
  return {
    CounterReceiptView: (props: CounterReceiptViewProps) => {
      mocks.receiptProps(props);
      return mocks.renderReceipt ? <actual.CounterReceiptView {...props} /> : null;
    },
  };
});
vi.mock('./counter-rx-panel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./counter-rx-panel')>();
  return {
    CounterRxPanel: (props: React.ComponentProps<typeof actual.CounterRxPanel>) =>
      mocks.renderRx ? <actual.CounterRxPanel {...props} /> : null,
  };
});
vi.mock('./counter-keymap-legend', () => ({ CounterKeymapLegend: () => null }));
vi.mock('./counter-substitute-proposals', () => ({ CounterSubstituteProposals: () => null }));

import { PharmacyCounterConsole } from './counter-console';
import {
  persistTenderAttempt,
  readTenderAttempt,
  tenderAttemptStorageKey,
  type TenderAttempt,
} from './tender-attempt-storage';

function medicineRow(overrides: Partial<CounterSearchRow> = {}): CounterSearchRow {
  return {
    medicineId: 'med-a',
    displayName: 'Synthetic medicine',
    brandName: null,
    manufacturer: null,
    strength: null,
    presentationId: 'presentation-a',
    presentation: 'Tablets',
    dosageForm: null,
    route: null,
    matchedOn: 'NAME',
    recommendedLotId: 'lot-a',
    packLevelId: 'box',
    unitsPerPack: 100,
    printedMrpMinor: 10000,
    roundingIncrementMinor: 1,
    batchNumber: 'FEFO-A',
    nearestSafeExpiry: '2027-06-01T00:00:00.000Z',
    onHandUnits: 290,
    saleUnits: [
      { kind: 'PACK', packLevelId: 'box', levelLabel: 'BOX', canonicalUnitsPerSaleUnit: 100 },
      { kind: 'STRIP', packLevelId: 'strip', levelLabel: 'STRIP', canonicalUnitsPerSaleUnit: 10 },
      { kind: 'UNIT', packLevelId: 'unit', levelLabel: 'UNIT', canonicalUnitsPerSaleUnit: 1 },
    ],
    saleableUnits: [
      {
        kind: 'PACK',
        levelLabel: 'BOX',
        canonicalUnitsPerSaleUnit: 100,
        wholeUnits: 2,
        unitPriceMinor: 10000,
        proRataCeilingMinor: 10000,
      },
    ],
    restriction: {
      rx: false,
      otc: true,
      controlled: false,
      restricted: false,
      highAlert: false,
      lasa: false,
    },
    storage: { coldChain: false, locationKind: null, locationCode: null, locationName: null },
    blocked: [],
    ...overrides,
  };
}

describe('counter live search and exact shortfall', () => {
  let client: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.liveSearch = true;
    mocks.searchFetch.mockResolvedValue({ rows: [medicineRow()], truncated: false });
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  });

  afterEach(() => {
    // Search, staging and demand capture must never create a bill or post stock/payment actions.
    for (const name of ['create', 'addLine', 'transition', 'tender', 'openDrawer', 'redeemPoints'])
      expect(mocks.mutations[name]).not.toHaveBeenCalled();
    client.clear();
    vi.useRealTimers();
  });

  function mount() {
    return render(
      <QueryClientProvider client={client}>
        <PharmacyCounterConsole />
      </QueryClientProvider>
    );
  }

  function type(value: string) {
    fireEvent.change(screen.getByLabelText('Scan or search'), { target: { value } });
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  async function stage(row = medicineRow()) {
    mocks.searchFetch.mockResolvedValue({ rows: [row], truncated: false });
    mount();
    type('Synthetic');
    await advance(300);
    await advance(1);
    fireEvent.click(screen.getByRole('button', { name: /Synthetic medicine/ }));
  }

  it('debounces names, resets the timer, and never requests empty/one-character input', async () => {
    mount();
    type(' ');
    await advance(400);
    type('a');
    await advance(400);
    expect(mocks.searchFetch).not.toHaveBeenCalled();
    type('sy');
    await advance(299);
    expect(mocks.searchFetch).not.toHaveBeenCalled();
    type('syn');
    await advance(299);
    expect(mocks.searchFetch).not.toHaveBeenCalled();
    await advance(1);
    expect(mocks.searchFetch).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch-a',
      query: 'syn',
    });
    type('');
    await advance(400);
    expect(mocks.searchFetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /Synthetic medicine/ })).not.toBeInTheDocument();
  });

  it('Enter submits a plain barcode immediately without a later debounce duplicate', async () => {
    mount();
    type('0123456789012');
    fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key: 'Enter' });
    await advance(1);
    expect(mocks.searchFetch).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch-a',
      query: '0123456789012',
    });
    await advance(400);
    expect(mocks.searchFetch).toHaveBeenCalledTimes(1);
    expect(mocks.mutations.authenticatePack).not.toHaveBeenCalled();
  });

  it('waits for explicit GS1 Enter and searches the authenticated GTIN', async () => {
    mocks.mutations.authenticatePack!.mockResolvedValue({
      status: 'VERIFIED',
      parsed: { gtin: '01234567890123' },
      explanation: 'Pack verified.',
    });
    mount();
    type('(01)01234567890123');
    await advance(500);
    expect(mocks.searchFetch).not.toHaveBeenCalled();
    expect(mocks.mutations.authenticatePack).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key: 'Enter' });
    await advance(1);
    expect(mocks.mutations.authenticatePack).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch-a',
      payload: '(01)01234567890123',
    });
    expect(mocks.searchFetch).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch-a',
      query: '01234567890123',
    });
  });

  it('hides old rows immediately and ignores a late response after the newer query wins', async () => {
    let resolveOld!: (value: unknown) => void;
    mocks.searchFetch.mockImplementation(({ query: text }: { query: string }) =>
      text === 'older'
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve({ rows: [medicineRow({ displayName: 'New result' })] })
    );
    mount();
    type('older');
    await advance(300);
    type('newer');
    expect(screen.queryByRole('list', { name: 'Search results' })).not.toBeInTheDocument();
    await advance(300);
    await advance(1);
    expect(screen.getByRole('button', { name: /New result/ })).toBeVisible();
    await act(async () => {
      resolveOld({ rows: [medicineRow({ displayName: 'Old result' })] });
    });
    await advance(1);
    expect(screen.queryByRole('button', { name: /Old result/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New result/ })).toBeVisible();
    type('n');
    await advance(400);
    expect(screen.queryByRole('list', { name: 'Search results' })).not.toBeInTheDocument();
    expect(mocks.searchFetch).toHaveBeenCalledTimes(2);
  });

  it('clears a staged row on query/branch changes and scopes the next request', async () => {
    mocks.queries.counterBranches = query({
      branches: [
        { id: 'branch-a', name: 'Branch A' },
        { id: 'branch-b', name: 'Branch B' },
      ],
    });
    await stage();
    expect(screen.getByLabelText('Quantity')).toBeVisible();
    type('another');
    expect(screen.queryByLabelText('Quantity')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch-b' } });
    await advance(300);
    expect(mocks.searchFetch).toHaveBeenLastCalledWith({ branchId: 'branch-b', query: 'another' });
  });

  it('does not search without an authorized branch', async () => {
    mocks.queries.counterBranches = { ...query(), isSuccess: false, isError: true };
    mount();
    await advance(500);
    expect(screen.queryByLabelText('Scan or search')).not.toBeInTheDocument();
    expect(screen.getByText('Branches unavailable')).toBeVisible();
    expect(mocks.searchFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['PACK', 10, 710, 100],
    ['STRIP', 30, 10, 10],
    ['UNIT', 1000, 710, 1],
  ] as const)(
    'captures the canonical difference for %s quantities',
    async (unit, quantity, shortfall, scale) => {
      await stage();
      fireEvent.click(
        screen.getByRole('radio', {
          name: new RegExp(unit === 'PACK' ? 'Pack' : unit === 'STRIP' ? 'Strip' : 'Unit'),
        })
      );
      fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: String(quantity) } });
      expect(screen.getByRole('button', { name: /Add to cart/ })).toBeDisabled();
      fireEvent.click(
        screen.getByRole('button', { name: `Capture shortfall: ${shortfall} canonical units` })
      );
      await advance(1);
      expect(mocks.mutations.captureDemand).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          requestedMedicineId: 'med-a',
          saleUnit: 'UNIT',
          quantity: shortfall,
          reason: 'STOCKOUT',
          inventoryRuleSnapshot: expect.objectContaining({
            requestedQuantity: quantity,
            requestedSaleUnit: unit,
            canonicalUnitsPerSaleUnit: scale,
            onHandUnits: 290,
            requestedCanonicalUnits: quantity * scale,
            shortfallCanonicalUnits: shortfall,
          }),
        })
      );
      expect(
        screen.getByText(
          `Captured ${shortfall} canonical units of unfulfilled demand for Synthetic medicine.`
        )
      ).toBeVisible();
    }
  );

  it('offers explicit canonical-unit capture for an unavailable medicine without inventing a pack', async () => {
    await stage(
      medicineRow({
        onHandUnits: 0,
        saleUnits: [],
        saleableUnits: [],
        printedMrpMinor: null,
        unitsPerPack: null,
      })
    );
    fireEvent.change(screen.getByLabelText('Requested canonical units'), {
      target: { value: '710' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Capture shortfall: 710 canonical units' }));
    await advance(1);
    expect(mocks.mutations.captureDemand).toHaveBeenCalledWith(
      expect.objectContaining({ saleUnit: 'UNIT', quantity: 710 })
    );
  });

  it('does not capture a fully covered request, even through the shortcut', async () => {
    await stage();
    expect(screen.queryByRole('button', { name: /Capture shortfall:/ })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'F3', shiftKey: true });
    await advance(1);
    expect(mocks.mutations.captureDemand).not.toHaveBeenCalled();
  });

  it('reports capture failure honestly, preserves quantity, and disables duplicate pending capture', async () => {
    let rejectCapture!: (reason: Error) => void;
    mocks.mutations.captureDemand!.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectCapture = reject;
        })
    );
    await stage();
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Capture shortfall: 710 canonical units' }));
    expect(screen.getByRole('button', { name: 'Capturing…' })).toBeDisabled();
    await act(async () => {
      rejectCapture(new Error('Demand capture unavailable'));
    });
    expect(screen.getByText('Demand capture unavailable')).toBeVisible();
    expect(screen.queryByText(/Captured 710 canonical/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Quantity')).toHaveValue(10);
    expect(
      screen.getByRole('button', { name: 'Capture shortfall: 710 canonical units' })
    ).toBeEnabled();
  });
});

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
        allocations: [],
      },
    ],
    totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 0 },
    ...overrides,
  };
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

function enterPayment(type = 'CASH') {
  fireEvent.change(screen.getByLabelText('Tender'), { target: { value: type } });
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '125.50' } });
  if (type === 'CASH')
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '200.00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.liveSearch = false;
  mocks.renderReceipt = false;
  mocks.renderRx = false;
  mocks.searchFetch.mockReset();
  mocks.session = {
    status: 'authenticated',
    data: {
      user: { id: 'account-a', organizationId: 'org-a', status: 'ACTIVE', sessionRevoked: false },
    },
  };
  mocks.entitlements = { organizationId: 'org-a', enabledModules: ['pharmacy-counter'] };
  mocks.outcomeQuery.mockReset().mockResolvedValue({ status: 'UNKNOWN', replayUnsafe: true });
  mocks.receiptRefetch.mockReset().mockResolvedValue({ isSuccess: true, data: issuedReceipt() });
  for (const name of [
    'counterBranches',
    'counterKeymap',
    'counterSearch',
    'counterCart',
    'counterReceipt',
    'customerSnapshot',
    'substituteProposals',
    'counterPatients',
    'counterPatientPanel',
    'controlledPharmacists',
    'lookupReceiptByNumber',
    'returnHistory',
  ])
    mocks.queries[name] = query();
  mocks.queries.counterBranches = query({
    branches: [{ id: 'branch-a', name: 'Synthetic branch' }],
  });
  mocks.queries.counterCart = { ...query(cart()), refetch: mocks.refetch };
  mocks.queries.counterReceipt!.refetch = mocks.receiptRefetch;
  for (const name of [
    'counterSaveKeymap',
    'create',
    'addLine',
    'transition',
    'tender',
    'openDrawer',
    'captureDemand',
    'declineSubstitute',
    'linkCustomer',
    'redeemPoints',
    'authenticatePack',
    'returnLine',
    'refundTender',
  ])
    mocks.mutations[name] = vi.fn();
  mocks.mutations.tender!.mockResolvedValue(accepted());
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
  window.localStorage.clear();
});

afterEach(() => vi.restoreAllMocks());

describe('PharmacyCounterConsole authoritative bill state', () => {
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
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(screen.queryByText('Settled')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
    expect(mocks.mutations.tender).not.toHaveBeenCalled();
    expect(mocks.receiptProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ receipt: null, state: 'idle' })
    );
  });

  it('does not settle an idle counter', () => {
    render(<PharmacyCounterConsole />);
    expect(screen.queryByText('Settled')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
  });

  it('allows an empty bill to recover without locking bill actions or claiming settlement', async () => {
    mocks.queries.counterCart!.data = cart({
      lines: [],
      totals: { grossMinor: 0, discountMinor: 0, netMinor: 0, tenderedMinor: 0 },
    });
    mocks.queries.counterCart!.isError = true;
    mocks.queries.counterCart!.isSuccess = false;
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh bill' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Hold' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
    expect(screen.queryByText('Settled')).not.toBeInTheDocument();
    expect(mocks.mutations.tender).not.toHaveBeenCalled();
  });

  it('shows settlement only for a fresh completed bill with a known balance and receipt number', () => {
    mocks.queries.counterCart!.data = cart({
      status: 'COMPLETED',
      receiptNumber: 42,
      totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 25000 },
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(screen.getByText('Settled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
  });
});

describe('PharmacyCounterConsole tender recovery', () => {
  it.each([
    ['BAD_REQUEST', 'DRAWER_NOT_OPEN', 'CASH'],
    ['FORBIDDEN', 'Access refused.', 'CASH'],
    ['UNAUTHORIZED', 'Sign in required.', 'CASH'],
    ['BAD_REQUEST', 'UNCERTIFIED_PROVIDER', 'CARD'],
    ['BAD_REQUEST', 'CONSENT_REQUIRED', 'CREDIT'],
  ])('retains a %s / %s rejection on the same bill', async (code, message, type) => {
    mocks.mutations.tender!.mockRejectedValue(refused(code!, message));
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    enterPayment(type);
    await screen.findByText(/Payment was not accepted/);
    expect(screen.getByLabelText('Amount')).toHaveValue('125.50');
    expect(screen.getByLabelText('Tender')).toHaveValue(type);
    if (type === 'CASH') expect(screen.getByLabelText('Cash received')).toHaveValue('200.00');
    expect(mocks.mutations.tender).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        branchId: 'branch-a',
        saleId: 'sale-a',
        amountMinor: 12550,
        type,
        idempotencyKey: `counter-tender:sale-a:${type}:12550`,
      })
    );
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
    expect(screen.queryByText('Settled')).not.toBeInTheDocument();
  });

  it('cannot tender after a failed read retry; a valid read preserves the draft and original key', async () => {
    mocks.mutations.tender!.mockRejectedValue(refused('BAD_REQUEST', 'DRAWER_NOT_OPEN'));
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    enterPayment();
    await screen.findByText(/Payment was not accepted/);
    mocks.refetch.mockRejectedValueOnce(new Error('Read failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh bill' }));
    await waitFor(() => expect(mocks.refetch).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh bill' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Take payment' })).toBeEnabled());
    expect(screen.getByLabelText('Amount')).toHaveValue('125.50');
    expect(screen.getByLabelText('Cash received')).toHaveValue('200.00');
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
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
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      enterPayment();
      await screen.findByText(/Payment outcome is unknown/);
      expect(screen.getByLabelText('Amount')).toHaveValue('125.50');
      expect(screen.getByLabelText('Cash received')).toHaveValue('200.00');
      expect(screen.getByRole('button', { name: 'Hold' })).toBeDisabled();
      mocks.queries.counterCart!.data = cart({
        status: 'COMPLETED',
        receiptNumber: 42,
        totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 25000 },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Refresh bill' }));
      await waitFor(() => expect(mocks.refetch).toHaveBeenCalledTimes(1));
      expect(screen.queryByText('Settled')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
      expect(mocks.mutations.tender).toHaveBeenCalledTimes(1);
      expect(mocks.mutationOptions).toHaveBeenCalledWith('tender', { retry: false });
    }
  );

  it.each(['throws', 'error-result'])(
    'keeps acknowledged payment accepted when refresh %s',
    async (kind) => {
      if (kind === 'throws') mocks.refetch.mockRejectedValue(new Error('Read failed'));
      else mocks.refetch.mockResolvedValue({ isSuccess: false, isError: true, data: cart() });
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      enterPayment();
      await screen.findByText('Payment recorded.');
      expect(
        screen.getByText(/Payment recorded, but the bill refresh is incomplete/)
      ).toBeInTheDocument();
      expect(screen.getByLabelText('Amount')).toHaveValue('');
      expect(screen.getByLabelText('Cash received')).toHaveValue('');
      expect(screen.queryByText(/Payment outcome is unknown/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
      expect(mocks.mutations.tender).toHaveBeenCalledTimes(1);
    }
  );

  it('accepts a validated replay acknowledgement without claiming the bill settled', async () => {
    mocks.mutations.tender!.mockResolvedValue({ ...accepted(), replayed: true });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    enterPayment();
    await screen.findByText('Payment recorded.');
    expect(screen.getByLabelText('Amount')).toHaveValue('');
    expect(screen.queryByText('Settled')).not.toBeInTheDocument();
  });

  it('clears an accepted full payment and shows settlement after the completed bill is read', async () => {
    mocks.mutations.tender!.mockResolvedValue(accepted(0));
    mocks.refetch.mockImplementation(async () => {
      mocks.queries.counterCart!.data = cart({
        status: 'COMPLETED',
        receiptNumber: 42,
        totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 25000 },
      });
      return mocks.queries.counterCart;
    });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '250.00' } });
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '300.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await screen.findByText('Payment recorded.');
    expect(screen.getByLabelText('Amount')).toHaveValue('');
    expect(screen.getByLabelText('Cash received')).toHaveValue('');
    expect(screen.getByText('Settled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
    expect(mocks.mutations.tender).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ amountMinor: 25000, cashReceivedMinor: 30000 })
    );
  });

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
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      const button = screen.getByRole('button', { name: 'Take payment' });
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
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    enterPayment();
    await screen.findByText(/Payment was not accepted/);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh bill' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Hold' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Hold' }));
    await waitFor(() => expect(screen.getByLabelText('Amount')).toHaveValue(''));
    expect(screen.queryByText(/Payment was not accepted/)).not.toBeInTheDocument();
    expect(screen.queryByText('Settled')).not.toBeInTheDocument();
  });

  it('preserves unresolved prescription safety blocks', () => {
    const bill = cart();
    bill.lines[0]!.rx = true;
    mocks.queries.counterCart!.data = bill;
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(screen.getByText(/This bill carries an unresolved safety block/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
    expect(mocks.mutations.tender).not.toHaveBeenCalled();
  });
});

function issuedReceipt(overrides: Partial<CounterReceipt> = {}): CounterReceipt {
  return {
    saleId: 'sale-a',
    receiptNumber: 42,
    branchName: 'Synthetic branch',
    businessDate: '2026-09-12',
    completedAt: '2026-09-12T09:00:00Z',
    currency: 'PKR',
    lines: [
      {
        saleLineId: 'line-a',
        medicineName: 'Synthetic item',
        strength: null,
        presentation: 'Pack',
        batchNumber: 'BATCH-A',
        expiresAt: '2027-06-01',
        saleUnit: 'PACK',
        quantity: 1,
        canonicalUnits: 1,
        unitPriceMinor: 25000,
        discountMinor: 0,
        lineTotalMinor: 25000,
      },
    ],
    tenders: [],
    totals: {
      grossMinor: 25000,
      discountMinor: 0,
      netMinor: 25000,
      tenderedMinor: 25000,
      changeMinor: 5000,
    },
    ...overrides,
  };
}

function completeBill(overrides: Partial<CounterCart> = {}) {
  return cart({
    status: 'COMPLETED',
    receiptNumber: 42,
    totals: { grossMinor: 25000, discountMinor: 0, netMinor: 25000, tenderedMinor: 25000 },
    ...overrides,
  });
}

function lastReceiptProps(): CounterReceiptViewProps {
  return mocks.receiptProps.mock.calls.at(-1)![0];
}

describe('counter settlement receipt integration', () => {
  function popup() {
    return {
      opener: window,
      closed: false,
      close: vi.fn(),
      focus: vi.fn(),
      print: vi.fn(),
      document: { open: vi.fn(), write: vi.fn(), close: vi.fn() },
    };
  }

  function mount(autoPrint = false) {
    const view = render(
      <StrictMode>
        <PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />
      </StrictMode>
    );
    if (autoPrint)
      fireEvent.click(screen.getByRole('checkbox', { name: /Automatically open print dialog/ }));
    return view;
  }

  function pay() {
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '250.00' } });
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '300.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
  }

  beforeEach(() => {
    mocks.renderReceipt = true;
    mocks.mutations.tender!.mockResolvedValue(accepted(0));
    mocks.refetch.mockImplementation(async () => {
      mocks.queries.counterCart!.data = completeBill();
      return mocks.queries.counterCart;
    });
    mocks.receiptRefetch.mockImplementation(async () => {
      mocks.queries.counterReceipt!.data = issuedReceipt();
      return mocks.queries.counterReceipt;
    });
  });

  it('defaults off, focuses the new receipt, clears the event, and counts only requested dialogs', async () => {
    const printWindow = popup();
    const open = vi.spyOn(window, 'open').mockReturnValue(printWindow as unknown as Window);
    const view = mount();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    pay();
    await screen.findByText('Receipt ready. Use Print receipt to open the browser print dialog.');
    expect(screen.getByRole('region', { name: /42/ })).toHaveFocus();
    expect(open).not.toHaveBeenCalled();
    expect(lastReceiptProps().settlement).toBeNull();
    expect(lastReceiptProps().reprint).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Print receipt' }));
    expect(printWindow.print).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Reprint receipt' })).toBeEnabled();
    view.rerender(
      <StrictMode>
        <PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />
      </StrictMode>
    );
    expect(open).toHaveBeenCalledOnce();
    expect(mocks.mutations.tender).toHaveBeenCalledOnce();
  });

  it('reserves within the native gesture, waits for matching issued reads, then prints once', async () => {
    const printWindow = popup();
    const open = vi.spyOn(window, 'open').mockReturnValue(printWindow as unknown as Window);
    let acknowledge!: (value: ReturnType<typeof accepted>) => void;
    let readReceipt!: (value: Query) => void;
    mocks.mutations.tender!.mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        })
    );
    mocks.receiptRefetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          readReceipt = resolve;
        })
    );
    mount(true);
    const checkbox = screen.getByRole('checkbox');
    for (const key of ['Enter', ' ']) expect(fireEvent.keyDown(checkbox, { key })).toBe(true);
    expect(mocks.mutations.addLine).not.toHaveBeenCalled();
    pay();
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.mutations.tender!.mock.invocationCallOrder[0]!
    );
    expect(printWindow.print).not.toHaveBeenCalled();
    expect(checkbox).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Taking payment…' }));
    await act(async () => acknowledge(accepted(0)));
    expect(lastReceiptProps().settlement).toBeNull();
    expect(printWindow.print).not.toHaveBeenCalled();
    await act(async () => {
      mocks.queries.counterReceipt!.data = issuedReceipt();
      readReceipt(mocks.queries.counterReceipt!);
    });
    expect(printWindow.print).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    expect(lastReceiptProps().settlement).toBeNull();
    expect(lastReceiptProps().reprint).toBe(true);
    expect(mocks.mutations.tender).toHaveBeenCalledOnce();
  });

  it.each(['blocked', 'closed', 'print-error'])(
    'keeps manual recovery after a %s popup without another automatic window',
    async (kind) => {
      const printWindow = popup();
      printWindow.closed = kind === 'closed';
      if (kind === 'print-error')
        printWindow.print.mockImplementation(() => {
          throw new Error('Print failed');
        });
      const open = vi
        .spyOn(window, 'open')
        .mockReturnValue(kind === 'blocked' ? null : (printWindow as unknown as Window));
      mount(true);
      pay();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Print receipt' })).toBeEnabled()
      );
      expect(lastReceiptProps().settlement).toBeNull();
      expect(lastReceiptProps().reprint).toBe(false);
      expect(open).toHaveBeenCalledOnce();
      expect(
        screen.getByText(/Allow pop-ups for this site|The browser print dialog could not open/)
      ).toBeVisible();
      const retryWindow = popup();
      open.mockReturnValue(retryWindow as unknown as Window);
      fireEvent.click(screen.getByRole('button', { name: 'Print receipt' }));
      expect(retryWindow.print).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledTimes(2);
      expect(lastReceiptProps().reprint).toBe(true);
      expect(mocks.mutations.tender).toHaveBeenCalledOnce();
    }
  );

  it.each(['partial', 'replayed', 'unknown', 'rejected'])(
    'cancels the reservation after %s payment without a settlement event',
    async (kind) => {
      const printWindow = popup();
      const open = vi.spyOn(window, 'open').mockReturnValue(printWindow as unknown as Window);
      if (kind === 'partial') {
        mocks.mutations.tender!.mockResolvedValue(accepted());
        mocks.refetch.mockResolvedValue(query(cart()));
      }
      if (kind === 'replayed')
        mocks.mutations.tender!.mockResolvedValue({ ...accepted(0), replayed: true });
      if (kind === 'unknown')
        mocks.mutations.tender!.mockRejectedValue(new Error('Connection lost'));
      if (kind === 'rejected') mocks.mutations.tender!.mockRejectedValue(refused('BAD_REQUEST'));
      mount(true);
      pay();
      await waitFor(() => expect(printWindow.close).toHaveBeenCalledOnce());
      expect(lastReceiptProps().settlement).toBeNull();
      expect(printWindow.print).not.toHaveBeenCalled();
      if (kind === 'unknown') {
        mocks.outcomeQuery.mockResolvedValue({
          status: 'ACCEPTED',
          replayUnsafe: true,
          result: accepted(0),
        });
        fireEvent.click(screen.getByRole('button', { name: 'Check payment outcome' }));
        await screen.findByText('Settled');
        expect(lastReceiptProps().settlement).toBeNull();
        expect(printWindow.print).not.toHaveBeenCalled();
      }
      expect(open).toHaveBeenCalledOnce();
      expect(mocks.mutations.tender).toHaveBeenCalledOnce();
    }
  );

  it.each(['bill-error', 'receipt-error', 'wrong-sale', 'wrong-number', 'unissued', 'underpaid'])(
    'requires authoritative settlement through %s and makes later recovery manual',
    async (kind) => {
      const printWindow = popup();
      const open = vi.spyOn(window, 'open').mockReturnValue(printWindow as unknown as Window);
      if (kind === 'bill-error') mocks.refetch.mockRejectedValueOnce(new Error('Bill failed'));
      else if (kind === 'underpaid')
        mocks.refetch.mockImplementationOnce(async () => {
          mocks.queries.counterCart!.data = completeBill({ totals: cart().totals });
          return mocks.queries.counterCart;
        });
      else if (kind === 'receipt-error')
        mocks.receiptRefetch.mockRejectedValueOnce(new Error('Receipt failed'));
      else
        mocks.receiptRefetch.mockResolvedValueOnce(
          query(
            issuedReceipt(
              kind === 'wrong-sale'
                ? { saleId: 'other-sale' }
                : kind === 'wrong-number'
                  ? { receiptNumber: 99 }
                  : { completedAt: null }
            )
          )
        );
      mount(true);
      pay();
      await waitFor(() => expect(printWindow.close).toHaveBeenCalledOnce());
      expect(lastReceiptProps().settlement).toBeNull();
      expect(printWindow.print).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Refresh bill' }));
      await screen.findByText('Receipt ready. Use Print receipt to open the browser print dialog.');
      expect(lastReceiptProps().settlement).toBeNull();
      expect(lastReceiptProps().reprint).toBe(false);
      expect(printWindow.print).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledOnce();
      expect(mocks.mutations.tender).toHaveBeenCalledOnce();
    }
  );

  it.each(['historical', 'restored'])('never auto-prints a %s completed bill', async (kind) => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    mocks.queries.counterCart!.data = completeBill();
    mocks.queries.counterReceipt!.data = issuedReceipt();
    if (kind === 'restored') {
      persistTenderAttempt(savedAttempt());
      mocks.outcomeQuery.mockResolvedValue({
        status: 'ACCEPTED',
        replayUnsafe: true,
        result: accepted(0),
      });
    }
    mount();
    if (kind === 'restored') {
      fireEvent.click(screen.getByRole('button', { name: 'Check payment outcome' }));
      await screen.findByText('Settled');
    }
    fireEvent.click(screen.getByRole('checkbox'));
    expect(lastReceiptProps().settlement).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(mocks.mutations.tender).not.toHaveBeenCalled();
  });

  it('cancels on unmount, ignores the late acknowledgement, and resets operator-session opt-in', async () => {
    const printWindow = popup();
    const open = vi.spyOn(window, 'open').mockReturnValue(printWindow as unknown as Window);
    let acknowledge!: (value: ReturnType<typeof accepted>) => void;
    mocks.mutations.tender!.mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        })
    );
    const view = mount(true);
    pay();
    view.unmount();
    expect(printWindow.close).toHaveBeenCalledOnce();
    await act(async () => acknowledge(accepted(0)));
    mount();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(lastReceiptProps().settlement).toBeNull();
    expect(printWindow.print).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();
    expect(mocks.mutations.tender).toHaveBeenCalledOnce();
  });
});

describe('counter published patient and inventory routes', () => {
  it('uses the actual Rx panel capture contract with the selected patient, retaining the bill', async () => {
    mocks.renderRx = true;
    const bill = cart();
    bill.lines[0]!.rx = true;
    mocks.queries.counterCart!.data = bill;
    mocks.queries.counterPatients!.data = {
      patients: [{ patientId: 'patient/a & b', displayName: 'Synthetic patient', phone: null }],
    };
    const view = render(
      <PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />
    );
    fireEvent.change(screen.getByLabelText('Find patient'), { target: { value: 'Synthetic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(screen.getByRole('button', { name: /Synthetic patient/ }));
    mocks.queries.counterPatientPanel!.data = {
      patientId: 'patient/a & b',
      displayName: 'Synthetic patient',
      phone: null,
      cnic: null,
      dispensingConsent: false,
      prescriptions: [],
    };
    view.rerender(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    const capture = screen.getByRole('link', {
      name: 'Capture prescriptionfor Synthetic patient (opens in a new tab)',
    });
    expect(capture).toHaveAttribute(
      'href',
      '/pharmacy/prescriptions#patientId=patient%2Fa%20%26%20b'
    );
    expect(capture).toHaveAttribute('target', '_blank');
    expect(capture).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('No prescription is on file for this patient.')).toBeVisible();
    expect(
      screen.getByText(/Capture does not replace pharmacist review or dispensing consent/)
    ).toBeVisible();
    expect(screen.getByText('1 × Synthetic item')).toBeVisible();
    expect(screen.getByText(/This bill carries an unresolved safety block/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
    expect(mocks.mutations.tender).not.toHaveBeenCalled();
    expect(mocks.mutations.create).not.toHaveBeenCalled();
  });

  it('adds an encoded branch Inventory route to the pack-arrangement refusal', async () => {
    const branchId = 'branch/a & b';
    mocks.queries.counterBranches!.data = {
      branches: [{ id: branchId, name: 'Synthetic branch' }],
    };
    mocks.queries.counterSearch!.data = { rows: [medicineRow()], truncated: false };
    mocks.mutations.addLine!.mockRejectedValue(new Error('INVALID_ARRANGEMENT'));
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId={branchId} />);
    fireEvent.change(screen.getByLabelText('Scan or search'), { target: { value: 'Synthetic' } });
    fireEvent.keyDown(screen.getByLabelText('Scan or search'), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('button', { name: /Synthetic medicine/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add to cart/ }));
    const link = await screen.findByRole('link', {
      name: /Open Inventory to review pack breaking/,
    });
    expect(link).toHaveAttribute('href', '/pharmacy/inventory?branch=branch%2Fa%20%26%20b');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText(/Sell the open loose units first/)).toBeVisible();
    expect(mocks.mutations.addLine).toHaveBeenCalledOnce();
    expect(mocks.mutations.tender).not.toHaveBeenCalled();
    expect(mocks.mutations.transition).not.toHaveBeenCalled();
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
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
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
      render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
      if (kind !== 'read') {
        if (kind !== 'device')
          window.localStorage.setItem('devfathom.pharmacy.counter.device', 'device-a');
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
          if (kind !== 'silent-write') throw new Error('Quota');
        });
        enterPayment();
      }
      await screen.findByText(/Payment recovery storage is unavailable/);
      expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
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
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await screen.findByText(/Payment outcome is unknown/);
    const originalInput = mocks.mutations.tender!.mock.calls[0]![0];
    view.unmount();
    window.localStorage.setItem('devfathom.pharmacy.counter.device', 'replacement-device');
    render(<PharmacyCounterConsole />);
    expect(screen.getByLabelText('Amount')).toHaveValue(' 00125.50 ');
    expect(screen.getByLabelText('Cash received')).toHaveValue('200.00');
    expect(screen.getByRole('button', { name: 'Hold' })).toBeDisabled();
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
    render(<PharmacyCounterConsole initialSaleId="another-sale" />);
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
      const view = render(<PharmacyCounterConsole />);
      for (let index = 0; index < 2; index++) {
        fireEvent.click(screen.getByRole('button', { name: 'Check payment outcome' }));
        await waitFor(() =>
          expect(screen.getByRole('button', { name: 'Check payment outcome' })).toBeEnabled()
        );
      }
      expect(mocks.outcomeQuery).toHaveBeenCalledTimes(2);
      expect(readTenderAttempt(scope)).toEqual({ status: 'pending', attempt });
      expect(screen.getByLabelText('Amount')).toHaveValue(attempt.draft.amount);
      expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
      view.unmount();
      render(<PharmacyCounterConsole />);
      expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
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
      render(<PharmacyCounterConsole />);
      fireEvent.click(screen.getByRole('button', { name: 'Check payment outcome' }));
      await screen.findByText('Payment recorded.');
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Take payment' })).toBeEnabled()
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
      const view = render(<PharmacyCounterConsole />);
      fireEvent.click(screen.getByRole('button', { name: 'Check payment outcome' }));
      await screen.findByText(/Payment recorded, but the bill refresh is incomplete/);
      await waitFor(() => expect(screen.getByLabelText('Amount')).toHaveValue(''));
      expect(screen.queryByText('Settled')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
      expect(readTenderAttempt(scope)).toEqual({ status: 'pending', attempt });
      view.unmount();
      render(<PharmacyCounterConsole />);
      expect(screen.getByLabelText('Amount')).toHaveValue(attempt.draft.amount);
      expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
      expect(mocks.mutations.tender).not.toHaveBeenCalled();
    }
  );

  it.each(['success', 'failed-receipt', 'wrong-receipt', 'failed-clear'])(
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
      if (kind === 'wrong-receipt')
        mocks.receiptRefetch.mockResolvedValue({
          isSuccess: true,
          data: { saleId: 'other-sale', receiptNumber: 42 },
        });
      if (kind === 'failed-clear')
        vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
          throw new Error('Denied');
        });
      render(<PharmacyCounterConsole />);
      fireEvent.click(screen.getByRole('button', { name: 'Check payment outcome' }));
      await waitFor(() => expect(mocks.receiptRefetch).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByLabelText('Amount')).toHaveValue(''));
      if (kind === 'success') {
        expect(screen.getByText('Settled')).toBeInTheDocument();
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
      render(<PharmacyCounterConsole initialSaleId="sale-a" />);
      expect(screen.getByLabelText('Amount')).toHaveValue('');
      expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
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
    const view = render(<PharmacyCounterConsole />);
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
    render(<PharmacyCounterConsole />);
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
    render(<PharmacyCounterConsole />);
    window.localStorage.clear();
    fireEvent(window, new StorageEvent('storage', { key: null }));
    expect(screen.getByRole('button', { name: 'Take payment' })).toBeDisabled();
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
    render(<PharmacyCounterConsole />);
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
    render(<PharmacyCounterConsole />);
    expect(get).not.toHaveBeenCalledWith(tenderAttemptStorageKey(attempt.scope));
    expect(screen.getByLabelText('Amount')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Check payment outcome' })).not.toBeInTheDocument();
  });
});
