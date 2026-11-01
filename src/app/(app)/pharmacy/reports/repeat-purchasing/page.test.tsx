import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = vi.hoisted(() => ({ repeatPurchasing: vi.fn(), branches: vi.fn() }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: vi.fn().mockResolvedValue({}) }));
vi.mock('@/server/routers/pharmacy-reports', () => ({
  pharmacyReportsRouter: { createCaller: () => mocks },
}));
import Page from './page';
import Loading from './loading';
import { summarizeRepeatPurchasing } from '@/lib/pharmacy/repeat-purchasing';
const empty = summarizeRepeatPurchasing([], 'org', {
  branchIds: ['b1'],
  from: '2026-01-01',
  to: '2026-01-31',
  asOf: '2026-05-01T00:00:00Z',
});
beforeEach(() => {
  mocks.repeatPurchasing.mockResolvedValue(empty);
  mocks.branches.mockResolvedValue({ branches: [{ id: 'b1', name: 'Main' }] });
});
afterEach(cleanup);
describe('repeat purchasing page', () => {
  it('shows unavailable denominators, anonymous coverage and observation limits', async () => {
    render(await Page({ searchParams: Promise.resolve({}) }));
    expect(
      screen.getByRole('heading', { name: 'Repeat purchasing', level: 1 })
    ).toBeInTheDocument();
    expect(screen.getAllByText('Unavailable')).toHaveLength(4);
    expect(screen.getByText(/No identified customers first observed/)).toBeInTheDocument();
    expect(screen.getByText(/off-system purchases are unknown/)).toBeInTheDocument();
    expect(screen.getByText(/10-second database execution budget/)).toBeInTheDocument();
    expect(screen.queryByText(/above 10,000 receipts/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Enrollment from (UTC)')).toBeRequired();
  });
  it('preserves frozen cutoff and selected scope on submission', async () => {
    const query = {
      asOf: '2026-05-01T00:00:00Z',
      from: '2026-01-01',
      to: '2026-01-31',
      branch: 'b1',
    };
    render(await Page({ searchParams: Promise.resolve(query) }));
    expect(mocks.repeatPurchasing).toHaveBeenCalledWith({
      from: query.from,
      to: query.to,
      asOf: query.asOf,
      branchId: 'b1',
    });
    expect(screen.getByLabelText('Report cutoff (UTC date and time)')).toHaveValue(query.asOf);
    expect(screen.getByRole('button', { name: 'Apply cohort window' })).toHaveAttribute(
      'type',
      'submit'
    );
  });
  it('shows loaded eligible, repeated and immature counts', async () => {
    mocks.repeatPurchasing.mockResolvedValue({
      ...empty,
      enrolledCustomers: 3,
      horizons: [{ days: 30, eligible: 2, repeated: 1, immature: 1, ratePercent: 50 }],
    });
    render(await Page({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText('50.0%')).toBeInTheDocument();
    expect(screen.getByText(/1 repeat \/ 2 eligible customers · 1 immature/)).toBeInTheDocument();
  });
  it.each(['FORBIDDEN', 'BAD_REQUEST', 'INTERNAL_SERVER_ERROR'] as const)(
    'handles %s without partial rates',
    async (code) => {
      mocks.repeatPurchasing.mockRejectedValue(new TRPCError({ code }));
      render(await Page({ searchParams: Promise.resolve({}) }));
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Main' })).toBeInTheDocument();
      expect(screen.queryByText('Identity coverage')).not.toBeInTheDocument();
    }
  );
  it.each([
    'canceling statement due to statement timeout',
    'Backend connection failed: internal-report-host',
  ])('preserves filters and suppresses rates when report rejects: %s', async (message) => {
    mocks.repeatPurchasing.mockRejectedValueOnce(new Error(message));
    const query = {
      asOf: '2026-05-01T00:00:00Z',
      from: '2026-01-01',
      to: '2026-01-31',
      branch: 'b1',
    };
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve(query) }));
    render(<div dangerouslySetInnerHTML={{ __html: html }} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Report unavailable.');
    expect(alert).toHaveTextContent('Retry or select a single branch');
    expect(alert).toHaveTextContent('no partial rates are shown');
    expect(alert).not.toHaveTextContent(/10,000 receipts|1,000 details|timeout|timed out/i);
    expect(html).not.toContain(message);
    expect(screen.getByLabelText('Enrollment from (UTC)')).toHaveValue(query.from);
    expect(screen.getByLabelText('Enrollment through (UTC)')).toHaveValue(query.to);
    expect(screen.getByLabelText('Report cutoff (UTC date and time)')).toHaveValue(query.asOf);
    expect(screen.getByLabelText('Selected authorized branches')).toHaveValue(query.branch);
    expect(screen.getByRole('option', { name: 'Main' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply cohort window' })).toBeEnabled();
    expect(screen.queryByText('Identity coverage')).not.toBeInTheDocument();
    expect(screen.queryByText('Fully elapsed follow-up')).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+(?:\.\d+)?%/)).not.toBeInTheDocument();
  });
  it('suppresses results if branch lookup fails', async () => {
    mocks.branches.mockRejectedValueOnce(new Error('Unavailable'));
    render(await Page({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Identity coverage')).not.toBeInTheDocument();
  });
  it('provides meaningful loading state without animated dependency', () => {
    render(<Loading />);
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Checking complete follow-up');
  });
});
