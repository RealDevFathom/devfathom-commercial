import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  revalidate: vi.fn(),
  createDraft: vi.fn(),
  generateGrowth: vi.fn(),
  attributeReceipts: vi.fn(),
  sandboxDue: vi.fn(),
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
const PKT = { timezone: 'Asia/Karachi' };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue({});
  // 17:00 in Karachi on 2 November 2026: 1 November is the latest day that has ended.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());
it('passes configurable basket thresholds without accepting client evidence', async () => {
  mocks.generateBaskets.mockResolvedValue({ id: 'analysis-a', count: 1 });
  expect(
    await marketingAction(
      form({
        operation: 'basket-generate',
        ...PKT,
        firstDay: '2026-10-01',
        lastDay: '2026-10-02',
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
    from: new Date('2026-09-30T19:00:00Z'),
    cutoff: new Date('2026-10-02T19:00:00Z'),
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
      ...PKT,
      scheduledAt: '2026-11-03T17:00',
    })
  );
  expect(result).toEqual({ error: true, message: 'Enter your current owner PIN.' });
  expect(mocks.reviewBasket).toHaveBeenCalledWith({
    branchId: 'branch-a',
    insightId: 'i1',
    recommendation: 0,
    decision: 'APPROVE',
    pinCredential: '1234',
    scheduledAt: new Date('2026-11-03T12:00:00Z'),
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
      ...PKT,
      scheduledAt: '2026-11-05T10:00',
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
      scheduledAt: new Date('2026-11-05T05:00:00Z'),
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
      ...PKT,
      scheduledAt: '2026-11-10T17:00',
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
    edit: { name: 'Generic', templateId: 't1', scheduledAt: new Date('2026-11-10T12:00:00Z') },
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

describe('plain local dates become the UTC period the server expects (DEV-591)', () => {
  it('sends 1-30 October in Karachi as UTC from and exclusive cutoff', async () => {
    mocks.generateGrowth.mockResolvedValue({ status: 'READY', failureCode: null });
    const result = await marketingAction(
      form({ operation: 'growth-generate', ...PKT, firstDay: '2026-10-01', lastDay: '2026-10-30' })
    );
    expect(result).toMatchObject({ error: false });
    expect(mocks.generateGrowth).toHaveBeenCalledWith({
      branchId: 'branch-a',
      from: new Date('2026-09-30T19:00:00.000Z'),
      cutoff: new Date('2026-10-30T19:00:00.000Z'),
    });
  });
  it('uses the same day boundaries for receipt attribution', async () => {
    mocks.attributeReceipts.mockResolvedValue({ created: 0, eligible: 0 });
    await marketingAction(
      form({ operation: 'attribution', ...PKT, firstDay: '2026-11-01', lastDay: '2026-11-01' })
    );
    expect(mocks.attributeReceipts).toHaveBeenCalledWith({
      branchId: 'branch-a',
      from: new Date('2026-10-31T19:00:00.000Z'),
      cutoff: new Date('2026-11-01T19:00:00.000Z'),
    });
  });
  it.each([
    [{ firstDay: '2026-10-10', lastDay: '2026-10-01' }, 'on or after the first day'],
    [{ firstDay: '2026-11-02', lastDay: '2026-11-02' }, 'must already be over'],
    [{ firstDay: '2026-01-01', lastDay: '2026-10-01' }, '90 days or fewer'],
  ])('explains an unusable period %j without calling the server', async (days, message) => {
    const result = await marketingAction(form({ operation: 'growth-generate', ...PKT, ...days }));
    expect(result.error).toBe(true);
    expect(result.message).toContain(message);
    expect(mocks.generateGrowth).not.toHaveBeenCalled();
  });
  it('explains an unavailable insight in plain words with the next step', async () => {
    mocks.generateGrowth.mockResolvedValue({ status: 'UNAVAILABLE', failureCode: 'CONFIGURATION' });
    const { message } = await marketingAction(
      form({ operation: 'growth-generate', ...PKT, firstDay: '2026-10-01', lastDay: '2026-10-30' })
    );
    expect(message).toContain('Contact DevFathom support to connect an AI provider');
    expect(message).not.toMatch(/UNAVAILABLE|CONFIGURATION|Insight status/);
  });
  it('rejects bad Advanced thresholds with a sentence, not a schema error', async () => {
    const result = await marketingAction(
      form({
        operation: 'basket-generate',
        ...PKT,
        firstDay: '2026-10-01',
        lastDay: '2026-10-02',
        minimumPairCount: '2',
        minimumSupport: '3',
        minimumConfidence: '0.5',
        minimumLift: '1',
        maximumProposals: '3',
      })
    );
    expect(result).toMatchObject({ error: true, message: expect.stringContaining('Advanced') });
    expect(mocks.generateBaskets).not.toHaveBeenCalled();
  });
  it('asks for a send time instead of sending an invalid date', async () => {
    const result = await marketingAction(
      form({ operation: 'draft', field: 'receiptCount', ...PKT, scheduledAt: '' })
    );
    expect(result).toEqual({ error: true, message: 'Choose a send date and time.' });
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });
  it('runs a due batch with the generated reference and asks for a campaign first', async () => {
    expect(
      await marketingAction(form({ operation: 'sandbox-due', requestKey: 'auto-key' }))
    ).toEqual({ error: true, message: 'Select one to five prepared campaigns.' });
    mocks.sandboxDue.mockResolvedValue({ results: [], hasMore: false });
    const data = form({ operation: 'sandbox-due', requestKey: 'auto-key' });
    data.append('campaignIds', 'c1');
    await marketingAction(data);
    expect(mocks.sandboxDue).toHaveBeenCalledWith({
      branchId: 'branch-a',
      requestKey: 'auto-key',
      campaignIds: ['c1'],
      outcome: 'DELIVERED',
    });
  });
});
