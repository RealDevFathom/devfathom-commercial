import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
const mocks = vi.hoisted(() => ({
  branches: vi.fn(),
  customers: vi.fn(),
  history: vi.fn(),
  card: vi.fn(),
  setReminderLanguage: vi.fn(),
  earnRate: vi.fn(),
  liability: vi.fn(),
  redemptions: vi.fn(),
  replace: vi.fn(),
}));
vi.mock('next/navigation', async () => ({
  ...(await vi.importActual<typeof import('next/navigation')>('next/navigation')),
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock('@/server/trpc', () => ({ createTRPCContext: vi.fn().mockResolvedValue({}) }));
vi.mock('./loyalty-router', () => ({ pharmacyLoyaltyRouter: { createCaller: () => mocks } }));
import { createTRPCContext } from '@/server/trpc';
import LoyaltyPage from './page';
import LoyaltyLoading from './loading';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.branches.mockResolvedValue([{ id: 'branch-a', name: 'Main' }]);
  // DEV-748: no physical loyalty card issued yet.
  mocks.card.mockResolvedValue(null);
  mocks.earnRate.mockResolvedValue({ current: null, versions: [] });
  mocks.liability.mockResolvedValue({
    pointValueMinor: 100,
    points: 0,
    customers: 0,
    liabilityMinor: 0,
    branches: [],
  });
  mocks.redemptions.mockResolvedValue({ redemptions: [], total: 0, page: 1, pageCount: 1 });
  mocks.customers.mockResolvedValue({
    customers: [
      { id: 'customer-a', displayName: 'Retail customer', phoneLast4: '1234', pointsBalance: 14 },
    ],
    hasMore: false,
  });
  mocks.history.mockResolvedValue({
    customer: {
      id: 'customer-a',
      displayName: 'Retail customer',
      preferredLanguage: 'ur',
    },
    pointsBalance: 14,
    reconciliation: [],
    total: 26,
    page: 1,
    pageCount: 2,
    hasNext: true,
    entries: ['EARN', 'REDEEM', 'REFUND', 'EARN_REVERSAL'].map((kind, i) => ({
      id: `entry-${i}`,
      kind,
      points: [20, -10, 5, -1][i],
      occurredAt: new Date('2026-10-08T12:00:00Z'),
      saleId: 'sale-a',
      tenderId: 'tender-a',
      refundId: i > 1 ? `refund-${i}` : null,
      sale: { receiptNumber: 12, receiptDeviceId: 'counter-a' },
    })),
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
async function show(params: Record<string, string> = {}) {
  render(await LoyaltyPage({ searchParams: Promise.resolve(params) }));
}
describe('DEV-746 earning rate card', () => {
  it('says nobody earns new points until the owner sets a rate', async () => {
    await show();
    expect(screen.getByRole('heading', { name: 'Earning rate' })).toBeInTheDocument();
    expect(
      screen.getByText(/Points are not being earned: set an earn rate below/)
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '1% of spend' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save earning rate' })).toHaveAttribute(
      'type',
      'submit'
    );
  });
  it('shows the current version and the dated history of earlier rates', async () => {
    const version = (n: number, rule: object, at: string) => ({
      id: `program-${n}`,
      version: n,
      effectiveFrom: new Date(at),
      ...rule,
    });
    const v2 = version(
      2,
      { earnMode: 'POINTS_PER_SPEND_STEP', earnPoints: 1, perSpendMinor: 100_000 },
      '2026-11-10T09:30:00Z'
    );
    const v1 = version(
      1,
      { earnMode: 'PERCENT_OF_SPEND', earnPoints: 150, perSpendMinor: 1_000_000 },
      '2026-11-01T08:00:00Z'
    );
    mocks.earnRate.mockResolvedValue({ current: v2, versions: [v2, v1] });
    await show();
    expect(screen.queryByText(/Points are not being earned/)).not.toBeInTheDocument();
    expect(screen.getAllByText('1 point for every PKR 1,000 spent').length).toBeGreaterThan(0);
    expect(screen.getByText(/Version 2, in effect since 10 Nov 2026\. /)).toBeInTheDocument();
    const history = screen.getByRole('region', { name: 'Earning rate history' });
    expect(history).toHaveTextContent('1.5% of spend');
    expect(history).toHaveTextContent('1 Nov 2026, 8:00 AM UTC');
    expect(history).not.toHaveTextContent('2026-11-01 08:00');
  });
  it('asks for the custom amount only when a custom option is chosen', async () => {
    await show();
    expect(screen.queryByLabelText('Percentage of spend')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'A percentage of spend I choose' }));
    expect(screen.getByLabelText('Percentage of spend')).toBeRequired();
    fireEvent.click(screen.getByRole('radio', { name: 'Points for every spend step I choose' }));
    expect(screen.getByLabelText('Points')).toBeRequired();
    expect(screen.getByLabelText('For every PKR')).toBeRequired();
  });
});

describe('ordinary loyalty history page', () => {
  it('opens on the customer list with balances instead of an empty selection box', async () => {
    await show();
    expect(screen.getByLabelText('Branch')).toBeInTheDocument();
    expect(screen.getByLabelText('Name, phone or loyalty number')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search' })).toHaveAttribute('type', 'submit');
    expect(screen.getByRole('link', { name: /Retail customer/ })).toHaveAttribute(
      'href',
      expect.stringContaining('customerId=customer-a')
    );
    const row = screen.getByRole('link', { name: /Retail customer/ }).closest('tr')!;
    expect(row).toHaveTextContent('ending 1234');
    expect(row).toHaveTextContent('customer-a');
    expect(row).toHaveTextContent('14');
    expect(screen.queryByText('Choose an account')).not.toBeInTheDocument();
    expect(mocks.customers).toHaveBeenCalledWith({ branchId: 'branch-a', query: '' });
    expect(mocks.history).not.toHaveBeenCalled();
  });
  it('searches as the user types without a submit', async () => {
    vi.useFakeTimers();
    await show({ branchId: 'branch-a' });
    fireEvent.change(screen.getByLabelText('Name, phone or loyalty number'), {
      target: { value: 'Ahmed' },
    });
    expect(mocks.replace).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(mocks.replace).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledWith('/pharmacy/loyalty?branchId=branch-a&query=Ahmed', {
      scroll: false,
    });
  });
  it('renders signed events, reversal sources and selection-preserving pagination', async () => {
    await show({ customerId: 'customer-a', query: 'Retail' });
    for (const label of [
      'Points earned',
      'Points redeemed',
      'Redeemed points restored',
      'Earned points reversed',
      '+20',
      '-10',
      '+5',
      '-1',
      'Refund: refund-3',
    ])
      expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getAllByText('Receipt #12')).toHaveLength(4);
    expect(screen.getAllByText('Sale: sale-a')).toHaveLength(4);
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute(
      'href',
      '/pharmacy/loyalty?branchId=branch-a&customerId=customer-a&query=Retail&page=2'
    );
    expect(screen.getByText('Previous')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('link', { name: /Selected/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByLabelText('Reminder language')).toHaveValue('ur');
    expect(screen.getByRole('button', { name: 'Save reminder language' })).toBeInTheDocument();
  });
  it('shows empty branch history without inventing points', async () => {
    mocks.history.mockResolvedValue({
      customer: { displayName: 'Retail customer', preferredLanguage: 'en' },
      pointsBalance: 0,
      reconciliation: [],
      total: 0,
      page: 1,
      pageCount: 1,
      hasNext: false,
      entries: [],
    });
    await show({ customerId: 'customer-a' });
    expect(screen.getByText('0 points available')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('No points entries');
    expect(screen.queryByRole('link', { name: 'Next' })).not.toBeInTheDocument();
  });
  it('provides refinement for truncated search and an explanation for no matches', async () => {
    mocks.customers.mockResolvedValue({ customers: [], hasMore: false });
    await show();
    expect(screen.getByRole('status')).toHaveTextContent('No matching customers');
    cleanup();
    mocks.customers.mockResolvedValue({ customers: [], hasMore: true });
    await show();
    expect(screen.getByText(/Showing the first 50/)).toBeInTheDocument();
  });
  it('handles no active branches without issuing customer reads', async () => {
    mocks.branches.mockResolvedValue([]);
    await show();
    expect(screen.getByText('No active branch')).toBeInTheDocument();
    expect(mocks.customers).not.toHaveBeenCalled();
  });
  it('rejects a forged branch before reading customer identities', async () => {
    await show({ branchId: 'foreign' });
    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
    expect(mocks.customers).not.toHaveBeenCalled();
  });
  it('explains permission denial and exposes no accounts', async () => {
    mocks.branches.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    await show();
    expect(screen.getByRole('alert')).toHaveTextContent('authorized owner');
    expect(screen.queryByText('Retail customer')).not.toBeInTheDocument();
  });
  it('provides retry when a ledger read fails', async () => {
    mocks.history.mockRejectedValue(new Error('private database detail'));
    await show({ customerId: 'customer-a' });
    expect(screen.getByRole('link', { name: 'Reset selection and retry' })).toHaveAttribute(
      'href',
      '/pharmacy/loyalty'
    );
    expect(screen.queryByText('private database detail')).not.toBeInTheDocument();
  });
  it('has a textual loading state without motion', () => {
    const { container } = render(<LoyaltyLoading />);
    expect(screen.queryByRole('main')).not.toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Loading customer selection');
  });
});

describe('DEV-764 loyalty owner console', () => {
  it('shows the full program in force and its dated history', async () => {
    const v2 = {
      id: 'program-2',
      version: 2,
      effectiveFrom: new Date('2026-11-14T09:30:00Z'),
      earnMode: 'POINTS_PER_SPEND_STEP',
      earnPoints: 1,
      perSpendMinor: 100_000,
      redemptionValueMinor: 250,
      expiryDays: 180,
      khataEarns: false,
    };
    mocks.earnRate.mockResolvedValue({ current: v2, versions: [v2] });
    await show();
    expect(screen.getAllByText('1 point = PKR 2.50').length).toBeGreaterThan(0);
    expect(screen.getByText('After 180 days')).toBeInTheDocument();
    expect(screen.getByText('Do not earn')).toBeInTheDocument();
    expect(screen.getByLabelText('PKR value of 1 point')).toHaveValue('2.50');
    expect(screen.getByLabelText('Points expire after (days)')).toHaveValue('180');
    expect(
      screen.getByRole('checkbox', {
        name: 'Khata purchases earn points once the customer pays them off',
      })
    ).not.toBeChecked();
  });

  it('warns that the point value revalues points already held, and sets the manager ceiling', async () => {
    await show();
    expect(
      screen.getByText(/Changing it changes the value of every point customers already hold/)
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Largest manager adjustment (points)')).toHaveValue('500');
  });

  it('makes the first setup obvious and starts from the PKR 1 default', async () => {
    await show();
    expect(screen.getByText(/First setup: choose how points are earned/)).toBeInTheDocument();
    expect(screen.getByLabelText('PKR value of 1 point')).toHaveValue('1');
    expect(screen.getByLabelText('Points expire after (days)')).toHaveValue('');
    expect(
      screen.getByRole('checkbox', {
        name: 'Khata purchases earn points once the customer pays them off',
      })
    ).toBeChecked();
  });

  it('shows the value of unredeemed points by branch', async () => {
    mocks.liability.mockResolvedValue({
      pointValueMinor: 100,
      points: 1_500,
      customers: 3,
      liabilityMinor: 150_000,
      branches: [{ branchId: 'branch-a', points: 1_500, customers: 3, liabilityMinor: 150_000 }],
    });
    await show();
    expect(screen.getByRole('heading', { name: 'Points liability' })).toBeInTheDocument();
    expect(screen.getAllByText('PKR 1500.00')).toHaveLength(2);
    const byBranch = screen.getByRole('region', { name: 'Points liability by branch' });
    expect(byBranch).toHaveTextContent('Main');
  });

  it('lists redemptions with their value and points given back by a void', async () => {
    mocks.redemptions.mockResolvedValue({
      redemptions: [
        {
          id: 'redeem-a',
          occurredAt: new Date('2026-11-14T10:00:00Z'),
          customer: { id: 'customer-a', displayName: 'Retail customer' },
          receiptNumber: null,
          saleId: 'sale-a',
          saleVoided: true,
          points: 20,
          amountMinor: 2_000,
          pointsReturned: 20,
        },
      ],
      total: 1,
      page: 1,
      pageCount: 1,
    });
    await show();
    const table = screen.getByRole('region', { name: 'Redemption history' });
    expect(table).toHaveTextContent('PKR 20.00');
    expect(table).toHaveTextContent('Sale voided');
    expect(mocks.redemptions).toHaveBeenCalledWith({ branchId: 'branch-a', page: 1 });
  });

  it('offers a reasoned adjustment and labels adjustments and expiries in the ledger', async () => {
    mocks.history.mockResolvedValue({
      customer: { id: 'customer-a', displayName: 'Retail customer', preferredLanguage: 'en' },
      pointsBalance: 5,
      reconciliation: [],
      total: 2,
      page: 1,
      pageCount: 1,
      hasNext: false,
      entries: [
        {
          id: 'adjust-a',
          kind: 'ADJUSTMENT',
          points: 15,
          occurredAt: new Date('2026-11-14T10:00:00Z'),
          saleId: null,
          tenderId: null,
          refundId: null,
          reason: 'Points missed on receipt 1042',
          expiresAt: null,
          sale: null,
        },
        {
          id: 'expiry-a',
          kind: 'EXPIRY',
          points: -10,
          occurredAt: new Date('2026-11-13T10:00:00Z'),
          saleId: null,
          tenderId: null,
          refundId: null,
          reason: null,
          expiresAt: null,
          sale: null,
        },
      ],
    });
    await show({ customerId: 'customer-a' });
    expect(screen.getByText('Points adjusted')).toBeInTheDocument();
    expect(screen.getByText('Reason: Points missed on receipt 1042')).toBeInTheDocument();
    expect(screen.getByText('Points expired')).toBeInTheDocument();
    expect(screen.getByText('Expiry of earned points')).toBeInTheDocument();
    expect(screen.getByLabelText('Number of points')).toBeRequired();
    expect(screen.getByLabelText('Reason')).toBeRequired();
    expect(screen.getByRole('button', { name: 'Record adjustment' })).toHaveAttribute(
      'type',
      'submit'
    );
  });

  it('offers to issue a loyalty card, and to replace or revoke a working one (DEV-748)', async () => {
    await show({ customerId: 'customer-a' });
    expect(mocks.card).toHaveBeenCalledWith({ branchId: 'branch-a', customerId: 'customer-a' });
    expect(screen.getByRole('heading', { name: 'Loyalty card' })).toBeInTheDocument();
    expect(screen.getByText('No card')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Issue card' })).toHaveAttribute('type', 'submit');
    expect(screen.queryByRole('button', { name: 'Replace card' })).not.toBeInTheDocument();
    cleanup();

    mocks.card.mockResolvedValue({ id: 'card-a', issuedAt: new Date('2026-11-01T09:00:00Z') });
    await show({ customerId: 'customer-a' });
    expect(screen.getByText('Card active')).toBeInTheDocument();
    expect(screen.getByText('Issued 1 Nov 2026')).toBeInTheDocument();
    expect(screen.getByLabelText('Reason for replacing or revoking the card')).toBeRequired();
    expect(screen.getByRole('button', { name: 'Replace card' })).toHaveAttribute('value', 'issue');
    expect(screen.getByRole('button', { name: 'Revoke without replacing' })).toHaveAttribute(
      'value',
      'revoke'
    );
    // The page never has the card code: only the hash is stored, and it is shown once on issue.
    expect(document.body.textContent).not.toMatch(/DFLC/);
  });
});

describe('DEV-764 one balance across branches and membership', () => {
  const historyFor = (customer: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    customer: {
      id: 'customer-a',
      displayName: 'Retail customer',
      preferredLanguage: 'en',
      loyaltyActive: true,
      loyaltyStatusChangedAt: null,
      loyaltyStatusReason: null,
      ...customer,
    },
    pointsBalance: 140,
    reconciliation: [],
    total: 1,
    page: 1,
    pageCount: 1,
    hasNext: false,
    entries: [
      {
        id: 'earn-b',
        kind: 'EARN',
        points: 40,
        occurredAt: new Date('2026-11-14T10:00:00Z'),
        saleId: 'sale-b',
        tenderId: null,
        refundId: null,
        reason: null,
        expiresAt: null,
        branchId: 'branch-b',
        sale: { receiptNumber: 9, receiptDeviceId: null },
      },
    ],
    ...extra,
  });

  beforeEach(() => {
    mocks.branches.mockResolvedValue([
      { id: 'branch-a', name: 'Main' },
      { id: 'branch-b', name: 'Gulberg' },
    ]);
  });

  it('shows the branch each entry was recorded at and the merged branch balances', async () => {
    mocks.history.mockResolvedValue(
      historyFor(
        {},
        {
          reconciliation: [
            {
              branchId: 'branch-a',
              points: 100,
              entries: 3,
              reconciledAt: new Date('2026-11-17T09:06:00Z'),
            },
            {
              branchId: 'branch-b',
              points: 40,
              entries: 1,
              reconciledAt: new Date('2026-11-17T09:06:00Z'),
            },
          ],
        }
      )
    );
    await show({ customerId: 'customer-a' });
    expect(screen.getByText(/One balance across all branches, all time/)).toBeInTheDocument();
    const ledger = screen.getByRole('region', { name: 'Loyalty history' });
    expect(within(ledger).getByRole('columnheader', { name: 'Branch' })).toBeInTheDocument();
    expect(ledger).toHaveTextContent('Gulberg');
    const merged = screen.getByRole('region', { name: 'Branch balances merged' });
    const rows = within(merged).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual(['Main3100', 'Gulberg140']);
    expect(screen.getByText(/Nothing was added or removed/)).toBeInTheDocument();
  });

  it('shows no merge record for a customer who only ever had one branch balance', async () => {
    mocks.history.mockResolvedValue(historyFor({}));
    await show({ customerId: 'customer-a' });
    expect(screen.queryByRole('region', { name: 'Branch balances merged' })).toBeNull();
  });

  it('offers to deactivate an enrolled member, with a reason, next to the adjustment', async () => {
    mocks.history.mockResolvedValue(historyFor({}));
    await show({ customerId: 'customer-a' });
    expect(screen.getAllByText('Member').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Reason for deactivating')).toBeRequired();
    expect(screen.getByRole('button', { name: 'Deactivate member' })).toHaveAttribute(
      'type',
      'submit'
    );
    expect(screen.getByRole('button', { name: 'Record adjustment' })).toBeInTheDocument();
  });

  it('marks a deactivated member, offers re-enrolment and withholds adjustment', async () => {
    mocks.customers.mockResolvedValue({
      customers: [
        {
          id: 'customer-a',
          displayName: 'Retail customer',
          phoneLast4: '1234',
          pointsBalance: 140,
          loyaltyActive: false,
        },
      ],
      hasMore: false,
    });
    mocks.history.mockResolvedValue(
      historyFor({
        loyaltyActive: false,
        loyaltyStatusChangedAt: new Date('2026-11-16T08:00:00Z'),
        loyaltyStatusReason: 'Asked to leave the programme',
      })
    );
    await show({ customerId: 'customer-a' });
    const directory = screen.getByRole('region', { name: 'Loyalty customers' });
    expect(directory).toHaveTextContent('Deactivated');
    expect(screen.getByText(/Asked to leave the programme/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-enrol member' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record adjustment' })).toBeNull();
    expect(
      screen.getByText(/Points cannot be adjusted while the member is deactivated/)
    ).toBeInTheDocument();
  });
});

describe('DEV-722 loyalty times on the organisation clock', () => {
  it('shows every loyalty date and time in Asia/Karachi, with no UTC wording', async () => {
    vi.mocked(createTRPCContext).mockResolvedValueOnce({
      organization: { timezone: 'Asia/Karachi' },
    } as never);
    // 00:30 in Karachi on 1 Nov is 19:30 UTC on 31 Oct: every date must read 1 Nov.
    const boundary = new Date('2026-10-31T19:30:00Z');
    const v2 = {
      id: 'program-2',
      version: 2,
      effectiveFrom: boundary,
      earnMode: 'POINTS_PER_SPEND_STEP',
      earnPoints: 1,
      perSpendMinor: 100_000,
    };
    const v1 = {
      ...v2,
      id: 'program-1',
      version: 1,
      effectiveFrom: new Date('2026-10-01T04:00:00Z'),
    };
    mocks.earnRate.mockResolvedValue({ current: v2, versions: [v2, v1] });
    mocks.card.mockResolvedValue({ id: 'card-a', issuedAt: boundary });
    mocks.history.mockResolvedValue({
      customer: { id: 'customer-a', displayName: 'Retail customer', preferredLanguage: 'en' },
      pointsBalance: 20,
      reconciliation: [],
      total: 1,
      page: 1,
      pageCount: 1,
      hasNext: false,
      entries: [
        {
          id: 'earn-a',
          kind: 'EARN',
          points: 20,
          occurredAt: boundary,
          saleId: 'sale-a',
          tenderId: 'tender-a',
          refundId: null,
          reason: null,
          expiresAt: new Date('2027-10-31T19:30:00Z'),
          sale: { receiptNumber: 12, receiptDeviceId: 'counter-a' },
        },
      ],
    });
    await show({ customerId: 'customer-a' });
    expect(screen.getByText(/Version 2, in effect since 1 Nov 2026\. /)).toBeInTheDocument();
    const rates = screen.getByRole('region', { name: 'Earning rate history' });
    expect(rates).toHaveTextContent('1 Nov 2026, 12:30 AM PKT');
    expect(rates).toHaveTextContent('1 Oct 2026, 9:00 AM PKT');
    expect(screen.getByText('Issued 1 Nov 2026')).toBeInTheDocument();
    const ledger = screen.getByRole('region', { name: 'Loyalty history' });
    expect(ledger).toHaveTextContent('1 Nov 2026, 12:30 AM PKT');
    expect(ledger).toHaveTextContent('Expires 1 Nov 2027');
    expect(within(ledger).getByText('1 Nov 2026, 12:30 AM PKT').closest('time')).toHaveAttribute(
      'dateTime',
      '2026-10-31T19:30:00.000Z'
    );
    expect(document.body).not.toHaveTextContent(/\bUTC\b/);
  });
});
