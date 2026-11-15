import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
const mocks = vi.hoisted(() => ({
  branches: vi.fn(),
  customers: vi.fn(),
  history: vi.fn(),
  setReminderLanguage: vi.fn(),
  earnRate: vi.fn(),
  replace: vi.fn(),
}));
vi.mock('next/navigation', async () => ({
  ...(await vi.importActual<typeof import('next/navigation')>('next/navigation')),
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock('@/server/trpc', () => ({ createTRPCContext: vi.fn().mockResolvedValue({}) }));
vi.mock('./loyalty-router', () => ({ pharmacyLoyaltyRouter: { createCaller: () => mocks } }));
import LoyaltyPage from './page';
import LoyaltyLoading from './loading';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.branches.mockResolvedValue([{ id: 'branch-a', name: 'Main' }]);
  mocks.earnRate.mockResolvedValue({ current: null, versions: [] });
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
    expect(screen.getByText(/Version 2, in effect since 2026-11-10/)).toBeInTheDocument();
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
    render(<LoyaltyLoading />);
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Loading customer selection');
  });
});
