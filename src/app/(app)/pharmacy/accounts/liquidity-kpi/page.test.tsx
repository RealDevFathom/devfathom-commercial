import { cleanup, render, screen } from '@testing-library/react';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { financialStatements } = vi.hoisted(() => ({ financialStatements: vi.fn() }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: vi.fn(async () => ({})) }));
vi.mock('@/server/routers/pharmacy-finance', () => ({
  pharmacyFinanceRouter: { createCaller: () => ({ financialStatements }) },
}));

import LiquidityKpiPage from './page';

const query = { branch: 'branch-a', from: '2026-10-01', to: '2026-10-20' };
describe('posted cash-coverage page', () => {
  beforeEach(() => financialStatements.mockReset());

  it('renders independent exact evidence and an export only after an authorized response', async () => {
    financialStatements.mockResolvedValue({
      accounts: [
        { accountCode: 'CASH', currency: 'PKR', closingMinor: '300' },
        { accountCode: 'BANK', currency: 'PKR', closingMinor: '200' },
        { accountCode: 'ACCOUNTS_PAYABLE', currency: 'PKR', closingMinor: '-300' },
        { accountCode: 'GOODS_RECEIVED_ACCRUAL', currency: 'PKR', closingMinor: '-100' },
      ],
      freshness: { retrievedAt: new Date('2026-10-20T01:00:00Z') },
      coverage: { completeness: 'unknown' },
    });
    render(await LiquidityKpiPage({ searchParams: Promise.resolve(query) }));
    expect(financialStatements).toHaveBeenCalledWith({
      branchId: 'branch-a',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-20T00:00:00.000Z',
      page: 1,
    });
    expect(screen.getByText('5 / 4')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Download evidence CSV' })).toHaveAttribute('download');
    expect(screen.getByText(/coverage reported by the authorized reader: unknown/i)).toBeVisible();
  });

  it('does not fetch or export without an explicit branch or for an oversized window', async () => {
    const missing = await LiquidityKpiPage({
      searchParams: Promise.resolve({ from: query.from, to: query.to }),
    });
    render(missing);
    expect(screen.queryByRole('link', { name: 'Download evidence CSV' })).not.toBeInTheDocument();
    expect(financialStatements).not.toHaveBeenCalled();
    cleanup();
    render(
      await LiquidityKpiPage({
        searchParams: Promise.resolve({ branch: 'branch-a', from: '2026-01-01', to: '2026-10-20' }),
      })
    );
    expect(financialStatements).not.toHaveBeenCalled();
  });

  it.each([
    ['denied', new TRPCError({ code: 'FORBIDDEN' })],
    ['reader error', new Error('provider detail must not escape')],
  ])('shows a safe %s state without sensitive DTO export', async (_label, cause) => {
    financialStatements.mockRejectedValue(cause);
    render(await LiquidityKpiPage({ searchParams: Promise.resolve(query) }));
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Download evidence CSV' })).not.toBeInTheDocument();
    expect(screen.queryByText('provider detail must not escape')).not.toBeInTheDocument();
  });
});

describe('fail-closed explicit liquidity selection', () => {
  it.each([
    { from: ['2026-10-01', '2026-10-02'] },
    { to: ['2026-10-19', '2026-10-20'] },
    { from: '' },
    { to: '' },
    { from: '2026-02-30' },
    { branch: ['branch-a', 'foreign'] },
    { branch: '' },
  ])('does not default/financially read/export explicit invalid %j', async (invalid) => {
    financialStatements.mockReset();
    render(await LiquidityKpiPage({ searchParams: Promise.resolve({ ...query, ...invalid }) }));
    expect(financialStatements).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Download evidence CSV' })).not.toBeInTheDocument();
    cleanup();
  });
});

describe('current-head residual: nullable evidence display', () => {
  it('renders incomplete balances as Unknown and exports empty cells, not made-up zero', async () => {
    financialStatements.mockResolvedValue({
      accounts: [{ accountCode: 'BANK', currency: 'PKR', closingMinor: '5' }],
      freshness: { retrievedAt: new Date('2026-10-20T01:00:00Z') },
      coverage: { completeness: 'unknown' },
    });
    render(await LiquidityKpiPage({ searchParams: Promise.resolve(query) }));
    expect(screen.getAllByText('Unknown').length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText('0 minor')).not.toBeInTheDocument();
    expect(screen.queryByText('null minor')).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Download evidence CSV' });
    const href = link.getAttribute('href')!;
    const csv = decodeURIComponent(href.slice(href.indexOf(',') + 1));
    expect(csv.split('\r\n')[1]).toContain('"PKR","","5","","","","","",""');
    cleanup();
  });
});
