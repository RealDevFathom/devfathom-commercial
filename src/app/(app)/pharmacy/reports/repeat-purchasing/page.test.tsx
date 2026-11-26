import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = vi.hoisted(() => ({ repeatPurchasing: vi.fn(), branches: vi.fn() }));
const ctx = vi.hoisted(() => ({ organization: { timezone: 'UTC' } as { timezone: string } }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: vi.fn(async () => ctx) }));
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
afterEach(() => {
  cleanup();
  ctx.organization.timezone = 'UTC';
});
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
    expect(screen.getByLabelText('As-of cutoff (UTC)')).toHaveValue('2026-05-01T00:00');
    expect(screen.getByRole('button', { name: 'Apply cohort window' })).toHaveAttribute(
      'type',
      'submit'
    );
  });
  it('takes the cutoff from a date-time picker and shows it in words, never raw ISO', async () => {
    render(
      await Page({
        searchParams: Promise.resolve({
          asOf: '2026-05-01T09:30',
          from: '2026-01-01',
          to: '2026-01-31',
        }),
      })
    );
    expect(mocks.repeatPurchasing).toHaveBeenCalledWith({
      from: '2026-01-01',
      to: '2026-01-31',
      asOf: '2026-05-01T09:30:00Z',
    });
    const cutoff = screen.getByLabelText('As-of cutoff (UTC)');
    expect(cutoff).toHaveAttribute('type', 'datetime-local');
    expect(cutoff).toHaveValue('2026-05-01T09:30');
    expect(screen.getByText(/Frozen cutoff: 1 May 2026, 12:00 AM UTC\./)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
  it('reads the picked cutoff and shows times in the organization time zone', async () => {
    ctx.organization.timezone = 'Asia/Karachi';
    mocks.repeatPurchasing.mockResolvedValue({
      ...empty,
      asOf: '2026-05-01T04:30:00.000Z',
      earliestObservedAt: '2026-01-01T19:30:00.000Z',
    });
    render(
      await Page({
        searchParams: Promise.resolve({
          asOf: '2026-05-01T09:30',
          from: '2026-01-01',
          to: '2026-01-31',
        }),
      })
    );
    expect(mocks.repeatPurchasing).toHaveBeenCalledWith({
      from: '2026-01-01',
      to: '2026-01-31',
      asOf: '2026-05-01T04:30:00Z',
    });
    expect(screen.getByLabelText('As-of cutoff (PKT)')).toHaveValue('2026-05-01T09:30');
    expect(screen.getByText(/Frozen cutoff: 1 May 2026, 9:30 AM PKT\./)).toBeInTheDocument();
    expect(screen.getByText(/2 Jan 2026, 12:30 AM PKT/)).toBeInTheDocument();
  });
  it.each([
    ['2026-10-25T00:30:00Z', '2026-10-25T01:30', '2026-10-25T00:30:00Z'],
    ['2026-10-25T01:30:42.123Z', '2026-10-25T01:30', '2026-10-25T01:30:42.123Z'],
    ['2026-10-25T02:30:00Z', '2026-10-25T02:30', '2026-10-25T00:30:00Z'],
  ])('resubmits a London cutoff of %s displayed as %s', async (original, displayed, expected) => {
    ctx.organization.timezone = 'Europe/London';
    const from = '2026-08-01';
    const to = '2026-08-31';
    render(await Page({ searchParams: Promise.resolve({ from, to, asOf: original }) }));
    const cutoff = screen.getByLabelText<HTMLInputElement>('As-of cutoff (Europe/London)');
    expect(cutoff).toHaveValue(displayed);
    const form = cutoff.form!;
    const picked = '2026-10-25T01:30';
    if (displayed !== picked) fireEvent.change(cutoff, { target: { value: picked } });
    const submitted = new FormData(form);
    expect(submitted.get('asOf')).toBe(picked);
    const query: Record<string, string> = {};
    submitted.forEach((value, key) => {
      if (typeof value === 'string') query[key] = value;
    });
    cleanup();
    mocks.repeatPurchasing.mockClear();
    render(await Page({ searchParams: Promise.resolve(query) }));
    expect(mocks.repeatPurchasing).toHaveBeenCalledExactlyOnceWith({ from, to, asOf: expected });
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
      expect(screen.getByRole('option', { hidden: true, name: 'Main' })).toBeInTheDocument();
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
    expect(screen.getByLabelText('Selected authorized branches')).toHaveValue(query.branch);
    expect(screen.getByRole('option', { hidden: true, name: 'Main' })).toBeInTheDocument();
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
    const { container } = render(<Loading />);
    expect(screen.queryByRole('main')).not.toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Checking complete follow-up');
  });
});
