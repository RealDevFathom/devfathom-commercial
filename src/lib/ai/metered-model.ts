import 'server-only';

import { randomUUID } from 'node:crypto';
import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import { Prisma } from '@/generated/prisma/client';
import { DEFAULT_AI_MODELS, defaultAIModel, type AIModelClass } from './model-defaults';
import { createAIModel, type AIModelSelection } from './provider';
import { routeAIProvider } from './router';
import { calculateAIUsageCost, UnknownAIModelPriceError } from './spend';
import { createAIUsageJournal } from './usage-journal';

type CallOptions = Parameters<NonNullable<LanguageModelMiddleware['wrapGenerate']>>[0]['params'];

/** The ledger currently prices uncached input only. Reject every SDK cache entry point. */
function rejectCaching(params: CallOptions) {
  const check = (options: CallOptions['providerOptions']) => {
    if (
      options?.anthropic?.cacheControl != null ||
      options?.anthropic?.cache_control != null ||
      options?.bedrock?.cachePoint != null
    )
      throw new Error('AI prompt caching requires cache-specific ledger prices.');
  };
  check(params.providerOptions);
  for (const message of params.prompt) {
    check(message.providerOptions);
    if (typeof message.content === 'string') continue;
    for (const part of message.content) {
      check(part.providerOptions);
      if (part.type === 'tool-result') {
        if ('providerOptions' in part.output) check(part.output.providerOptions);
        if (part.output.type === 'content')
          for (const content of part.output.value) check(content.providerOptions);
      }
    }
  }
  for (const tool of params.tools ?? [])
    if (tool.type === 'function') check(tool.providerOptions);
}

/** Apply routing and accounting to every SDK call, including repairs and stream steps. */
export async function prepareAIModel(
  selection: AIModelSelection,
  env: Record<string, string | undefined> = process.env
): Promise<AIModelSelection> {
  if (selection.provider !== 'anthropic' && selection.provider !== 'bedrock') return selection;

  const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
  let budget: Prisma.Decimal | undefined;
  if (selection.provider === 'anthropic') {
    const configuredBudget = env.AI_ANTHROPIC_MONTHLY_BUDGET_USD?.trim();
    if (!configuredBudget) throw new Error('AI_ANTHROPIC_MONTHLY_BUDGET_USD is required.');
    budget = new Prisma.Decimal(configuredBudget);
    if (!budget.isFinite() || budget.isNegative()) throw new Error('Invalid Anthropic budget.');
  }
  const journal = await createAIUsageJournal(env, (record) =>
    withPlatformDb((db) =>
      db.aIUsageLedger.createMany({
        data: {
          ...record,
          costUsd: new Prisma.Decimal(record.costUsd),
          occurredAt: new Date(record.occurredAt),
        },
        skipDuplicates: true,
      })
    )
  );
  const resolveInvocation = async (occurredAt: Date) => {
    // Never make a budget decision from a ledger with known outstanding writes.
    // A failed replay stops a new purchase, while the original paid output survives.
    await journal.replay();
    let current = selection;
    if (budget !== undefined) {
      const monthlyAnthropicBudgetUsd = budget;
      const provider = await withPlatformDb((db) =>
        routeAIProvider({
          ledger: db.aIUsageLedger,
          monthlyAnthropicBudgetUsd,
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
        current = createAIModel({ ...env, AI_PROVIDER: 'bedrock', AI_BEDROCK_MODEL: model });
      }
    }

    const { provider, modelId, model } = current;
    if (provider !== 'anthropic' && provider !== 'bedrock')
      throw new Error('Budget routing requires a Claude provider.');
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
    return { ...current, provider, model, occurredAt, price };
  };

  // Preserve configuration/price preflight, then resolve again immediately before each purchase.
  const initial = await resolveInvocation(new Date());
  type Invocation = Awaited<ReturnType<typeof resolveInvocation>>;
  const beginInvocation = async (params: CallOptions) => {
    rejectCaching(params);
    const invocation = await resolveInvocation(new Date());
    params.abortSignal?.throwIfAborted();
    prepared.provider = invocation.provider;
    prepared.modelId = invocation.modelId;
    prepared.providerOptions = invocation.providerOptions;
    return { ...invocation, id: randomUUID() };
  };

  type Usage = Awaited<ReturnType<Invocation['model']['doGenerate']>>['usage'];
  const record = async (
    usage: Usage,
    { id, provider, modelId, occurredAt, price }: Invocation & { id: string }
  ) => {
    const recovery = {
      id,
      provider,
      model: modelId,
      occurredAt: occurredAt.toISOString(),
      inputTokens: usage.inputTokens.total,
      outputTokens: usage.outputTokens.total,
      inputUsdPerMillionTokens: price.inputUsdPerMillionTokens.toString(),
      outputUsdPerMillionTokens: price.outputUsdPerMillionTokens.toString(),
    };
    try {
      // Missing usage is an accounting failure, never a fabricated zero-cost call.
      const inputTokens = usage.inputTokens.total;
      const outputTokens = usage.outputTokens.total;
      if (inputTokens === undefined || outputTokens === undefined)
        throw new Error('AI provider did not report usage.');
      await journal.record({
        id,
        provider,
        model: modelId,
        inputTokens,
        outputTokens,
        costUsd: calculateAIUsageCost(price, inputTokens, outputTokens).toFixed(6),
        occurredAt: recovery.occurredAt,
      });
    } catch {
      // Preserve paid output on a telemetry outage instead of inducing a paid retry.
      // The journal retains retryable writes; the structured fallback also allows
      // reconciliation if the journal's filesystem itself becomes unavailable.
      // Only accounting metadata is emitted, never prompts, output or DB errors.
      console.error('AI_USAGE_PERSIST_FAILED', JSON.stringify(recovery));
    }
  };
  const middleware: LanguageModelMiddleware = {
    specificationVersion: 'v3',
    async wrapGenerate({ params }) {
      const invocation = await beginInvocation(params);
      const result = await invocation.model.doGenerate(params);
      await record(result.usage, invocation);
      return result;
    },
    async wrapStream({ params }) {
      const invocation = await beginInvocation(params);
      const result = await invocation.model.doStream(params);
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            async transform(part, controller) {
              if (part.type === 'finish') await record(part.usage, invocation);
              controller.enqueue(part);
            },
          })
        ),
      };
    },
  };
  const prepared: AIModelSelection = {
    ...initial,
    model: wrapLanguageModel({ model: initial.model, middleware }),
  };
  return prepared;
}
