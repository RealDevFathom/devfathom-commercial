import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
const mocks = vi.hoisted(() => ({
  branches: vi.fn(),
  ledger: vi.fn(),
  collectPayment: vi.fn(),
  sendReminder: vi.fn(),
}));
vi.mock('@/server/trpc', () => ({ createTRPCContext: vi.fn().mockResolvedValue({}) }));
vi.mock('./khata-router', () => ({ pharmacyKhataRouter: { createCaller: () => mocks } }));
import KhataPage from './page';
import KhataLoading from './loading';
import { parseMajorToMinor } from './amount';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.branches.mockResolvedValue([
    { id: 'branch-a', name: 'Main' },
    { id: 'branch-b', name: 'Gulberg' },
  ]);
  mocks.ledger.mockResolvedValue({
    truncated: false,
    accounts: [
      {
        id: 'fam-a',
        displayName: 'Ahmed household',
        payerName: 'Ahmed',
        phoneLast4: '4567',
        balanceMinor: 250_000,
        creditLimitMinor: 300_000,
        lastPaymentAt: new Date('2026-11-01T09:00:00Z'),
        oldestOverdueAt: new Date('2026-10-05T00:00:00Z'),
      },
      {
        id: 'fam-c',
        displayName: 'Clear household',
        payerName: 'Chaudhry',
        phoneLast4: null,
        balanceMinor: 0,
        creditLimitMinor: 0,
        lastPaymentAt: null,
        oldestOverdueAt: null,
      },
    ],
  });
});
afterEach(cleanup);
async function show(params: Record<string, string> = {}) {
  render(await KhataPage({ searchParams: Promise.resolve(params) }));
}

describe('DEV-730 Khata page', () => {
  it('shows who owes what: name, phone, balance, limit, last payment and actions', async () => {
    await show();
    expect(screen.getByRole('heading', { level: 1, name: 'Khata' })).toBeInTheDocument();
    expect(mocks.ledger).toHaveBeenCalledWith({ branchId: 'branch-a' });
    const table = screen.getByRole('table');
    for (const column of ['Account', 'Phone', 'Balance', 'Limit', 'Last payment', 'Status'])
      expect(within(table).getByRole('columnheader', { name: column })).toBeInTheDocument();
    const row = within(table).getByRole('row', { name: /Ahmed household/ });
    for (const text of [
      'Payer: Ahmed',
      'ending 4567',
      'PKR 2500.00',
      'PKR 3000.00',
      '2026-11-01',
      'Overdue since 2026-10-05',
    ])
      expect(within(row).getByText(text)).toBeInTheDocument();
    expect(
      within(row).getByRole('link', { name: 'Collect payment from Ahmed household' })
    ).toHaveAttribute('href', '/pharmacy/khata?branchId=branch-a&accountId=fam-a');
    expect(
      within(row).getByRole('button', { name: 'Send reminder to Ahmed household' })
    ).toHaveAttribute('type', 'submit');
    const clear = within(table).getByRole('row', { name: /Clear household/ });
    expect(within(clear).getByText('No payment yet')).toBeInTheDocument();
    expect(within(clear).getByText('Nothing owed')).toBeInTheDocument();
    expect(within(clear).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Total owed').parentElement).toHaveTextContent('PKR 2500.00');
  });

  it('opens a labelled collection form for the chosen account only', async () => {
    await show({ accountId: 'fam-a' });
    expect(screen.getByText('Collect payment · Ahmed household')).toBeInTheDocument();
    expect(screen.getByLabelText('Amount (PKR)')).toHaveValue('2500.00');
    expect(screen.getByLabelText('Payment method')).toHaveValue('CASH');
    expect(screen.getByRole('button', { name: 'Record payment' })).toBeEnabled();
    expect(mocks.collectPayment).not.toHaveBeenCalled();
  });

  it('ignores a forged account selection', async () => {
    await show({ accountId: 'fam-other' });
    expect(screen.queryByLabelText('Amount (PKR)')).not.toBeInTheDocument();
  });

  it('reports the action outcome carried on the redirect', async () => {
    await show({ notice: 'reminder-no-consent' });
    expect(screen.getByRole('alert')).toHaveTextContent('has not opted in');
    cleanup();
    await show({ notice: 'collected' });
    expect(screen.getAllByRole('status')[0]).toHaveTextContent('Payment recorded');
  });

  it('explains an empty branch', async () => {
    mocks.ledger.mockResolvedValue({ accounts: [], truncated: false });
    await show();
    expect(screen.getByRole('status')).toHaveTextContent('No Khata accounts on this branch yet');
  });

  it('rejects a forged branch before reading balances', async () => {
    await show({ branchId: 'foreign' });
    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
    expect(mocks.ledger).not.toHaveBeenCalled();
  });

  it('explains permission denial and exposes no accounts', async () => {
    mocks.branches.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    await show();
    expect(screen.getByRole('alert')).toHaveTextContent('authorized owner');
    expect(screen.queryByText('Ahmed household')).not.toBeInTheDocument();
  });

  it('has a textual loading state', () => {
    render(<KhataLoading />);
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Loading branch balances');
  });
});

describe('parseMajorToMinor', () => {
  it('parses rupees to paisa and refuses non-positive or malformed amounts', () => {
    expect(parseMajorToMinor('1500')).toBe(150_000);
    expect(parseMajorToMinor('1,500.5')).toBe(150_050);
    expect(parseMajorToMinor(' 0.05 ')).toBe(5);
    for (const bad of ['', '0', '0.00', '-5', '1.234', 'abc', '1e3'])
      expect(parseMajorToMinor(bad)).toBeNull();
  });
});
