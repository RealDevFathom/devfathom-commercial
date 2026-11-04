/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tool, type ToolSet } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { z } from 'zod';

/**
 * DEV-576 assistant-turn guards, end to end through the real `streamText` with a
 * scripted model: number grounding, the dosing guard, the per-turn tool-call limit,
 * SDK retries off, the turn abort signal and the quick-lookup tier.
 */

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  entitlements: vi.fn(),
  model: vi.fn(),
  findOrganization: vi.fn(),
  tools: vi.fn(),
  stream: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: () => ({ organization: { findUnique: mocks.findOrganization } }),
}));
vi.mock('@/lib/entitlements', () => ({ resolveOrganizationEntitlements: mocks.entitlements }));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  createAIModel: mocks.model,
}));
vi.mock('@/lib/ai/tools', () => ({
  buildAssistantTools: mocks.tools,
  assistantToolChoice: () => 'auto',
}));
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  mocks.stream.mockImplementation(actual.streamText);
  return { ...actual, streamText: mocks.stream };
});

import { clearRateLimit } from '@/lib/rate-limit';
import { assistantRateKeys } from '@/lib/ai/assistant-request';
import { DOSING_REJECTED_TEXT, GROUNDING_REJECTED_TEXT } from '@/lib/ai/grounding';
import { TOOL_CALL_LIMIT_MESSAGE } from '@/lib/ai/tool-call-limit';
import { POST } from './route';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const finish = (reason: 'stop' | 'tool-calls'): LanguageModelV3StreamPart => ({
  type: 'finish',
  finishReason: { unified: reason, raw: undefined },
  usage,
});
const textStep = (text: string): LanguageModelV3StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 'txt' },
  { type: 'text-delta', id: 'txt', delta: text.slice(0, 7) },
  { type: 'text-delta', id: 'txt', delta: text.slice(7) },
  { type: 'text-end', id: 'txt' },
  finish('stop'),
];
const toolStep = (toolName: string, count = 1): LanguageModelV3StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  ...Array.from({ length: count }, (_, index) => ({
    type: 'tool-call' as const,
    toolCallId: `call-${index + 1}`,
    toolName,
    input: '{}',
  })),
  finish('tool-calls'),
];

function scriptedModel(steps: LanguageModelV3StreamPart[][]) {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: convertArrayToReadableStream(steps[call++] ?? textStep('')) }),
  });
}

const salesClaims = {
  kind: 'answer',
  period: { from: '2026-11-01', to: '2026-11-01' },
  claims: [
    { metricKey: 'salesMinor', label: 'Sales', value: 12_345_600 },
    { metricKey: 'openStockSignals', label: 'Open stock signals', value: 17 },
  ],
};
const reportTool = vi.fn(async () => salesClaims);
function guardTools(): ToolSet {
  return {
    askPharmacyReports: tool({
      description: 'Pharmacy report claims.',
      inputSchema: z.object({}),
      execute: reportTool,
    }),
  };
}

function request(text: string, signal?: AbortSignal) {
  return new Request('http://test.invalid/api/assistant', {
    method: 'POST',
    body: JSON.stringify({
      messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text }] }],
    }),
    headers: { 'Content-Type': 'application/json' },
    signal,
  });
}

async function streamedText(response: Response) {
  const body = await response.text();
  let text = '';
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const part = JSON.parse(line.slice(6)) as { type: string; delta?: string };
    if (part.type === 'text-delta') text += part.delta ?? '';
  }
  return { text, body };
}

beforeEach(async () => {
  vi.stubEnv('AI_PROVIDER', 'google');
  vi.stubEnv('AI_MODEL', 'inert-model');
  vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'inert-test-key');
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const [userKey, orgKey] = assistantRateKeys('server-user', 'server-org');
  await clearRateLimit(userKey);
  await clearRateLimit(orgKey);
  mocks.actor.mockResolvedValue({
    organization: { id: 'server-org' },
    session: { user: { id: 'server-user', role: 'ADMIN' } },
  });
  mocks.entitlements.mockResolvedValue({ vertical: 'PHARMACY', enabledModules: ['chat'] });
  mocks.findOrganization.mockResolvedValue({ id: 'server-org', askFathomEnabled: true });
  mocks.tools.mockImplementation(guardTools);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function scriptModel(steps: LanguageModelV3StreamPart[][]) {
  const model = scriptedModel(steps);
  mocks.model.mockReturnValue({ model, providerOptions: {} });
  return model;
}

describe('assistant turn guards', () => {
  it('shows an answer whose figures all come from the tool result', async () => {
    scriptModel([
      toolStep('askPharmacyReports'),
      textStep("Today's sales were Rs 123,456 with 17 open stock signals."),
    ]);
    const { text } = await streamedText(await POST(request('What were sales today?')));
    expect(text).toBe("Today's sales were Rs 123,456 with 17 open stock signals.");
    expect(reportTool).toHaveBeenCalledOnce();
    expect(console.error).not.toHaveBeenCalledWith(
      'ASSISTANT_GROUNDING_REJECTED',
      expect.anything()
    );
  });

  it('withholds an answer with an invented figure and logs counts only', async () => {
    scriptModel([
      toolStep('askPharmacyReports'),
      textStep('Sales were Rs 150,000, up 12% on last week.'),
    ]);
    const { text, body } = await streamedText(await POST(request('What were sales today?')));
    expect(text).toBe(GROUNDING_REJECTED_TEXT);
    expect(body).not.toContain('150,000');
    expect(console.error).toHaveBeenCalledWith('ASSISTANT_GROUNDING_REJECTED', {
      figures: 2,
      unmatched: 2,
      evidence: expect.any(Number),
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('150');
  });

  it('accepts figures the user typed', async () => {
    scriptModel([textStep('A target of Rs 75,000 for the week is noted.')]);
    const { text } = await streamedText(
      await POST(request('Note a target of Rs 75,000 for this week'))
    );
    expect(text).toBe('A target of Rs 75,000 for the week is noted.');
  });

  it('replaces dosing instructions in any vertical', async () => {
    mocks.entitlements.mockResolvedValue({ vertical: 'RESTAURANT', enabledModules: ['chat'] });
    scriptModel([textStep('Give one tablet twice a day after meals.')]);
    const { text, body } = await streamedText(await POST(request('How should my child take it?')));
    expect(text).toBe(DOSING_REJECTED_TEXT);
    expect(body).not.toContain('twice a day');
    expect(console.error).toHaveBeenCalledWith('ASSISTANT_DOSING_REJECTED', expect.any(Object));
  });

  it('refuses the 7th tool call in a turn without running it', async () => {
    scriptModel([toolStep('askPharmacyReports', 7), textStep('Done.')]);
    const { body } = await streamedText(await POST(request('What were sales today?')));
    expect(reportTool).toHaveBeenCalledTimes(6);
    expect(body).toContain(TOOL_CALL_LIMIT_MESSAGE);
    expect(body.split(TOOL_CALL_LIMIT_MESSAGE)).toHaveLength(2);
  });

  it('stops after the turn model-call limit', async () => {
    const model = scriptModel(Array.from({ length: 6 }, () => toolStep('askPharmacyReports')));
    await streamedText(await POST(request('What were sales today?')));
    expect(model.doStreamCalls).toHaveLength(4);
  });

  it('passes SDK retries off, the turn abort signal, the budget and the tier', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    scriptModel([textStep('Hello.')]);
    const controller = new AbortController();
    const response = await POST(request('What were sales today?', controller.signal));
    await streamedText(response);
    const args = mocks.stream.mock.calls[0]![0];
    expect(args.maxRetries).toBe(0);
    expect(timeout).toHaveBeenCalledWith(90_000);
    expect(args.abortSignal).toBeInstanceOf(AbortSignal);
    expect(args.abortSignal.aborted).toBe(false);
    controller.abort();
    expect(args.abortSignal.aborted).toBe(true);
    expect(mocks.model).toHaveBeenCalledWith(process.env, {
      feature: 'ask-fathom',
      organizationId: 'server-org',
      tier: 'cheap',
      turn: expect.objectContaining({ maxModelCalls: 4, modelCalls: 0 }),
    });
  });

  it('keeps the standard tier for analysis and write requests', async () => {
    for (const question of [
      'Why did sales drop this week?',
      'Create a reorder note for the supplier',
    ]) {
      scriptModel([textStep('Okay.')]);
      await streamedText(await POST(request(question)));
      expect(mocks.model).toHaveBeenLastCalledWith(
        process.env,
        expect.objectContaining({ tier: 'standard' })
      );
    }
  });
});
