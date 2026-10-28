import { cleanup, render, screen } from '@testing-library/react';
import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ financialStatements: vi.fn(), createTRPCContext: vi.fn() }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/server/routers/pharmacy-finance', () => ({
  pharmacyFinanceRouter: {
    createCaller: () => ({ financialStatements: mocks.financialStatements }),
  },
}));
import Page from './page';

const result = {
  from: new Date('2026-10-01T00:00:00Z'),
  to: new Date('2026-10-26T00:00:00Z'),
  page: 1,
  journalCount: 26,
  journal: [
    {
      id: 'entry-1',
      sourceKind: 'SALE',
      sourceId: '=source',
      description: 'Sale',
      currency: 'PKR',
      occurredAt: new Date('2026-10-20T12:00:00Z'),
      reversesEntryId: null,
      lines: [
        {
          id: 'line-1',
          accountCode: 'CASH',
          side: 'DEBIT',
          amountMinor: BigInt('9007199254740993123'),
          lotId: null,
        },
      ],
    },
  ],
};

beforeEach(() => {
  mocks.createTRPCContext.mockResolvedValue({});
  mocks.financialStatements.mockResolvedValue(result);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('journal evidence export page', () => {
  it('calls the existing authorized report and prominently labels bounded coverage', async () => {
    render(
      await Page({
        searchParams: Promise.resolve({
          branch: 'branch-1',
          from: '2026-10-01',
          to: '2026-10-26',
          page: '1',
        }),
      })
    );
    expect(mocks.financialStatements).toHaveBeenCalledWith({
      branchId: 'branch-1',
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-26T00:00:00Z',
      page: 1,
    });
    expect(
      screen.getByText(/26 matching entries · page 1 · 25-entry page limit/)
    ).toBeInTheDocument();
    expect(screen.getByText(/Partial evidence: showing entries 1–1 of 26/)).toBeInTheDocument();
    expect(screen.getByText('9007199254740993123')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download this page CSV' })).toHaveAttribute(
      'download'
    );
  });

  it('does not read or offer an export without an explicit branch', async () => {
    render(await Page({ searchParams: Promise.resolve({ from: '2026-10-01', to: '2026-10-26' }) }));
    expect(mocks.financialStatements).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('No default branch');
    expect(screen.queryByRole('link', { name: /Download/ })).not.toBeInTheDocument();
  });

  it('rejects a window over 92 days before fetching', async () => {
    render(
      await Page({
        searchParams: Promise.resolve({ branch: 'branch-1', from: '2026-01-01', to: '2026-10-26' }),
      })
    );
    expect(mocks.financialStatements).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('no more than 92 days');
  });

  it.each(['FORBIDDEN', 'UNAUTHORIZED'] as const)(
    'does not expose an export after %s denial',
    async (code) => {
      mocks.financialStatements.mockRejectedValue(new TRPCError({ code }));
      render(
        await Page({
          searchParams: Promise.resolve({
            branch: 'invalid-branch',
            from: '2026-10-01',
            to: '2026-10-26',
          }),
        })
      );
      expect(screen.getByRole('alert')).toHaveTextContent('authorized active branch');
      expect(screen.queryByRole('link', { name: /Download/ })).not.toBeInTheDocument();
    }
  );

  it('does not leak reader errors or offer an export when the read fails', async () => {
    mocks.financialStatements.mockRejectedValue(new Error('provider secret and raw SQL'));
    render(
      await Page({
        searchParams: Promise.resolve({ branch: 'branch-1', from: '2026-10-01', to: '2026-10-26' }),
      })
    );
    expect(screen.getByRole('alert')).toHaveTextContent('could not be read');
    expect(screen.getByRole('alert')).not.toHaveTextContent('provider secret');
    expect(screen.queryByRole('link', { name: /Download/ })).not.toBeInTheDocument();
  });
});

describe('journal reader DTO and fail-closed query regressions', () => {
  it('renders and exports the real Prisma Int journal DTO', async () => {
    mocks.financialStatements.mockResolvedValue({
      ...result,
      journal: result.journal.map((item) => ({
        ...item,
        lines: item.lines.map((line) => ({ ...line, amountMinor: 12345 })),
      })),
    });
    render(
      await Page({
        searchParams: Promise.resolve({ branch: 'branch-1', from: '2026-10-01', to: '2026-10-26' }),
      })
    );
    const link = screen.getByRole('link', { name: 'Download this page CSV' });
    expect(decodeURIComponent(link.getAttribute('href')!)).toContain('"12345"');
  });
  it.each([
    { from: ['2026-10-01', '2026-10-02'] },
    { to: ['2026-10-25', '2026-10-26'] },
    { from: '' },
    { to: '' },
    { page: ['1', '2'] },
    { from: '2026-02-30' },
    { branch: ['branch-1', 'branch-2'] },
    { branch: '' },
  ])('rejects explicit ambiguous/invalid query %j before financial reads', async (invalid) => {
    render(
      await Page({
        searchParams: Promise.resolve({
          branch: 'branch-1',
          from: '2026-10-01',
          to: '2026-10-26',
          ...invalid,
        }),
      })
    );
    expect(mocks.financialStatements).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Download/ })).not.toBeInTheDocument();
  });
});
