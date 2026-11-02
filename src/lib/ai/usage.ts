import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { requirePlatformSession, type PlatformIdentity } from '@/lib/platform/auth';
import { PlatformSecurityError } from '@/lib/platform/security';
import { withPlatformDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  AI_TIERS,
  ROUTED_AI_PROVIDERS,
  isRoutedProvider,
  type TieredAIProviderName,
} from './model-defaults';
import { addSafeMinor, minorFromUsd, safeMinorFromBigInt } from './money';
import { AI_METERING_PRINCIPAL, can } from './mutation-authorization';
import { karachiMonthBounds, resolveRoutingSettings, type RoutingSettings } from './router';
import { readStoredAISettings } from './spend';

// Spend reporting and per-provider cap alerts. Every figure here comes from the
// platform ledger "ai_provider_usage". The tenant "ai_usage" table is attribution
// only and is never read for spend.

type Provider = TieredAIProviderName;

/** A provider at or above this share of its monthly cap is "near cap" and alerts once. */
export const NEAR_CAP_PERCENT = 80;

export type AIProviderCapStatus = 'ok' | 'near_cap' | 'capped';

export type AITierUsage = {
  tier: string;
  /** The model this tier routes to now; earlier calls this month may have used another. */
  configuredModel: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  spendMinor: number;
};

export type AIProviderMonthlyUsage = {
  provider: Provider;
  spendMinor: number;
  capMinor: number;
  percentUsed: number;
  status: AIProviderCapStatus;
  tiers: AITierUsage[];
};

export type MonthlyAIUsage = {
  /** Asia/Karachi calendar month, `YYYY-MM`. */
  month: string;
  from: Date;
  to: Date;
  /** Always every routed provider, in the default routing order. */
  providers: AIProviderMonthlyUsage[];
  totalSpendMinor: number;
  /** Where the effective caps come from: saved SuperAdmin settings or the environment. */
  capSource: RoutingSettings['source'];
  /** The share of a cap at which a provider is "near cap" and SuperAdmins are alerted. */
  nearCapPercent: number;
};

export type AIBudgetAlertOutcome = 'none' | 'near_cap' | 'cap_reached';

const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  bedrock: 'Amazon Bedrock',
};

const KARACHI_MONTH = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Karachi',
  year: 'numeric',
  month: '2-digit',
});

/** The Asia/Karachi calendar month containing `now`: `YYYY-MM` plus UTC bounds [from, to). */
export function karachiMonth(now: Date): { month: string; from: Date; to: Date } {
  const bounds = karachiMonthBounds(now);
  const parts = KARACHI_MONTH.formatToParts(bounds.from);
  const year = parts.find((part) => part.type === 'year')?.value ?? '';
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  return { month: `${year.padStart(4, '0')}-${month}`, ...bounds };
}

/**
 * Cap state for one provider. "capped" mirrors the router exactly (it skips a
 * provider once spend >= cap, so a zero cap is always capped); "near_cap" is at
 * least NEAR_CAP_PERCENT of the cap.
 */
export function providerCapState(
  spendUsd: number,
  capUsd: number
): { percentUsed: number; status: AIProviderCapStatus } {
  const percentUsed = capUsd > 0 ? (spendUsd / capUsd) * 100 : 100;
  if (spendUsd >= capUsd) return { percentUsed, status: 'capped' };
  if (spendUsd * 100 >= capUsd * NEAR_CAP_PERCENT) return { percentUsed, status: 'near_cap' };
  return { percentUsed, status: 'ok' };
}

function errorName(error: unknown): string {
  return error && typeof error === 'object' && 'name' in error ? String(error.name) : 'Error';
}

function safeCount(value: bigint, label: string): number {
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} is outside the safe integer range.`);
  }
  return Number(value);
}

/**
 * The effective routing policy, read fresh so a SuperAdmin sees a saved cap at
 * once. Unreadable settings fall back to the environment, as the router does.
 */
async function readEffectiveSettings(): Promise<RoutingSettings> {
  try {
    return resolveRoutingSettings(await readStoredAISettings());
  } catch (error) {
    console.error('[ai-usage] could not read SuperAdmin AI settings; using environment caps', {
      error: errorName(error),
    });
    return resolveRoutingSettings(null);
  }
}

type AggregateRow = {
  provider: string;
  tier: string;
  calls: bigint;
  inputTokens: bigint;
  outputTokens: bigint;
  spendMinor: bigint;
  providerSpendMinor: bigint;
  providerSpendUsd: string;
};

/**
 * One row per provider and tier. Cents are rounded once per aggregate in SQL
 * (the provider total over its unrounded sum, not over rounded tiers), and the
 * exact provider sum comes back as text for the cap comparison.
 */
async function aggregateMonth(db: ScopedDb, from: Date, to: Date): Promise<AggregateRow[]> {
  return db.$queryRaw<AggregateRow[]>(Prisma.sql`
    SELECT "provider", "tier",
      COUNT(*)::bigint AS "calls",
      COALESCE(SUM("inputTokens"), 0)::bigint AS "inputTokens",
      COALESCE(SUM("outputTokens"), 0)::bigint AS "outputTokens",
      ROUND(SUM("costUsd") * 100)::bigint AS "spendMinor",
      ROUND(SUM(SUM("costUsd")) OVER (PARTITION BY "provider") * 100)::bigint AS "providerSpendMinor",
      (SUM(SUM("costUsd")) OVER (PARTITION BY "provider"))::text AS "providerSpendUsd"
    FROM "ai_provider_usage"
    WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
    GROUP BY "provider", "tier"
    ORDER BY "provider", "tier"`);
}

function tierOrder(tier: string): number {
  const index = (AI_TIERS as readonly string[]).indexOf(tier);
  return index === -1 ? AI_TIERS.length : index;
}

function providerUsage(
  provider: Provider,
  rows: AggregateRow[],
  settings: RoutingSettings
): AIProviderMonthlyUsage {
  const own = rows.filter((row) => row.provider === provider);
  const capUsd = settings.capsUsd[provider];
  const spendUsd = Number(own[0]?.providerSpendUsd ?? 0);
  const tiers = new Map<string, AITierUsage>();
  for (const tier of AI_TIERS) {
    tiers.set(tier, {
      tier,
      configuredModel: settings.models[provider][tier],
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      spendMinor: 0,
    });
  }
  for (const row of own) {
    tiers.set(row.tier, {
      tier: row.tier,
      configuredModel: tiers.get(row.tier)?.configuredModel ?? null,
      calls: safeCount(row.calls, 'AI call count'),
      inputTokens: safeCount(row.inputTokens, 'AI input tokens'),
      outputTokens: safeCount(row.outputTokens, 'AI output tokens'),
      spendMinor: safeMinorFromBigInt(row.spendMinor, 'AI tier spend'),
    });
  }
  return {
    provider,
    spendMinor: own[0] ? safeMinorFromBigInt(own[0].providerSpendMinor, 'AI provider spend') : 0,
    capMinor: minorFromUsd(capUsd, 'AI provider cap'),
    ...providerCapState(spendUsd, capUsd),
    tiers: [...tiers.values()].sort(
      (left, right) =>
        tierOrder(left.tier) - tierOrder(right.tier) || left.tier.localeCompare(right.tier)
    ),
  };
}

/** This Asia/Karachi month's spend per provider and tier against each effective cap. SuperAdmin only. */
export async function readMonthlyAIUsage(
  now = new Date(),
  identity?: PlatformIdentity
): Promise<MonthlyAIUsage> {
  const actor = identity ?? (await requirePlatformSession());
  if (actor.role !== 'SUPER_ADMIN') {
    throw new PlatformSecurityError('SuperAdmin access is required.', 403);
  }
  const period = karachiMonth(now);
  const [rows, settings] = await Promise.all([
    withPlatformDb((db) => aggregateMonth(db, period.from, period.to)),
    readEffectiveSettings(),
  ]);
  const providers = ROUTED_AI_PROVIDERS.map((provider) => providerUsage(provider, rows, settings));
  return {
    ...period,
    providers,
    totalSpendMinor: providers.reduce(
      (sum, usage) => addSafeMinor(sum, usage.spendMinor, 'Total AI spend'),
      0
    ),
    capSource: settings.source,
    nearCapPercent: NEAR_CAP_PERCENT,
  };
}

const usd = (minor: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(minor / 100);

function alertCopy(
  provider: Provider,
  kind: 'near_cap' | 'cap_reached',
  month: string,
  spendUsd: number,
  capUsd: number,
  percentUsed: number
) {
  const label = PROVIDER_LABEL[provider];
  const used = `${label} has used ${usd(minorFromUsd(spendUsd, 'AI provider spend'))} of its ${usd(
    minorFromUsd(capUsd, 'AI provider cap')
  )} monthly cap for ${month} (Asia/Karachi).`;
  return kind === 'near_cap'
    ? {
        // Floor for the label, but never below the threshold that triggered it.
        title: `${label} AI spend at ${Math.max(NEAR_CAP_PERCENT, Math.floor(percentUsed))}% of cap`,
        message: `${used} Routing moves to the next provider once the cap is reached.`,
      }
    : {
        title: `${label} AI cap reached`,
        message: `${used} Cap reached — routing skips this provider until the month ends or a SuperAdmin raises the cap.`,
      };
}

/**
 * Per-provider cap alert, run best-effort by the router after each recorded
 * attempt. Never throws.
 *
 * - At NEAR_CAP_PERCENT of the provider's effective cap it claims
 *   (provider, Karachi month) in "ai_budget_alert_months" and notifies every
 *   active SUPER_ADMIN in the same transaction. The primary key makes a
 *   concurrent second call a no-op, and a failed fan-out rolls the claim back.
 * - At the cap it notifies every active SUPER_ADMIN that routing now skips the
 *   provider. Those rows carry a deterministic id per provider, month and user,
 *   so concurrent calls write each one once. A provider that jumps straight
 *   past its cap gets only this notification (the claim is still taken).
 *
 * Returns what this call newly wrote.
 */
export async function maybeCreateAIBudgetAlert(
  provider: Provider,
  now = new Date()
): Promise<AIBudgetAlertOutcome> {
  try {
    if (!isRoutedProvider(provider)) return 'none';
    if (!can(AI_METERING_PRINCIPAL, 'budget-alert:write')) return 'none';
    const { month, from, to } = karachiMonth(now);
    const capUsd = (await readEffectiveSettings()).capsUsd[provider];

    return await withPlatformDb(async (db) => {
      const spent = await db.$queryRaw<Array<{ total: string }>>(Prisma.sql`
        SELECT COALESCE(SUM("costUsd"), 0)::text AS "total" FROM "ai_provider_usage"
        WHERE "provider" = ${provider} AND "createdAt" >= ${from} AND "createdAt" < ${to}`);
      const spendUsd = Number(spent[0]?.total ?? 0);
      const { percentUsed, status } = providerCapState(spendUsd, capUsd);
      if (status === 'ok') return 'none';

      const claimed = await db.$executeRaw(Prisma.sql`
        INSERT INTO "ai_budget_alert_months" ("provider", "month", "createdAt")
        VALUES (${provider}, ${month}, ${now})
        ON CONFLICT ("provider", "month") DO NOTHING`);

      if (status === 'near_cap') {
        if (!claimed) return 'none';
        const copy = alertCopy(provider, 'near_cap', month, spendUsd, capUsd, percentUsed);
        await db.$executeRaw(Prisma.sql`
          INSERT INTO "platform_notifications" ("id", "platformUserId", "type", "title", "message", "createdAt")
          SELECT gen_random_uuid()::text, "id", 'ai_cap_near', ${copy.title}, ${copy.message}, ${now}
          FROM "platform_users" WHERE "role" = 'SUPER_ADMIN' AND "active" = true`);
        return 'near_cap';
      }

      const copy = alertCopy(provider, 'cap_reached', month, spendUsd, capUsd, percentUsed);
      const written = await db.$executeRaw(Prisma.sql`
        INSERT INTO "platform_notifications" ("id", "platformUserId", "type", "title", "message", "createdAt")
        SELECT ${`ai_cap_reached:${provider}:${month}:`}::text || "id", "id", 'ai_cap_reached',
          ${copy.title}, ${copy.message}, ${now}
        FROM "platform_users" WHERE "role" = 'SUPER_ADMIN' AND "active" = true
        ON CONFLICT ("id") DO NOTHING`);
      return written > 0 ? 'cap_reached' : 'none';
    });
  } catch (error) {
    // Alerts must never fail an AI call or its metering. Log the error class only.
    console.error('[ai-usage] could not evaluate the AI cap alert', {
      provider: isRoutedProvider(provider) ? provider : 'unknown',
      error: errorName(error),
    });
    return 'none';
  }
}
