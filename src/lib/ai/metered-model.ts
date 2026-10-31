import 'server-only';

import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import { Prisma } from '@/generated/prisma/client';
import { DEFAULT_AI_MODELS, defaultAIModel, type AIModelClass } from './model-defaults';
import { createAIModel, type AIModelSelection } from './provider';
import { routeAIProvider } from './router';
import { recordPricedAIUsage, UnknownAIModelPriceError } from './spend';

/** Apply routing and accounting to every SDK call, including repairs and stream steps. */
export async function prepareAIModel(
  selection: AIModelSelection,
  env: Record<string, string | undefined> = process.env
): Promise<AIModelSelection> {
  if (selection.provider !== 'anthropic' && selection.provider !== 'bedrock') return selection;

  const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
  const occurredAt = new Date();
  if (selection.provider === 'anthropic') {
    const configuredBudget = env.AI_ANTHROPIC_MONTHLY_BUDGET_USD?.trim();
    if (!configuredBudget) throw new Error('AI_ANTHROPIC_MONTHLY_BUDGET_USD is required.');
    const budget = new Prisma.Decimal(configuredBudget);
    if (!budget.isFinite() || budget.isNegative()) throw new Error('Invalid Anthropic budget.');
    const provider = await withPlatformDb((db) =>
      routeAIProvider({
        ledger: db.aIUsageLedger,
        monthlyAnthropicBudgetUsd: budget,
        at: occurredAt,
      })
    );
    if (provider === 'bedrock') {
      const modelClass = Object.entries(DEFAULT_AI_MODELS.anthropic).find(
        ([, model]) => model === selection.modelId
      )?.[0] as AIModelClass | undefined;
      const model =
        env.AI_BEDROCK_MODEL?.trim() ||
        (modelClass ? defaultAIModel('bedrock', modelClass) : undefined);
      if (!model) throw new Error('AI_BEDROCK_MODEL is required for a custom Anthropic model.');
      selection = createAIModel({ ...env, AI_PROVIDER: 'bedrock', AI_BEDROCK_MODEL: model });
    }
  }

  const { provider, modelId, model } = selection;
  // Resolve the exact effective price before purchasing output; no provider-wide fallback.
  const price = await withPlatformDb((db) =>
    db.aIModelPrice.findFirst({
      where: { provider, model: modelId, effectiveFrom: { lte: occurredAt } },
      orderBy: { effectiveFrom: 'desc' },
    })
  );
  if (!price) throw new UnknownAIModelPriceError(provider, modelId);
  if (typeof model === 'string' || model.specificationVersion !== 'v3')
    throw new Error('Routed AI providers require a v3 SDK model.');

  type Usage = Awaited<ReturnType<typeof model.doGenerate>>['usage'];
  const record = async (usage: Usage) => {
    try {
      // Missing usage is an accounting failure, never a fabricated zero-cost call.
      const inputTokens = usage.inputTokens.total;
      const outputTokens = usage.outputTokens.total;
      if (inputTokens === undefined || outputTokens === undefined)
        throw new Error('AI provider did not report usage.');
      await withPlatformDb((db) =>
        recordPricedAIUsage({
          prices: db.aIModelPrice,
          ledger: db.aIUsageLedger,
          provider,
          model: modelId,
          inputTokens,
          outputTokens,
          occurredAt,
        })
      );
    } catch {
      // Preserve paid output on a telemetry outage instead of inducing a paid retry.
      console.error('AI_USAGE_PERSIST_FAILED');
    }
  };
  const middleware: LanguageModelMiddleware = {
    specificationVersion: 'v3',
    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate();
      await record(result.usage);
      return result;
    },
    async wrapStream({ doStream }) {
      const result = await doStream();
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            async transform(part, controller) {
              if (part.type === 'finish') await record(part.usage);
              controller.enqueue(part);
            },
          })
        ),
      };
    },
  };
  return { ...selection, model: wrapLanguageModel({ model, middleware }) };
}
