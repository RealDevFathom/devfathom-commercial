import 'server-only';

import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { DEFAULT_MODELS, type TieredAIProviderName } from './model-defaults';
import type { AITier } from './tiers';
import { AI_METERING_PRINCIPAL, can } from './mutation-authorization';

export type AIRoutingMode = 'Auto' | 'ForceAnthropic' | 'ForceBedrock' | 'Disabled';
export type AIRoutingSettings = {
  mode: AIRoutingMode;
  monthlyAnthropicBudgetUsd: number;
  models: Record<TieredAIProviderName, Record<AITier, string>>;
};

const FALLBACK_USD_PER_MTOK: Record<TieredAIProviderName, { input: number; output: number }> = {
  anthropic: { input: 3, output: 15 },
  bedrock: { input: 3, output: 15 },
};
const MAX_DATABASE_TOKEN_COUNT = 2_147_483_647;
const MAX_DATABASE_COST_USD = 9_999_999_999.99999999;

export function computeAIUsageCost(
  inputTokens: number,
  outputTokens: number,
  inputUsdPerMTok: number,
  outputUsdPerMTok: number
): number {
  return (inputTokens * inputUsdPerMTok + outputTokens * outputUsdPerMTok) / 1_000_000;
}

export async function readAIRoutingSettings(): Promise<AIRoutingSettings | null> {
  return withPlatformDb(async (db) => {
    const rows = await db.$queryRaw<
      Array<{
        mode: AIRoutingMode;
        monthlyAnthropicBudgetUsd: Prisma.Decimal;
        cheapAnthropicModel: string;
        standardAnthropicModel: string;
        deepAnthropicModel: string;
        cheapBedrockModel: string;
        standardBedrockModel: string;
        deepBedrockModel: string;
      }>
    >(Prisma.sql`SELECT * FROM "ai_settings" WHERE "id" = 'default' LIMIT 1`);
    const row = rows[0];
    if (!row) return null;
    return {
      mode: row.mode,
      monthlyAnthropicBudgetUsd: Number(row.monthlyAnthropicBudgetUsd),
      models: {
        anthropic: {
          cheap: row.cheapAnthropicModel,
          standard: row.standardAnthropicModel,
          deep: row.deepAnthropicModel,
        },
        bedrock: {
          cheap: row.cheapBedrockModel,
          standard: row.standardBedrockModel,
          deep: row.deepBedrockModel,
        },
      },
    };
  });
}

export async function readProviderSpend(provider: TieredAIProviderName, from: Date, to: Date) {
  return withPlatformDb(async (db) => {
    const rows = await db.$queryRaw<Array<{ total: Prisma.Decimal }>>(Prisma.sql`
      SELECT COALESCE(SUM("costUsd"), 0) AS total FROM "ai_usage"
      WHERE "provider" = ${provider} AND "createdAt" >= ${from} AND "createdAt" < ${to}`);
    return Number(rows[0]?.total ?? 0);
  });
}

export type UsageWrite = {
  provider: TieredAIProviderName;
  tier: AITier;
  model: string;
  feature: string;
  organizationId?: string | null;
  inputTokens: number;
  outputTokens: number;
  createdAt?: Date;
};

export async function recordAIUsage(usage: UsageWrite): Promise<number> {
  if (!can(AI_METERING_PRINCIPAL, 'usage:write')) {
    throw new Error('AI metering principal is not authorized to write usage.');
  }
  if (
    !Number.isSafeInteger(usage.inputTokens) ||
    usage.inputTokens < 0 ||
    usage.inputTokens > MAX_DATABASE_TOKEN_COUNT ||
    !Number.isSafeInteger(usage.outputTokens) ||
    usage.outputTokens < 0 ||
    usage.outputTokens > MAX_DATABASE_TOKEN_COUNT
  ) {
    throw new RangeError('AI token counts must be non-negative safe integers.');
  }
  const cost = await withPlatformDb(async (db) => {
    const prices = await db.$queryRaw<
      Array<{ inputUsdPerMTok: Prisma.Decimal; outputUsdPerMTok: Prisma.Decimal }>
    >(Prisma.sql`
      SELECT "inputUsdPerMTok", "outputUsdPerMTok" FROM "ai_model_prices"
      WHERE "provider" = ${usage.provider} AND "model" = ${usage.model}
        AND "effectiveFrom" <= ${usage.createdAt ?? new Date()}
      ORDER BY "effectiveFrom" DESC LIMIT 1`);
    const fallback = FALLBACK_USD_PER_MTOK[usage.provider];
    const inputRate = Number(prices[0]?.inputUsdPerMTok ?? fallback.input);
    const outputRate = Number(prices[0]?.outputUsdPerMTok ?? fallback.output);
    if (![inputRate, outputRate].every((rate) => Number.isFinite(rate) && rate >= 0)) {
      throw new RangeError('AI model prices must be finite and non-negative.');
    }
    const cost = computeAIUsageCost(usage.inputTokens, usage.outputTokens, inputRate, outputRate);
    if (!Number.isFinite(cost) || cost < 0 || cost > MAX_DATABASE_COST_USD) {
      throw new RangeError('Computed AI usage cost is outside the supported range.');
    }
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "ai_usage" ("id", "provider", "tier", "model", "feature", "organizationId", "inputTokens", "outputTokens", "costUsd", "createdAt")
      VALUES (${randomUUID()}, ${usage.provider}, ${usage.tier}, ${usage.model}, ${usage.feature}, ${usage.organizationId ?? null}, ${usage.inputTokens}, ${usage.outputTokens}, ${cost}, ${usage.createdAt ?? new Date()})`);
    return cost;
  });
  // Budget notification work must never add latency or fail an AI request.
  void import('./usage')
    .then(({ maybeCreateAIBudgetAlert }) => maybeCreateAIBudgetAlert(usage.createdAt ?? new Date()))
    .catch(() => undefined);
  return cost;
}

export const DEFAULT_AI_ROUTING_SETTINGS: AIRoutingSettings = {
  mode: 'Auto',
  monthlyAnthropicBudgetUsd: 200,
  models: { anthropic: { ...DEFAULT_MODELS.anthropic }, bedrock: { ...DEFAULT_MODELS.bedrock } },
};
