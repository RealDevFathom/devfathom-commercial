import { cleanup, render, screen } from '@testing-library/react';
import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createTRPCContext: vi.fn(),
  branches: vi.fn(),
  financialStatements: vi.fn(),
}));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/server/routers/pharmacy-reports', () => ({
  pharmacyReportsRouter: { createCaller: () => ({ branches: mocks.branches }) },
}));
vi.mock('@/server/routers/pharmacy-finance', () => ({
  pharmacyFinanceRouter: {
    createCaller: () => ({ financialStatements: mocks.financialStatements }),
  },
}));

import Page from './page';

async function show(query: Record<string, string | string[]> = {}) {
  return render(await Page({ searchParams: Promise.resolve(query) }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-28T12:00:00.000Z'));
  vi.resetAllMocks();
  mocks.createTRPCContext.mockResolvedValue({ tenant: 'scoped' });
  mocks.branches.mockResolvedValue({ branches: [{ id: 'branch-1', name: 'Main branch' }] });
  mocks.financialStatements.mockResolvedValue({
    accounts: [
      { accountCode: 'CASH', currency: 'PKR', closingMinor: '500' },
      { accountCode: 'BANK', currency: 'PKR', closingMinor: '250' },
      { accountCode: 'ACCOUNTS_PAYABLE', currency: 'PKR', closingMinor: '-200' },
      { accountCode: 'GOODS_RECEIVED_ACCRUAL', currency: 'PKR', closingMinor: '-100' },
    ],
    freshness: { retrievedAt: new Date('2026-10-28T12:00:00.000Z') },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('posted cash coverage page', () => {
  it('reads the existing authorized aggregate and exposes an exact safe export', async () => {
    await show({ branch: 'branch-1', cutoff: '2026-10-27' });
    expect(mocks.financialStatements).toHaveBeenCalledWith({
      branchId: 'branch-1',
      from: '2026-10-27T00:00:00.000Z',
      to: '2026-10-28T00:00:00.000Z',
      page: 1,
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Posted cash coverage');
    expect(screen.getByText('2.50×')).toBeVisible();
    expect(screen.getByText('Exact ratio 750/300')).toBeVisible();
    expect(screen.getByText('PKR 5.00')).toBeVisible();
    const exportLink = screen.getByRole('link', { name: 'Export safe CSV' });
    expect(exportLink).toHaveAttribute('download', 'posted-cash-coverage-2026-10-27.csv');
    expect(decodeURIComponent(exportLink.getAttribute('href')!)).toContain('"750/300"');
  });

  it('renders permission denial without data or export leakage', async () => {
    mocks.branches.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    await show({ branch: 'branch-1' });
    expect(screen.getByRole('alert')).toHaveTextContent('Owner financial-report permission');
    expect(mocks.financialStatements).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'Export safe CSV' })).toBeNull();
  });

  it.each([
    ['reader error', { branch: 'branch-1' }],
    ['duplicate cutoff', { branch: 'branch-1', cutoff: ['2026-10-27', '2026-10-28'] }],
    ['future cutoff', { branch: 'branch-1', cutoff: '2026-10-29' }],
  ])('fails closed for %s and never presents partial KPI output', async (name, query) => {
    if (name === 'reader error') mocks.financialStatements.mockRejectedValue(new Error('offline'));
    await show(query);
    expect(screen.getByRole('alert')).toHaveTextContent('No financial data was changed');
    expect(screen.queryByText('2.50×')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Export safe CSV' })).toBeNull();
  });
});
