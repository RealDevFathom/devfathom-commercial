import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PlatformOverviewPage from './page';

const mocks = vi.hoisted(() => ({
  requirePlatformRead: vi.fn(),
  withPlatformDb: vi.fn(),
  groupBy: vi.fn(),
}));
vi.mock('@/lib/platform/page-access', () => ({ requirePlatformRead: mocks.requirePlatformRead }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: mocks.withPlatformDb }));

const statuses = [
  'PROSPECT',
  'ONBOARDING',
  'ACTIVE',
  'GRACE',
  'SUSPENDED',
  'TERMINATED',
  'PURGING',
  'PURGED',
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requirePlatformRead.mockResolvedValue({ role: 'SUPER_ADMIN' });
  mocks.groupBy.mockResolvedValue([]);
  mocks.withPlatformDb.mockImplementation((run) =>
    run({
      organization: { groupBy: mocks.groupBy, findMany: vi.fn().mockResolvedValue([]) },
      platformContract: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { value: 0 }, _count: { _all: 0 } }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      platformOpportunity: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { estimatedValue: 0 }, _count: 0 }),
      },
      platformInvoice: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { total: 0 }, _count: { _all: 0 } }),
      },
      platformJob: { groupBy: vi.fn().mockResolvedValue([]) },
    })
  );
});
afterEach(cleanup);

function rowCounts(label: string) {
  const row = screen.getByRole('rowheader', { name: label }).closest('tr')!;
  return within(row)
    .getAllByRole('cell')
    .map((cell) => cell.textContent);
}

describe('PlatformOverviewPage vertical lifecycle counts', () => {
  it('counts every lifecycle per vertical, excludes demos, and preserves combined headline totals', async () => {
    mocks.groupBy.mockResolvedValue([
      ...statuses.map((status, index) => ({
        vertical: 'AGENCY',
        status,
        _count: { _all: index + 1 },
      })),
      { vertical: 'RESTAURANT', status: 'ACTIVE', _count: { _all: 11 } },
      { vertical: 'RESTAURANT', status: 'GRACE', _count: { _all: 13 } },
      { vertical: 'RESTAURANT', status: 'ONBOARDING', _count: { _all: 17 } },
      { vertical: 'PHARMACY', status: 'ACTIVE', _count: { _all: 19 } },
    ]);
    render(await PlatformOverviewPage());

    expect(mocks.requirePlatformRead).toHaveBeenCalledWith('/platform');
    expect(mocks.groupBy).toHaveBeenCalledExactlyOnceWith({
      by: ['vertical', 'status'],
      where: { isDemo: false },
      _count: { _all: true },
    });
    const table = screen.getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent)
    ).toEqual(['Vertical', 'Total', ...statuses]);
    expect(rowCounts('Agency')).toEqual(['36', '1', '2', '3', '4', '5', '6', '7', '8']);
    expect(rowCounts('Restaurant')).toEqual(['41', '0', '17', '11', '13', '0', '0', '0', '0']);
    expect(rowCounts('Pharmacy')).toEqual(['19', '0', '0', '19', '0', '0', '0', '0', '0']);
    const activeMetric = screen.getByText('Active organizations').closest('article')!;
    expect(within(activeMetric).getByText('50')).toBeInTheDocument();
    expect(within(activeMetric).getByText('19 onboarding')).toBeInTheDocument();
    expect(screen.getByText(/Demo organizations are excluded/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Organization lifecycle counts' })).toHaveAttribute(
      'tabindex',
      '0'
    );
  });

  it('shows zero for absent verticals and lifecycle states', async () => {
    render(await PlatformOverviewPage());
    for (const label of ['Agency', 'Restaurant', 'Pharmacy']) {
      expect(rowCounts(label)).toEqual(Array(9).fill('0'));
    }
    expect(screen.getByText('Activation queue is clear')).toBeInTheDocument();
    expect(screen.getByText('No renewals due')).toBeInTheDocument();
  });

  it('does not query counts without platform read access', async () => {
    mocks.requirePlatformRead.mockRejectedValue(new Error('Forbidden'));
    await expect(PlatformOverviewPage()).rejects.toThrow('Forbidden');
    expect(mocks.withPlatformDb).not.toHaveBeenCalled();
  });

  it('propagates a failed aggregate instead of reporting misleading zero counts', async () => {
    mocks.groupBy.mockRejectedValue(new Error('Database unavailable'));
    await expect(PlatformOverviewPage()).rejects.toThrow('Database unavailable');
  });
});
