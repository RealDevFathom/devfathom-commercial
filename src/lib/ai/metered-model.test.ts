/** @vitest-environment node */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convertToModelMessages, generateText, streamText, Output } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { DEFAULT_AI_MODELS } from './model-defaults';
import type { AIModelSelection } from './provider';

const mocks = vi.hoisted(() => ({
  platform: vi.fn(),
  tenant: vi.fn(),
  factory: vi.fn(),
  config: vi.fn(),
  availability: vi.fn(),
  prices: vi.fn(),
  aggregate: vi.fn(),
  create: vi.fn(),
  tenantCreate: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: mocks.platform,
  withTenantDb: mocks.tenant,
}));
vi.mock('./provider', () => ({
  createAIModel: mocks.factory,
  readAIConfig: mocks.config,
  readAIAvailability: mocks.availability,
}));

import { prepareAIModel } from './metered-model';
import { routeAI } from './router';
import { generateGrowthRecommendations } from './growth-recommendations';

const usage = {
  inputTokens: { total: 1_000_000, noCache: 1_000_000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1_000_000, text: 1_000_000, reasoning: 0 },
};
function selection(provider: 'anthropic' | 'bedrock' = 'anthropic'): AIModelSelection {
  return {
    provider,
    modelId: DEFAULT_AI_MODELS[provider].cheap,
    model: new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: 'text', text: 'paid output' }],
        finishReason: { unified: 'stop', raw: 'end_turn' },
        usage,
        warnings: [],
      },
      doStream: {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'paid output' },
          { type: 'text-end', id: 'text-1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
        ]),
      },
    }),
  };
}

let journalDirectory: string;
beforeEach(async () => {
  vi.resetAllMocks();
  journalDirectory = await mkdtemp(join(tmpdir(), 'ai-metering-'));
  vi.stubEnv('AI_USAGE_JOURNAL_DIR', journalDirectory);
  vi.stubEnv('AI_ANTHROPIC_MONTHLY_BUDGET_USD', '10');
  mocks.platform.mockImplementation(async (run) =>
    run({
      aIModelPrice: { findFirst: mocks.prices },
      aIUsageLedger: { aggregate: mocks.aggregate, createMany: mocks.create },
    })
  );
  mocks.tenant.mockImplementation(async (_org, run) =>
    run({ aIUsage: { create: mocks.tenantCreate } })
  );
  mocks.aggregate.mockResolvedValue({ _sum: { costUsd: new Prisma.Decimal('0') } });
  mocks.prices.mockImplementation(async ({ where }) => ({
    provider: where.provider,
    model: where.model,
    inputUsdPerMillionTokens: new Prisma.Decimal('1'),
    outputUsdPerMillionTokens: new Prisma.Decimal('5'),
    effectiveFrom: new Date('2026-01-01'),
  }));
  mocks.factory.mockImplementation((env) => selection(env?.AI_PROVIDER ?? 'anthropic'));
  mocks.availability.mockReturnValue({ available: true, provider: 'anthropic' });
  mocks.config.mockReturnValue({ provider: 'anthropic', model: DEFAULT_AI_MODELS.anthropic.cheap });
});
afterEach(async () => {
  await rm(journalDirectory, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('production Claude routing and metering', () => {
  it('records exact spend and preserves tenant attribution through routeAI', async () => {
    const result = await routeAI({
      organizationId: 'org-a',
      branchId: 'branch-a',
      feature: 'marketing',
      prompt: 'safe',
    });
    expect(result.text).toBe('paid output');
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        id: expect.any(String),
        provider: 'anthropic',
        model: DEFAULT_AI_MODELS.anthropic.cheap,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        costUsd: new Prisma.Decimal(6),
        occurredAt: expect.any(Date),
      },
      skipDuplicates: true,
    });
    expect(mocks.tenantCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-a',
        branchId: 'branch-a',
        feature: 'marketing',
      }),
    });
  });

  it('switches to the equivalent Bedrock model once persisted spend reaches budget', async () => {
    mocks.aggregate.mockResolvedValue({ _sum: { costUsd: new Prisma.Decimal('10') } });
    const prepared = await prepareAIModel(selection());
    expect(prepared).toMatchObject({
      provider: 'bedrock',
      modelId: DEFAULT_AI_MODELS.bedrock.cheap,
    });
    expect(mocks.factory).toHaveBeenCalledWith(
      expect.objectContaining({
        AI_PROVIDER: 'bedrock',
        AI_BEDROCK_MODEL: DEFAULT_AI_MODELS.bedrock.cheap,
      })
    );
    await generateText({ model: prepared.model, prompt: 'safe' });
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider: 'bedrock',
        model: DEFAULT_AI_MODELS.bedrock.cheap,
      }),
      skipDuplicates: true,
    });
  });

  it('meters streamed output before completing the stream', async () => {
    const prepared = await prepareAIModel(selection('bedrock'));
    const result = streamText({ model: prepared.model, prompt: 'safe' });
    await expect(result.text).resolves.toBe('paid output');
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.aggregate).not.toHaveBeenCalled();
  });

  it('counts each paid response even when structured output validation rejects it', async () => {
    const prepared = await prepareAIModel(selection());
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        generateText({
          model: prepared.model,
          prompt: 'safe',
          output: Output.object({ schema: z.object({ allowed: z.boolean() }) }),
        })
      ).rejects.toThrow('could not parse the response');
    }
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it.each(['generate', 'stream'] as const)(
    'rechecks persisted spend before a reused model can %s again',
    async (mode) => {
      const anthropic = selection();
      const bedrock = selection('bedrock');
      mocks.factory.mockReturnValue(bedrock);
      mocks.create.mockImplementation(async ({ data }) => {
        if (data.provider === 'anthropic')
          mocks.aggregate.mockResolvedValue({ _sum: { costUsd: new Prisma.Decimal('10') } });
      });
      const prepared = await prepareAIModel(anthropic);
      const run = () =>
        mode === 'generate'
          ? generateText({ model: prepared.model, prompt: 'safe', maxRetries: 0 }).then(
              (result) => result.text
            )
          : streamText({ model: prepared.model, prompt: 'safe', maxRetries: 0 }).text;
      expect(await run()).toBe('paid output');
      expect(await run()).toBe('paid output');
      expect(mocks.create.mock.calls.map(([arg]) => arg.data.provider)).toEqual([
        'anthropic',
        'bedrock',
      ]);
      expect(prepared).toMatchObject({
        provider: 'bedrock',
        modelId: DEFAULT_AI_MODELS.bedrock.cheap,
      });
      for (const selected of [anthropic, bedrock]) {
        const model = selected.model as MockLanguageModelV3;
        expect(mode === 'generate' ? model.doGenerateCalls : model.doStreamCalls).toHaveLength(1);
      }
    }
  );

  it('uses each invocation month and effective price when a model crosses UTC rollover', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const before = new Date('2026-09-30T23:59:59Z');
    const after = new Date('2026-10-01T00:00:01Z');
    vi.setSystemTime(before);
    mocks.aggregate.mockImplementation(async ({ where }) => ({
      _sum: {
        costUsd: new Prisma.Decimal(where.occurredAt.gte.getUTCMonth() === 8 ? '10' : '0'),
      },
    }));
    mocks.prices.mockImplementation(async ({ where }) => ({
      provider: where.provider,
      model: where.model,
      inputUsdPerMillionTokens: new Prisma.Decimal(where.effectiveFrom.lte < after ? '1' : '2'),
      outputUsdPerMillionTokens: new Prisma.Decimal('5'),
      effectiveFrom: where.effectiveFrom.lte,
    }));
    const prepared = await prepareAIModel(selection());
    await generateText({ model: prepared.model, prompt: 'safe' });
    vi.setSystemTime(after);
    await generateText({ model: prepared.model, prompt: 'safe' });
    expect(mocks.create.mock.calls.map(([arg]) => arg.data)).toEqual([
      expect.objectContaining({
        provider: 'bedrock',
        occurredAt: before,
        costUsd: new Prisma.Decimal(6),
      }),
      expect.objectContaining({
        provider: 'anthropic',
        occurredAt: after,
        costUsd: new Prisma.Decimal(7),
      }),
    ]);
    expect(mocks.aggregate).toHaveBeenLastCalledWith({
      where: {
        provider: 'anthropic',
        occurredAt: {
          gte: new Date('2026-10-01T00:00:00Z'),
          lt: new Date('2026-11-01T00:00:00Z'),
        },
      },
      _sum: { costUsd: true },
    });
  });

  it.each(['generate', 'stream'] as const)(
    'rejects cache controls on every SDK option surface before %s purchases output',
    async (mode) => {
      type Params = Parameters<MockLanguageModelV3['doGenerate']>[0];
      const options: NonNullable<Params['providerOptions']>[] = [
        { anthropic: { cacheControl: { type: 'ephemeral', ttl: '5m' } } },
        { anthropic: { cache_control: { type: 'ephemeral', ttl: '1h' } } },
        { bedrock: { cachePoint: { type: 'default' } } },
      ];
      for (const provider of ['anthropic', 'bedrock'] as const) {
        const selected = selection(provider);
        const prepared = await prepareAIModel(selected);
        const model = prepared.model as MockLanguageModelV3;
        for (const providerOptions of options) {
          const calls: Params[] = [
            { prompt: [], providerOptions },
            { prompt: [{ role: 'system', content: 'safe', providerOptions }] },
            {
              prompt: [{ role: 'user', content: [{ type: 'text', text: 'safe' }], providerOptions }],
            },
            {
              prompt: [{ role: 'user', content: [{ type: 'text', text: 'safe', providerOptions }] }],
            },
            {
              prompt: [],
              tools: [{ type: 'function', name: 'safe', inputSchema: {}, providerOptions }],
            },
            {
              prompt: [
                {
                  role: 'tool',
                  content: [
                    {
                      type: 'tool-result',
                      toolCallId: 'call-1',
                      toolName: 'safe',
                      output: { type: 'text', value: 'safe', providerOptions },
                    },
                  ],
                },
              ],
            },
            {
              prompt: [
                {
                  role: 'tool',
                  content: [
                    {
                      type: 'tool-result',
                      toolCallId: 'call-1',
                      toolName: 'safe',
                      output: {
                        type: 'content',
                        value: [{ type: 'text', text: 'safe', providerOptions }],
                      },
                    },
                  ],
                },
              ],
            },
          ];
          for (const params of calls)
            await expect(
              mode === 'generate' ? model.doGenerate(params) : model.doStream(params)
            ).rejects.toThrow('AI prompt caching requires cache-specific ledger prices');
        }
        const original = selected.model as MockLanguageModelV3;
        expect(original.doGenerateCalls).toHaveLength(0);
        expect(original.doStreamCalls).toHaveLength(0);
      }
      expect(mocks.create).not.toHaveBeenCalled();
    }
  );

  it('rejects assistant text-part cache metadata after UI message conversion', async () => {
    const selected = selection();
    const prepared = await prepareAIModel(selected);
    const messages = await convertToModelMessages([
      {
        role: 'user',
        parts: [
          {
            type: 'text',
            text: 'safe',
            providerMetadata: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } },
          },
        ],
      },
    ]);
    await expect(
      generateText({ model: prepared.model, messages, maxRetries: 0 })
    ).rejects.toThrow('AI prompt caching requires cache-specific ledger prices');
    expect((selected.model as MockLanguageModelV3).doGenerateCalls).toHaveLength(0);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('routes growth generation and meters both paid repair attempts', async () => {
    mocks.aggregate.mockResolvedValue({ _sum: { costUsd: new Prisma.Decimal('10') } });
    const result = await generateGrowthRecommendations({
      vertical: 'RESTAURANT',
      currency: 'PKR',
      current: { from: '2026-09-01T00:00:00Z', cutoff: '2026-10-01T00:00:00Z' },
      comparison: { from: '2026-08-01T00:00:00Z', cutoff: '2026-09-01T00:00:00Z' },
      facts: [
        {
          ref: 'e1',
          metric: 'receipt_count',
          value: '20',
          period: 'CURRENT',
          cohortSize: 10,
          coverage: 'COMPLETE',
          freshAt: '2026-10-01T00:00:00Z',
        },
      ],
      actions: [{ ref: 'a1', kind: 'RETAIL_REVIEW' }],
    });
    expect(result).toMatchObject({
      status: 'INVALID',
      failureCode: 'OUTPUT',
      provider: 'bedrock',
      model: DEFAULT_AI_MODELS.bedrock.cheap,
    });
    expect(mocks.create).toHaveBeenCalledTimes(2);
    for (const [arg] of mocks.create.mock.calls)
      expect(arg.data).toMatchObject({ provider: 'bedrock', costUsd: new Prisma.Decimal(6) });
  });

  it('attributes a growth repair to Bedrock when the first attempt reaches budget', async () => {
    mocks.create.mockImplementation(async ({ data }) => {
      if (data.provider === 'anthropic')
        mocks.aggregate.mockResolvedValue({ _sum: { costUsd: new Prisma.Decimal('10') } });
    });
    const result = await generateGrowthRecommendations({
      vertical: 'RESTAURANT',
      currency: 'PKR',
      current: { from: '2026-09-01T00:00:00Z', cutoff: '2026-10-01T00:00:00Z' },
      comparison: { from: '2026-08-01T00:00:00Z', cutoff: '2026-09-01T00:00:00Z' },
      facts: [
        {
          ref: 'e1',
          metric: 'receipt_count',
          value: '20',
          period: 'CURRENT',
          cohortSize: 10,
          coverage: 'COMPLETE',
          freshAt: '2026-10-01T00:00:00Z',
        },
      ],
      actions: [{ ref: 'a1', kind: 'RETAIL_REVIEW' }],
    });
    expect(result).toMatchObject({
      status: 'INVALID',
      failureCode: 'OUTPUT',
      provider: 'bedrock',
      model: DEFAULT_AI_MODELS.bedrock.cheap,
    });
    expect(mocks.create.mock.calls.map(([arg]) => arg.data.provider)).toEqual([
      'anthropic',
      'bedrock',
    ]);
  });

  it('rejects an unpriced model before any provider call', async () => {
    mocks.prices.mockResolvedValue(null);
    const selected = selection();
    await expect(prepareAIModel(selected)).rejects.toThrow('No effective AI model price');
    expect((selected.model as MockLanguageModelV3).doGenerateCalls).toHaveLength(0);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rechecks the effective price immediately before purchasing output', async () => {
    const selected = selection();
    const prepared = await prepareAIModel(selected);
    mocks.prices.mockResolvedValue(null);
    await expect(
      generateText({ model: prepared.model, prompt: 'safe', maxRetries: 0 })
    ).rejects.toThrow('No effective AI model price');
    expect((selected.model as MockLanguageModelV3).doGenerateCalls).toHaveLength(0);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(['', '-1', 'NaN', 'Infinity'])(
    'rejects invalid budget %s before generation',
    async (budget) => {
      await expect(
        prepareAIModel(selection(), { AI_ANTHROPIC_MONTHLY_BUDGET_USD: budget })
      ).rejects.toThrow();
      expect(mocks.aggregate).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
    }
  );

  it('does not buy output twice when ledger persistence fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.create.mockRejectedValue(new Error('private database detail'));
    const selected = selection();
    const prepared = await prepareAIModel(selected);
    await expect(generateText({ model: prepared.model, prompt: 'safe' })).resolves.toMatchObject({
      text: 'paid output',
    });
    expect((selected.model as MockLanguageModelV3).doGenerateCalls).toHaveLength(1);
    const files = await readdir(journalDirectory);
    expect(files).toHaveLength(1);
    const recovery = JSON.parse(await readFile(join(journalDirectory, files[0]), 'utf8'));
    expect(recovery).toEqual({
      id: expect.any(String),
      provider: 'anthropic',
      model: DEFAULT_AI_MODELS.anthropic.cheap,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      costUsd: '6.000000',
      occurredAt: expect.any(String),
    });
    expect(log).toHaveBeenCalledExactlyOnceWith('AI_USAGE_PERSIST_FAILED', expect.any(String));
    expect(JSON.parse(log.mock.calls[0][1])).toMatchObject({ id: recovery.id });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private database detail');
    expect(JSON.stringify(log.mock.calls)).not.toContain('paid output');
  });

  it.each(['generate', 'stream'] as const)(
    'reconciles failed %s writes before routing a fresh model at the recovered budget',
    async (mode) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mocks.create.mockRejectedValueOnce(new Error('transaction timed out'));
      const prepared = await prepareAIModel(selection());
      if (mode === 'generate')
        await expect(
          generateText({ model: prepared.model, prompt: 'safe' })
        ).resolves.toMatchObject({ text: 'paid output' });
      else
        await expect(streamText({ model: prepared.model, prompt: 'safe' }).text).resolves.toBe(
          'paid output'
        );
      const failedData = mocks.create.mock.calls[0][0].data;
      expect(await readdir(journalDirectory)).toEqual([`${failedData.id}.json`]);

      // Simulate a later request or worker; recovery must not depend on the old wrapper.
      mocks.create.mockImplementation(async () => {
        mocks.aggregate.mockResolvedValue({ _sum: { costUsd: new Prisma.Decimal('10') } });
      });
      const recovered = await prepareAIModel(selection());
      expect(recovered.provider).toBe('bedrock');
      expect(mocks.create.mock.calls[1][0]).toEqual({ data: failedData, skipDuplicates: true });
      expect(await readdir(journalDirectory)).toEqual([]);
    }
  );

  it('stops a new purchase while a pending ledger write cannot be reconciled', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.create.mockRejectedValue(new Error('transaction timed out'));
    const selected = selection();
    const prepared = await prepareAIModel(selected);
    await generateText({ model: prepared.model, prompt: 'safe' });
    await expect(
      generateText({ model: prepared.model, prompt: 'safe', maxRetries: 0 })
    ).rejects.toThrow('transaction timed out');
    expect((selected.model as MockLanguageModelV3).doGenerateCalls).toHaveLength(1);
    expect(await readdir(journalDirectory)).toHaveLength(1);
  });

  it('fails before purchase without persistent journal configuration', async () => {
    vi.stubEnv('AI_USAGE_JOURNAL_DIR', '');
    const selected = selection();
    await expect(prepareAIModel(selected)).rejects.toThrow('AI_USAGE_JOURNAL_DIR');
    expect((selected.model as MockLanguageModelV3).doGenerateCalls).toHaveLength(0);
  });
});
