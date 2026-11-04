import 'server-only';

import { randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';

import { isRoutedProvider, listPriceFor, type TieredAIProviderName } from './model-defaults';
import type { AITier } from './tiers';

// ---------------------------------------------------------------------------
// Tenant attribution (develop, #663): which organization and branch used AI.
// ---------------------------------------------------------------------------

export type AIUsageRecord = {
  organizationId: string;
  branchId: string;
  feature: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

/** Persist tenant-attributed metering. Callers decide whether metering is fail-open. */
export async function recordAIUsage(usage: AIUsageRecord): Promise<void> {
  await withTenantDb(
    usage.organizationId,
    async (db) => {
      await db.aIUsage.create({ data: usage });
    },
    { skipDrain: true }
  );
}

// ---------------------------------------------------------------------------
// Platform routing policy and spend ledger (SuperAdmin; platform-only RLS).
// ---------------------------------------------------------------------------

export type AIRoutingMode = 'Auto' | 'ForceAnthropic' | 'ForceOpenAI' | 'ForceBedrock' | 'Disabled';

/** The saved SuperAdmin overrides. Absent values fall back to the environment. */
export type StoredAISettings = {
  mode: AIRoutingMode;
  providerOrder: TieredAIProviderName[];
  fallbackEnabled: boolean;
  capsUsd: Partial<Record<TieredAIProviderName, number>>;
  models: Record<TieredAIProviderName, Partial<Record<AITier, string>>>;
  updatedAt: Date;
  updatedBy: string | null;
};

type SettingsRow = {
  mode: AIRoutingMode;
  providerOrder: string[];
  fallbackEnabled: boolean;
  anthropicMonthlyCapUsd: Prisma.Decimal | null;
  openaiMonthlyCapUsd: Prisma.Decimal | null;
  bedrockMonthlyCapUsd: Prisma.Decimal | null;
  cheapAnthropicModel: string | null;
  standardAnthropicModel: string | null;
  deepAnthropicModel: string | null;
  cheapOpenaiModel: string | null;
  standardOpenaiModel: string | null;
  deepOpenaiModel: string | null;
  cheapBedrockModel: string | null;
  standardBedrockModel: string | null;
  deepBedrockModel: string | null;
  updatedAt: Date;
  updatedBy: string | null;
};

const optionalNumber = (value: Prisma.Decimal | null) =>
  value === null ? undefined : Number(value);
const optionalText = (value: string | null) => value?.trim() || undefined;

export function storedSettingsFromRow(row: SettingsRow): StoredAISettings {
  return {
    mode: row.mode,
    providerOrder: row.providerOrder.filter(isRoutedProvider),
    fallbackEnabled: row.fallbackEnabled,
    capsUsd: {
      anthropic: optionalNumber(row.anthropicMonthlyCapUsd),
      openai: optionalNumber(row.openaiMonthlyCapUsd),
      bedrock: optionalNumber(row.bedrockMonthlyCapUsd),
    },
    models: {
      anthropic: {
        cheap: optionalText(row.cheapAnthropicModel),
        standard: optionalText(row.standardAnthropicModel),
        deep: optionalText(row.deepAnthropicModel),
      },
      openai: {
        cheap: optionalText(row.cheapOpenaiModel),
        standard: optionalText(row.standardOpenaiModel),
        deep: optionalText(row.deepOpenaiModel),
      },
      bedrock: {
        cheap: optionalText(row.cheapBedrockModel),
        standard: optionalText(row.standardBedrockModel),
        deep: optionalText(row.deepBedrockModel),
      },
    },
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

/** The saved SuperAdmin settings, or null before anyone has saved them. */
export async function readStoredAISettings(): Promise<StoredAISettings | null> {
  return withPlatformDb(async (db) => {
    const rows = await db.$queryRaw<SettingsRow[]>(
      Prisma.sql`SELECT * FROM "ai_settings" WHERE "id" = 'default' LIMIT 1`
    );
    return rows[0] ? storedSettingsFromRow(rows[0]) : null;
  });
}

/** Recorded USD spend for one provider in [from, to). */
export async function readProviderSpend(
  provider: TieredAIProviderName,
  from: Date,
  to: Date
): Promise<number> {
  return withPlatformDb(async (db) => {
    const rows = await db.$queryRaw<Array<{ total: Prisma.Decimal }>>(Prisma.sql`
      SELECT COALESCE(SUM("costUsd"), 0) AS total FROM "ai_provider_usage"
      WHERE "provider" = ${provider} AND "createdAt" >= ${from} AND "createdAt" < ${to}`);
    return Number(rows[0]?.total ?? 0);
  });
}

export function computeAIUsageCost(
  inputTokens: number,
  outputTokens: number,
  inputUsdPerMTok: number,
  outputUsdPerMTok: number
): number {
  return (inputTokens * inputUsdPerMTok + outputTokens * outputUsdPerMTok) / 1_000_000;
}

export type ProviderUsageWrite = {
  provider: TieredAIProviderName;
  tier: AITier;
  model: string;
  feature: string;
  organizationId?: string | null;
  inputTokens: number;
  outputTokens: number;
  createdAt?: Date;
};

/**
 * Price one billed attempt and append it to the platform ledger. The price is the
 * latest SuperAdmin row effective at the call time, else the code list price,
 * else a deliberately high fallback. Returns the recorded USD cost.
 */
export async function recordProviderUsage(usage: ProviderUsageWrite): Promise<number> {
  const createdAt = usage.createdAt ?? new Date();
  const inputTokens = Math.max(0, Math.trunc(usage.inputTokens));
  const outputTokens = Math.max(0, Math.trunc(usage.outputTokens));
  return withPlatformDb(async (db) => {
    const prices = await db.$queryRaw<
      Array<{ inputUsdPerMTok: Prisma.Decimal; outputUsdPerMTok: Prisma.Decimal }>
    >(Prisma.sql`
      SELECT "inputUsdPerMTok", "outputUsdPerMTok" FROM "ai_model_prices"
      WHERE "provider" = ${usage.provider} AND "model" = ${usage.model}
        AND "effectiveFrom" <= ${createdAt}
      ORDER BY "effectiveFrom" DESC LIMIT 1`);
    const list = listPriceFor(usage.provider, usage.model);
    const inputRate = prices[0] ? Number(prices[0].inputUsdPerMTok) : list.input;
    const outputRate = prices[0] ? Number(prices[0].outputUsdPerMTok) : list.output;
    const cost = computeAIUsageCost(inputTokens, outputTokens, inputRate, outputRate);
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "ai_provider_usage"
        ("id", "provider", "tier", "model", "feature", "organizationId", "inputTokens", "outputTokens", "costUsd", "createdAt")
      VALUES (${randomUUID()}, ${usage.provider}, ${usage.tier}, ${usage.model}, ${usage.feature},
              ${usage.organizationId ?? null}, ${inputTokens}, ${outputTokens}, ${cost}, ${createdAt})`);
    return cost;
  });
}
