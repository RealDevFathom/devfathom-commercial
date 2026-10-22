import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), route: vi.fn() }));
vi.mock('ai', () => ({ generateText: mocks.generate }));
vi.mock('@/lib/ai/router', () => ({ routeAI: mocks.route }));

import {
  __resetOwnerInsightsCache,
  buildOwnerInsights,
  ownerInsightsPrompt,
} from './owner-insights';

const aggregates = {
  dailyRevenueMinor: 12000,
  grossMarginMinor: 3000,
  nearExpiryStockValueMinor: 800,
  churnRiskCount: 4,
};

describe('pharmacy owner insights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetOwnerInsightsCache();
    mocks.route.mockImplementation(async (options) =>
      options.execute({ model: {}, provider: 'anthropic', modelId: 'standard-model' })
    );
    mocks.generate.mockResolvedValue({ text: '{"tips":["Review expiring stock."]}', usage: {} });
  });

  it('sends aggregate fields only and never PII', async () => {
    await buildOwnerInsights({ organizationId: 'org-a', day: '2026-10-22', aggregates, aiEnabled: true });
    const prompt = mocks.generate.mock.calls[0][0].prompt;
    expect(prompt).toBe(ownerInsightsPrompt(aggregates));
    expect(prompt).not.toMatch(/name|email|phone|patientId|customerId/i);
  });

  it('does not call a model when AI is off', async () => {
    const result = await buildOwnerInsights({ organizationId: 'org-a', day: '2026-10-22', aggregates, aiEnabled: false });
    expect(mocks.route).not.toHaveBeenCalled();
    expect(result.tips).toEqual([]);
  });

  it('isolates the daily cache by organization', async () => {
    await buildOwnerInsights({ organizationId: 'org-a', day: '2026-10-22', aggregates, aiEnabled: true });
    await buildOwnerInsights({ organizationId: 'org-b', day: '2026-10-22', aggregates: { ...aggregates, churnRiskCount: 99 }, aiEnabled: true });
    expect(mocks.route).toHaveBeenCalledTimes(2);
  });
});
