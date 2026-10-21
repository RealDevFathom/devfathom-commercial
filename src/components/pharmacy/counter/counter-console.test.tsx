import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CounterCart } from '@/lib/pharmacy/counter';
import type { CounterReceipt } from '@/lib/pharmacy/counter-receipt';

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
  cartInvalidate: vi.fn(),
  receiptInvalidate: vi.fn(),
  mutationOptions: vi.fn(),
  receiptProps: vi.fn(),
  outcomeQuery: vi.fn(),
  khataAccounts: vi.fn(),
  khataStatement: vi.fn(),
  signIn: vi.fn(),
  receiptRefetch: vi.fn(),
  drawerStatusInvalidate: vi.fn(),
  session: {
    status: 'authenticated',
    data: {
      user: { id: 'account-a', organizationId: 'org-a', status: 'ACTIVE', sessionRevoked: false },
    },
  },
  entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'] },
}));

vi.mock('next-auth/react', () => ({ useSession: () => mocks.session, signIn: mocks.signIn }));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => mocks.entitlements,
}));

vi.mock('@/lib/trpc', () => {
  const router = (names: string[]) =>
    Object.fromEntries(
      names.map((name) => [
        name,
        {
          useQuery: () => mocks.queries[name],
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
    client: {
      pharmacySales: {
        tenderOutcome: { query: mocks.outcomeQuery },
        khataAccounts: { query: mocks.khataAccounts },
        khataStatement: { query: mocks.khataStatement },
      },
    },
    pharmacySales: {
      counterCart: { cancel: mocks.cancel, invalidate: mocks.cartInvalidate },
      counterReceipt: { invalidate: mocks.receiptInvalidate },
      counterEvidence: { reset: vi.fn() },
      drawerStatus: { invalidate: mocks.drawerStatusInvalidate },
    },
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
        'counterLotOptions',
        'counterEvidence',
        'customerSnapshot',
        'drawerStatus',
        'create',
        'addLine',
        'transition',
        'tender',
        'openDrawer',
        'captureDemand',
        'declineSubstitute',
        'linkCustomer',
        'redeemPoints',
        'redeemCode',
        'authenticatePack',
        'substituteProposals',
      ]),
      pharmacyPrescriptions: router(['counterPatients', 'counterPatientPanel']),
      pharmacySafety: router(['controlledPharmacists']),
    },
  };
});

vi.mock('./counter-receipt-view', () => ({
  CounterReceiptView: (props: unknown) => {
    mocks.receiptProps(props);
    return null;
  },
}));
vi.mock('./counter-rx-panel', () => ({ CounterRxPanel: () => null }));
vi.mock('./counter-keymap-legend', () => ({ CounterKeymapLegend: () => null }));
vi.mock('./counter-search-results', () => ({ CounterSearchResults: () => null }));
vi.mock('./counter-substitute-proposals', () => ({ CounterSubstituteProposals: () => null }));
vi.mock('./counter-unit-toggle', () => ({ CounterUnitToggle: () => null }));

import { PharmacyCounterConsole } from './counter-console';
import {
  persistTenderAttempt,
  readTenderAttempt,
  tenderAttemptStorageKey,
  type TenderAttempt,
} from './tender-attempt-storage';

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
  mocks.session = {
    status: 'authenticated',
    data: {
      user: { id: 'account-a', organizationId: 'org-a', status: 'ACTIVE', sessionRevoked: false },
    },
  };
  mocks.entitlements = { organizationId: 'org-a', enabledModules: ['pharmacy-counter'] };
  mocks.outcomeQuery.mockReset().mockResolvedValue({ status: 'UNKNOWN', replayUnsafe: true });
  mocks.receiptRefetch
    .mockReset()
    .mockResolvedValue({ isSuccess: true, data: { saleId: 'sale-a', receiptNumber: 42 } });
  for (const name of [
    'counterBranches',
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
  ])
    mocks.queries[name] = query();
  mocks.queries.drawerStatus = query({ openDrawer: null });
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
    'redeemCode',
    'authenticatePack',
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
  mocks.khataAccounts.mockResolvedValue([
    { id: 'family-a', displayName: 'Family A', balanceMinor: 0, creditLimitMinor: 100000 },
  ]);
  mocks.signIn.mockResolvedValue({ ok: true });
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
    ['BAD_REQUEST', 'CONSENT_REQUIRED', 'BANK_TRANSFER'],
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
    const completeCounterReceipt = {
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
    } satisfies CounterReceipt;
    mocks.receiptRefetch.mockResolvedValueOnce({ isSuccess: true, data: completeCounterReceipt });
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

describe('PharmacyCounterConsole Khata wiring', () => {
  it('persists and dispatches the selected family with no password fields', async () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'KHATA' } });
    await screen.findByText(/Ledger balance/);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '125.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Take payment' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '125.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
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
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'KHATA' } });
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
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'KHATA' } });
    await screen.findByText(/Ledger balance/);
    fireEvent.click(screen.getByLabelText('Owner: authorize limit increase'));
    fireEvent.change(screen.getByLabelText('Owner password (current account)'), {
      target: { value: 'test-only-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    await waitFor(() => expect(mocks.mutations.tender).toHaveBeenCalledOnce());
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

describe('PharmacyCounterConsole cash drawer (POS-07)', () => {
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
  });

  it('opens the drawer for this device once, then refreshes the status', async () => {
    mocks.mutations.openDrawer!.mockResolvedValue(openDrawer);
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    const button = screen.getByRole('button', { name: 'Open drawer' });
    expect(button).toBeEnabled();
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

  it('words a conflicting open for the operator instead of leaking the server failure', async () => {
    mocks.mutations.openDrawer!.mockRejectedValue(refused('CONFLICT', 'OPEN_DRAWER'));
    render(<PharmacyCounterConsole initialBranchId="branch-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    expect(
      await screen.findByText(
        'A drawer is already open on this counter. Close it before opening another.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/OPEN_DRAWER|prisma|Unique constraint/)).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.drawerStatusInvalidate).toHaveBeenCalled());
  });
});

describe('G5 counter campaign code', () => {
  it('hides the field when growth is disabled', () => {
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(screen.queryByLabelText('Campaign code')).not.toBeInTheDocument();
  });
  it('applies the code through POS and refreshes the existing bill', async () => {
    mocks.entitlements.enabledModules.push('growth_ai');
    mocks.mutations.redeemCode!.mockResolvedValue({ customerId: 'customer-a', discountMinor: 100 });
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    expect(screen.getByRole('button', { name: 'Apply code' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Campaign code'), { target: { value: 'DEMO-ABCDEF' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply code' }));
    await waitFor(() =>
      expect(mocks.mutations.redeemCode).toHaveBeenCalledWith({
        branchId: 'branch-a',
        saleId: 'sale-a',
        code: 'DEMO-ABCDEF',
      })
    );
    await waitFor(() => expect(screen.getByLabelText('Campaign code')).toHaveValue(''));
    expect(mocks.cartInvalidate).toHaveBeenCalled();
  });
  it('preserves a refused code and reports the error', async () => {
    mocks.entitlements.enabledModules.push('growth_ai');
    mocks.mutations.redeemCode!.mockRejectedValue(new Error('Campaign budget exceeded.'));
    render(<PharmacyCounterConsole initialSaleId="sale-a" initialBranchId="branch-a" />);
    fireEvent.change(screen.getByLabelText('Campaign code'), { target: { value: 'DEMO-ABCDEF' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply code' }));
    await waitFor(() => expect(screen.getByText('Campaign budget exceeded.')).toBeInTheDocument());
    expect(screen.getByLabelText('Campaign code')).toHaveValue('DEMO-ABCDEF');
  });
});
