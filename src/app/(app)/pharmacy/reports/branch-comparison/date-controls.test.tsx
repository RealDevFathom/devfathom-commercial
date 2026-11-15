import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { branchComparison } = vi.hoisted(() => ({ branchComparison: vi.fn() }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: vi.fn().mockResolvedValue({}) }));
vi.mock('@/server/routers/pharmacy-reports', () => ({
  pharmacyReportsRouter: { createCaller: () => ({ branchComparison }) },
}));

import { createTRPCContext } from '@/server/trpc';
import BranchComparisonPage from './page';

beforeEach(() => {
  branchComparison.mockReset().mockResolvedValue({
    estimateMethod: 'Sum of recorded values.',
    estimateExclusions: ['events without a recorded value'],
    rows: [],
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('branch comparison date controls', () => {
  it('submits editable dates as GET parameters to the existing report', async () => {
    const view = render(
      await BranchComparisonPage({
        searchParams: Promise.resolve({ from: '2026-10-01', to: '2026-10-07' }),
      })
    );
    const form = screen.getByRole('form', { name: 'Branch comparison dates' });
    expect(form).toHaveAttribute('action', '/pharmacy/reports/branch-comparison');
    expect(form).toHaveAttribute('method', 'get');
    const from = within(form).getByLabelText('From');
    const to = within(form).getByLabelText('To');
    expect(from).toHaveValue('2026-10-01');
    expect(to).toHaveValue('2026-10-07');
    expect(from).toHaveAttribute('type', 'date');
    expect(to).toHaveAttribute('type', 'date');
    expect(from).toBeRequired();
    expect(to).toBeRequired();
    expect(within(form).getByRole('button', { name: 'Apply dates' })).toHaveAttribute(
      'type',
      'submit'
    );

    fireEvent.change(from, { target: { value: '2026-10-08' } });
    fireEvent.change(to, { target: { value: '2026-10-14' } });
    const submitted = Object.fromEntries(new FormData(form as HTMLFormElement));
    expect(submitted).toEqual({ from: '2026-10-08', to: '2026-10-14' });
    view.unmount();
    render(
      await BranchComparisonPage({
        searchParams: Promise.resolve(submitted as { from: string; to: string }),
      })
    );
    expect(branchComparison).toHaveBeenLastCalledWith({ from: '2026-10-08', to: '2026-10-14' });
    expect(screen.getByLabelText('From')).toHaveValue('2026-10-08');
    expect(screen.getByLabelText('To')).toHaveValue('2026-10-14');
  });

  it('uses the existing current-day defaults when dates are omitted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
    render(await BranchComparisonPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByLabelText('From')).toHaveValue('2026-11-02');
    expect(screen.getByLabelText('To')).toHaveValue('2026-11-02');
    expect(branchComparison).toHaveBeenCalledWith({ from: '2026-11-02', to: '2026-11-02' });
  });

  it('defaults to the Karachi business day after midnight PKT, not the UTC day', async () => {
    vi.mocked(createTRPCContext).mockResolvedValueOnce({
      organization: { id: 'org-a', currency: 'PKR', timezone: 'Asia/Karachi' },
      entitlements: { organizationId: 'org-a' },
    } as never);
    vi.useFakeTimers({ toFake: ['Date'] });
    // 01:30 PKT on 15 November is still 14 November in UTC.
    vi.setSystemTime(new Date('2026-11-14T20:30:00Z'));
    render(await BranchComparisonPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByLabelText('From')).toHaveValue('2026-11-15');
    expect(branchComparison).toHaveBeenCalledWith({ from: '2026-11-15', to: '2026-11-15' });
  });

  it('keeps rejected dates editable and associates the server error with both controls', async () => {
    branchComparison.mockRejectedValue(new TRPCError({ code: 'BAD_REQUEST' }));
    render(
      await BranchComparisonPage({
        searchParams: Promise.resolve({ from: '2026-10-14', to: '2026-10-08' }),
      })
    );
    const message = 'Check that the report dates are valid, then try again.';
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByLabelText('From')).toHaveValue('2026-10-14');
    expect(screen.getByLabelText('To')).toHaveValue('2026-10-08');
    for (const label of ['From', 'To']) {
      expect(screen.getByLabelText(label)).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByLabelText(label)).toHaveAccessibleDescription(message);
    }
    expect(screen.getByRole('button', { name: 'Apply dates' })).toBeEnabled();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
