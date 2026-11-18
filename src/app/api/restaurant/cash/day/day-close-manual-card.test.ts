import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

const mocks = vi.hoisted(() => ({
  readRun: null as null | ((ctx: unknown, request: Request) => Promise<Response>),
  mutationRuns: [] as Array<(args: unknown) => Promise<unknown>>,
  closePreview: vi.fn(),
  cutClose: vi.fn(),
  correctClose: vi.fn(),
}));

vi.mock('@/lib/restaurant/checkout-routes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/restaurant/checkout-routes')>();
  return {
    ...actual,
    moneyReadRoute: (options: { run: typeof mocks.readRun }) => {
      mocks.readRun = options.run;
      return vi.fn();
    },
    moneyMutationRoute: (options: { run: (args: unknown) => Promise<unknown> }) => {
      mocks.mutationRuns.push(options.run);
      return vi.fn();
    },
    resolveApprover: vi.fn().mockResolvedValue({ ok: true, staffProfileId: 'mgr' }),
  };
});
vi.mock('@/lib/restaurant/daily-close', () => ({
  closePreview: mocks.closePreview,
  cutClose: mocks.cutClose,
  correctClose: mocks.correctClose,
}));
vi.mock('@/lib/restaurant/terminal-audit', () => ({ recordTerminalOperatorAudit: vi.fn() }));

const D = (value: string) => new Prisma.Decimal(value);
const totals = {
  grossSales: D('10'),
  netSales: D('10'),
  deliveryFeeSales: D('0'),
  deliveryFeeRefunds: D('0'),
  taxTotal: D('0'),
  serviceChargeTotal: D('0'),
  tipTotal: D('0'),
  compTotal: D('0'),
  discountTotal: D('0'),
  refundTotal: D('0'),
  voidTotal: D('0'),
  cashExpected: D('0'),
  cashCounted: D('0'),
  cashVariance: D('0'),
};
const row = {
  count: 2,
  amount: '41.00',
  tipAmount: '0.00',
  refundCount: 0,
  refundAmount: '0.00',
  tipRefundAmount: '0.00',
  netAmount: '41.00',
  netTipAmount: '0.00',
};
const manualCardSummary = {
  ...row,
  cashiers: [{ ...row, staffProfileId: 'cashier-1', displayName: 'Amina' }],
};

await import('./preview/route');
await import('./close/route');
await import('./correct/route');
const [closeRun, correctRun] = mocks.mutationRuns;
const previewRun = mocks.readRun!;

describe('day-close routes carry the manual card summary to the register', () => {
  beforeEach(() => {
    mocks.closePreview.mockReset();
    mocks.cutClose.mockReset();
    mocks.correctClose.mockReset();
  });

  it('preview response includes manualCardSummary', async () => {
    mocks.closePreview.mockResolvedValue({
      ...totals,
      branchId: 'b1',
      businessDate: new Date('2026-08-19T00:00:00Z'),
      tenderTotals: [],
      manualCardSummary,
      readiness: {
        allBillsResolved: true,
        allDrawersClosed: true,
        openBillCount: 0,
        unresolvedOrderCount: 0,
        openDrawerCount: 0,
      },
      existingCloseId: null,
    });
    const request = new Request('http://x/preview?businessDate=2026-08-19');
    const body = await (await previewRun({ db: {}, device: { branchId: 'b1' } }, request)).json();
    expect(body.manualCardSummary).toEqual(manualCardSummary);
  });

  it('cut-close result includes manualCardSummary', async () => {
    mocks.cutClose.mockResolvedValue({
      dailyCloseId: 'close-1',
      totals,
      tenderTotals: [],
      manualCardSummary,
      replayed: false,
    });
    const result = (await closeRun({
      ctx: { db: {}, device: { branchId: 'b1' } },
      data: { businessDate: '2026-08-19' },
      actor: { staffProfileId: 'a' },
      now: new Date(),
    })) as { manualCardSummary: unknown };
    expect(result.manualCardSummary).toEqual(manualCardSummary);
  });

  it('correction result includes manualCardSummary', async () => {
    mocks.correctClose.mockResolvedValue({
      dailyCloseId: 'close-2',
      supersedesCloseId: 'close-1',
      totals,
      tenderTotals: [],
      manualCardSummary,
      replayed: false,
    });
    const result = (await correctRun({
      ctx: { db: {}, device: { branchId: 'b1' } },
      data: {
        businessDate: '2026-08-19',
        supersedesCloseId: 'close-1',
        reason: 'recount',
        approving: {},
      },
      actor: { staffProfileId: 'a' },
      now: new Date(),
    })) as { manualCardSummary: unknown };
    expect(result.manualCardSummary).toEqual(manualCardSummary);
  });
});
