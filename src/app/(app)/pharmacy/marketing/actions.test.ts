import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  revalidate: vi.fn(),
  createDraft: vi.fn(),
  reviewGrowth: vi.fn(),
  generateBaskets: vi.fn(),
  reviewBasket: vi.fn(),
  approve: vi.fn(),
  sandbox: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/server/routers/pharmacy-marketing', () => ({
  pharmacyMarketingRouter: { createCaller: () => mocks },
}));
import { marketingAction } from './actions';
function form(values: Record<string, string>) {
  const data = new FormData();
  Object.entries({ branchId: 'branch-a', ...values }).forEach(([key, value]) =>
    data.set(key, value)
  );
  return data;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue({});
});
it('passes configurable basket thresholds without accepting client evidence', async () => {
  mocks.generateBaskets.mockResolvedValue({ id: 'analysis-a', count: 1 });
  expect(
    await marketingAction(
      form({
        operation: 'basket-generate',
        from: '2026-10-01',
        cutoff: '2026-10-03',
        minimumPairCount: '2',
        minimumSupport: '0.3',
        minimumConfidence: '0.5',
        minimumLift: '1',
        maximumProposals: '3',
        productIds: 'forged',
      })
    )
  ).toMatchObject({ error: false });
  expect(mocks.generateBaskets).toHaveBeenCalledWith({
    branchId: 'branch-a',
    from: new Date('2026-10-01'),
    cutoff: new Date('2026-10-03'),
    config: {
      minimumPairCount: 2,
      minimumSupport: 0.3,
      minimumConfidence: 0.5,
      minimumLift: 1,
      maximumProposals: 3,
    },
  });
});
it('requires explicit bundle review and surfaces PIN refusal without navigating to a campaign', async () => {
  expect(
    await marketingAction(form({ operation: 'basket-review', decision: 'APPROVE' }))
  ).toMatchObject({ error: true });
  expect(mocks.reviewBasket).not.toHaveBeenCalled();
  mocks.reviewBasket.mockResolvedValue({ blocked: 'Enter your current owner PIN.' });
  const result = await marketingAction(
    form({
      operation: 'basket-review',
      reviewed: 'on',
      decision: 'APPROVE',
      insightId: 'i1',
      recommendation: '0',
      pin: '1234',
      scheduledAt: '2026-11-02T12:00:00Z',
    })
  );
  expect(result).toEqual({ error: true, message: 'Enter your current owner PIN.' });
  expect(mocks.reviewBasket).toHaveBeenCalledWith({
    branchId: 'branch-a',
    insightId: 'i1',
    recommendation: 0,
    decision: 'APPROVE',
    pinCredential: '1234',
    scheduledAt: new Date('2026-11-02T12:00:00Z'),
  });
});
it('returns the saved manual draft for navigation with bounded retail settings', async () => {
  mocks.createDraft.mockResolvedValue({ id: 'saved-draft' });
  const result = await marketingAction(
    form({
      operation: 'draft',
      field: 'receiptCount',
      name: 'Generic outreach',
      templateId: 'template-a',
      scheduledAt: '2026-10-10T12:00:00Z',
      threshold: '1',
      quietStart: '22',
      quietEnd: '8',
      cap: '1',
      window: '7',
    })
  );
  expect(result).toMatchObject({ error: false, campaignId: 'saved-draft' });
  expect(mocks.createDraft).toHaveBeenCalledWith(
    expect.objectContaining({
      branchId: 'branch-a',
      promotesRegulatedItem: false,
      definition: { version: 1, all: [{ field: 'receiptCount', operator: 'gte', value: 1 }] },
      quietHours: { startHour: 22, endHour: 8 },
      frequencyCap: { max: 1, windowDays: 7 },
    })
  );
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(mocks.revalidate).toHaveBeenCalledWith('/pharmacy/marketing');
});
it('does not forward unsupported targeting fields', async () => {
  expect(await marketingAction(form({ operation: 'draft', field: 'medicine' }))).toMatchObject({
    error: true,
  });
  expect(mocks.createDraft).not.toHaveBeenCalled();
});
it('requires explicit campaign approval confirmation', async () => {
  expect(await marketingAction(form({ operation: 'approve', campaignId: 'c1' }))).toMatchObject({
    error: true,
  });
  expect(mocks.approve).not.toHaveBeenCalled();
});
it('forwards the owner PIN for voucher approval after explicit review', async () => {
  mocks.approve.mockResolvedValue({ status: 'APPROVED' });
  expect(
    await marketingAction(form({
      operation: 'approve',
      campaignId: 'c1',
      reviewed: 'on',
      pin: '4821',
    }))
  ).toMatchObject({ error: false });
  expect(mocks.approve).toHaveBeenCalledWith({ branchId: 'branch-a', campaignId: 'c1', pin: '4821' });
});
it('passes only insight reference and editable draft settings for server-bound review', async () => {
  mocks.reviewGrowth.mockResolvedValue({ decision: 'APPROVE', campaignId: 'from-insight' });
  const result = await marketingAction(
    form({
      operation: 'growth-review',
      reviewed: 'on',
      decision: 'APPROVE',
      insightId: 'i1',
      recommendation: '0',
      name: 'Generic',
      templateId: 't1',
      scheduledAt: '2026-10-10T12:00:00Z',
      actionRef: 'forged',
      field: 'medicine',
    })
  );
  expect(result.campaignId).toBe('from-insight');
  expect(mocks.reviewGrowth).toHaveBeenCalledWith({
    branchId: 'branch-a',
    insightId: 'i1',
    recommendation: 0,
    decision: 'APPROVE',
    edit: { name: 'Generic', templateId: 't1', scheduledAt: new Date('2026-10-10T12:00:00Z') },
  });
  expect(mocks.approve).not.toHaveBeenCalled();
});
it('preserves sandbox replay key and retry intent without any live provider choice', async () => {
  mocks.sandbox.mockResolvedValue({
    attempted: 1,
    accepted: 0,
    delivered: 0,
    failed: 1,
    unknown: 0,
    suppressed: 0,
  });
  const result = await marketingAction(
    form({
      operation: 'sandbox',
      campaignId: 'c1',
      requestKey: 'replay-key',
      retry: 'on',
      outcome: 'REJECTED',
      provider: 'meta',
    })
  );
  expect(mocks.sandbox).toHaveBeenCalledWith({
    branchId: 'branch-a',
    campaignId: 'c1',
    requestKey: 'replay-key',
    retry: true,
    outcome: 'REJECTED',
  });
  expect(result.message).toContain('No live messages sent');
});
