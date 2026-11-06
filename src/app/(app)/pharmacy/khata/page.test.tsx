import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
const mocks = vi.hoisted(() => ({ branches: vi.fn(), accounts: vi.fn() }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: vi.fn().mockResolvedValue({}) }));
vi.mock('./khata-router', () => ({ pharmacyKhataListRouter: { createCaller: () => mocks } }));
import KhataPage from './page';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.branches.mockResolvedValue([{ id: 'b', name: 'Main' }]);
  mocks.accounts.mockResolvedValue({
    rows: [
      {
        id: 'a',
        displayName: 'Family',
        phone: '03001234567',
        balanceMinor: 2300,
        creditLimitMinor: 5000,
        lastPayment: { amountMinor: 700, occurredAt: new Date('2026-10-01T00:00:00Z') },
      },
    ],
    next: 'a',
  });
});
afterEach(cleanup);
async function show(params: Record<string, string> = {}) {
  render(await KhataPage({ searchParams: Promise.resolve(params) }));
}
it('shows account information and a next-page link', async () => {
  await show();
  expect(screen.getByText('Family')).toBeInTheDocument();
  expect(screen.getByText('03001234567')).toBeInTheDocument();
  expect(screen.getByText('23.00')).toBeInTheDocument();
  expect(screen.getByText('50.00')).toBeInTheDocument();
  expect(screen.getByText(/7.00/)).toHaveTextContent('1 Oct 2026');
  expect(screen.getByRole('link', { name: 'Next accounts' })).toHaveAttribute(
    'href',
    '/pharmacy/khata?branchId=b&after=a'
  );
});
it('does not read a forged branch', async () => {
  await show({ branchId: 'foreign' });
  expect(mocks.accounts).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
});
it('explains denied access without exposing records', async () => {
  mocks.branches.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
  await show();
  expect(screen.getByRole('alert')).toHaveTextContent('authorized owner');
  expect(screen.queryByText('Family')).not.toBeInTheDocument();
});
it('explains an empty account list', async () => {
  mocks.accounts.mockResolvedValue({ rows: [], next: null });
  await show();
  expect(screen.getByRole('status')).toHaveTextContent('No family accounts');
});
