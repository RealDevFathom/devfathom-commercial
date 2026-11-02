import 'server-only';

import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { DEFAULT_MODELS, type TieredAIProviderName } from './model-defaults';
import type { AITier } from './tiers';

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
        anthropic: { cheap: row.cheapAnthropicModel, standard: row.standardAnthropicModel, deep: row.deepAnthropicModel },
        bedrock: { cheap: row.cheapBedrockModel, standard: row.standardBedrockModel, deep: row.deepBedrockModel },
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
  return withPlatformDb(async (db) => {
    const prices = await db.$queryRaw<Array<{ inputUsdPerMTok: Prisma.Decimal; outputUsdPerMTok: Prisma.Decimal }>>(Prisma.sql`
      SELECT "inputUsdPerMTok", "outputUsdPerMTok" FROM "ai_model_prices"
      WHERE "provider" = ${usage.provider} AND "model" = ${usage.model}
        AND "effectiveFrom" <= ${usage.createdAt ?? new Date()}
      ORDER BY "effectiveFrom" DESC LIMIT 1`);
    const fallback = FALLBACK_USD_PER_MTOK[usage.provider];
    const inputRate = Number(prices[0]?.inputUsdPerMTok ?? fallback.input);
    const outputRate = Number(prices[0]?.outputUsdPerMTok ?? fallback.output);
    const cost = computeAIUsageCost(usage.inputTokens, usage.outputTokens, inputRate, outputRate);
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "ai_usage" ("id", "provider", "tier", "model", "feature", "organizationId", "inputTokens", "outputTokens", "costUsd", "createdAt")
      VALUES (${randomUUID()}, ${usage.provider}, ${usage.tier}, ${usage.model}, ${usage.feature}, ${usage.organizationId ?? null}, ${usage.inputTokens}, ${usage.outputTokens}, ${cost}, ${usage.createdAt ?? new Date()})`);
    return cost;
  });
}

export const DEFAULT_AI_ROUTING_SETTINGS: AIRoutingSettings = {
  mode: 'Auto', monthlyAnthropicBudgetUsd: 200,
  models: { anthropic: { ...DEFAULT_MODELS.anthropic }, bedrock: { ...DEFAULT_MODELS.bedrock } },
};
