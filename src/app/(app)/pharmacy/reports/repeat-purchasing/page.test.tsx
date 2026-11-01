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
    // The cutoff is a native date-time picker showing the same UTC instant.
    expect(screen.getByLabelText('As-of cutoff (UTC)')).toHaveAttribute('type', 'datetime-local');
    expect(screen.getByLabelText('As-of cutoff (UTC)')).toHaveValue('2026-05-01T00:00');
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
      expect(screen.getByText('Main')).toBeInTheDocument();
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
    expect(screen.getByLabelText('As-of cutoff (UTC)')).toHaveValue('2026-05-01T00:00');
    // One branch: its name is shown instead of a picker.
    expect(screen.queryByLabelText('Selected authorized branches')).not.toBeInTheDocument();
    expect(screen.getByText('Main')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply cohort window' })).toBeEnabled();
    expect(screen.queryByText('Identity coverage')).not.toBeInTheDocument();
    expect(screen.queryByText('Fully elapsed follow-up')).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+(?:\.\d+)?%/)).not.toBeInTheDocument();
  });
  it('defaults to the last 90 days ending today with the cutoff in a date-time picker', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T14:59:42.123Z'));
    try {
      render(await Page({ searchParams: Promise.resolve({}) }));
    } finally {
      vi.useRealTimers();
    }
    expect(mocks.repeatPurchasing).toHaveBeenCalledWith({
      from: '2026-08-04',
      to: '2026-11-01',
      asOf: '2026-11-01T14:59:00.000Z',
    });
    expect(screen.getByLabelText('Enrollment from (UTC)')).toHaveValue('2026-08-04');
    expect(screen.getByLabelText('Enrollment through (UTC)')).toHaveValue('2026-11-01');
    expect(screen.getByLabelText('As-of cutoff (UTC)')).toHaveValue('2026-11-01T14:59');
  });
  it('reads a submitted picker cutoff as UTC', async () => {
    render(
      await Page({
        searchParams: Promise.resolve({
          asOf: '2026-05-01T10:30',
          from: '2026-03-01',
          to: '2026-04-30',
        }),
      })
    );
    expect(mocks.repeatPurchasing).toHaveBeenCalledWith({
      from: '2026-03-01',
      to: '2026-04-30',
      asOf: '2026-05-01T10:30:00Z',
    });
  });
  it('offers a branch picker only when there is more than one branch', async () => {
    mocks.branches.mockResolvedValue({
      branches: [
        { id: 'b1', name: 'Main' },
        { id: 'b2', name: 'North' },
      ],
    });
    render(await Page({ searchParams: Promise.resolve({ branch: 'b2' }) }));
    expect(screen.getByLabelText('Selected authorized branches')).toHaveValue('b2');
    expect(screen.getByRole('link', { name: 'Back to reports' })).toHaveAttribute(
      'href',
      '/pharmacy/reports?branch=b2'
    );
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
