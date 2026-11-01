import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), model: vi.fn(), record: vi.fn() }));
vi.mock('ai', () => ({ generateText: mocks.generate }));
vi.mock('./provider', () => ({ createAIModel: mocks.model }));
vi.mock('./spend', () => ({ recordAIUsage: mocks.record }));

import { routeAI } from './router';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.model.mockReturnValue({
    model: 'provider-model',
    provider: 'google',
    modelId: 'gemini-test',
  });
  mocks.generate.mockResolvedValue({
    text: 'paid output',
    usage: { inputTokens: 12, outputTokens: 7 },
  });
});

it('records the server-derived organization and branch for a successful generation', async () => {
  await routeAI({
    organizationId: 'org-a',
    branchId: 'branch-a',
    feature: 'pharmacy.marketing-assistance',
    prompt: 'safe prompt',
  });

  expect(mocks.record).toHaveBeenCalledWith({
    organizationId: 'org-a',
    branchId: 'branch-a',
    feature: 'pharmacy.marketing-assistance',
    provider: 'google',
    model: 'gemini-test',
    inputTokens: 12,
    outputTokens: 7,
  });
});

it('returns paid output when usage telemetry fails instead of causing a paid retry', async () => {
  mocks.record.mockRejectedValue(new Error('usage database unavailable'));

  await expect(
    routeAI({
      organizationId: 'org-a',
      branchId: 'branch-a',
      feature: 'pharmacy.marketing-assistance',
      prompt: 'safe prompt',
    })
  ).resolves.toMatchObject({ text: 'paid output' });
  expect(mocks.generate).toHaveBeenCalledTimes(1);
});
