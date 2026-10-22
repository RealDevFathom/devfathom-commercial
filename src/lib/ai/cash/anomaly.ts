import 'server-only';

import { generateText } from 'ai';
import { z } from 'zod';
import type { Action } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { CASH_CLOSE_ANOMALY_I18N } from '@/lib/pharmacy/cashclose-anomaly-i18n';
import { getDefaultModelId, type TieredAIProviderName } from '../model-defaults';
import { getModelForTier } from '../provider';
import { getTierForFeature } from '../tiers';

export const CASH_ANOMALY_LABEL = CASH_CLOSE_ANOMALY_I18N.en.messages.productLabel;
const RATE_SCALE = 10_000;

const cashierSchema = z.object({
  cashierId: z.string().min(1),
  transactionCount: z.number().int().nonnegative(),
  voidCount: z.number().int().nonnegative(),
  refundCount: z.number().int().nonnegative(),
  discountCount: z.number().int().nonnegative(),
});

export const cashCloseInputSchema = z
  .object({
    organizationId: z.string().min(1),
    branchId: z.string().min(1),
    closeId: z.string().min(1),
    declaredCashMinor: z.number().int(),
    cashSalesMinor: z.number().int().nonnegative(),
    cashRefundsMinor: z.number().int().nonnegative(),
    cashPayoutsMinor: z.number().int().nonnegative(),
    varianceLimitMinor: z.number().int().positive().default(500),
    cashiers: z.array(cashierSchema).max(500),
    sales: z
      .array(
        z.object({
          saleId: z.string().min(1),
          occurredAt: z.iso.datetime(),
          localHour: z.number().int().min(0).max(23),
        })
      )
      .max(100_000),
    businessHours: z.object({
      opensAtHour: z.number().int().min(0).max(23),
      closesAtHour: z.number().int().min(0).max(24),
    }),
  })
  .strict();

export type CashCloseInput = z.infer<typeof cashCloseInputSchema>;
export type CashAnomaly =
  | {
      kind: 'CASH_VARIANCE';
      expectedCashMinor: number;
      declaredCashMinor: number;
      varianceMinor: number;
    }
  | {
      kind: 'UNUSUAL_VOID_RATE' | 'UNUSUAL_REFUND_RATE' | 'UNUSUAL_DISCOUNT_RATE';
      cashierId: string;
      count: number;
      transactionCount: number;
      rateBps: number;
    }
  | { kind: 'AFTER_HOURS_SALE'; saleId: string; occurredAt: string; localHour: number };

/** Pure, deterministic checks. The model is never allowed to decide what is anomalous. */
export function detectCashCloseAnomalies(raw: unknown): {
  expectedCashMinor: number;
  anomalies: CashAnomaly[];
} {
  const input = cashCloseInputSchema.parse(raw);
  const expectedCashMinor = input.cashSalesMinor - input.cashRefundsMinor - input.cashPayoutsMinor;
  const varianceMinor = input.declaredCashMinor - expectedCashMinor;
  const anomalies: CashAnomaly[] = [];
  if (Math.abs(varianceMinor) >= input.varianceLimitMinor)
    anomalies.push({
      kind: 'CASH_VARIANCE',
      expectedCashMinor,
      declaredCashMinor: input.declaredCashMinor,
      varianceMinor,
    });

  const rates = [
    ['voidCount', 'UNUSUAL_VOID_RATE', 1_000],
    ['refundCount', 'UNUSUAL_REFUND_RATE', 800],
    ['discountCount', 'UNUSUAL_DISCOUNT_RATE', 2_000],
  ] as const;
  for (const cashier of input.cashiers) {
    if (cashier.transactionCount < 10) continue;
    for (const [field, kind, threshold] of rates) {
      const count = cashier[field];
      const rateBps = Math.round((count * RATE_SCALE) / cashier.transactionCount);
      if (rateBps >= threshold)
        anomalies.push({
          kind,
          cashierId: cashier.cashierId,
          count,
          transactionCount: cashier.transactionCount,
          rateBps,
        });
    }
  }
  for (const sale of input.sales) {
    const { opensAtHour: open, closesAtHour: close } = input.businessHours;
    const inHours =
      open < close
        ? sale.localHour >= open && sale.localHour < close
        : sale.localHour >= open || sale.localHour < close;
    if (!inHours) anomalies.push({ kind: 'AFTER_HOURS_SALE', ...sale });
  }
  return { expectedCashMinor, anomalies };
}

type Actor = {
  organizationId: string;
  userId: string;
  role: string;
  can(action: Action): Promise<boolean>;
  db: ScopedDb;
};
type ProviderConfig = {
  provider: TieredAIProviderName;
  secretConfigured: boolean;
  /** Decrypted only inside the server adapter and never returned or audited. */
  providerEnv: Record<string, string | undefined>;
  modelOverrides?: Parameters<typeof getDefaultModelId>[2];
} | null;
export type CashAnomalyDependencies = {
  /** Must read the encrypted, organization-scoped provider setting on the server. */
  readProviderConfig(organizationId: string): Promise<ProviderConfig>;
  summarize?: (
    facts: readonly CashAnomaly[],
    model: ReturnType<typeof getModelForTier>
  ) => Promise<string>;
};

export class CashAnomalyAccessError extends Error {}

/** Owner-only, tenant-bound entry point. Every invocation is audit logged. */
export async function analyzeCashClose(actor: Actor, raw: unknown, deps: CashAnomalyDependencies) {
  const input = cashCloseInputSchema.parse(raw);
  const permitted = await actor.can('reports:financial');
  const ownerPermitted = await actor.can('restaurant:configure');
  if (
    actor.organizationId !== input.organizationId ||
    actor.role !== 'ADMIN' ||
    !permitted ||
    !ownerPermitted
  )
    throw new CashAnomalyAccessError('DENIED');

  const deterministic = detectCashCloseAnomalies(input);
  const tier = getTierForFeature('analytics');
  const config = await deps.readProviderConfig(actor.organizationId);
  const modelId = config?.secretConfigured
    ? getDefaultModelId(config.provider, tier, config.modelOverrides)
    : null;
  let summary: string | null = null;
  let outcome: 'SUCCESS' | 'FAILURE' = 'SUCCESS';
  let errorCode: string | undefined;
  try {
    if (!config?.secretConfigured) throw new Error('AI_NOT_CONFIGURED');
    const model = getModelForTier(config.provider, tier, config.modelOverrides, config.providerEnv);
    summary = deps.summarize
      ? await deps.summarize(deterministic.anomalies, model)
      : (
          await generateText({
            model,
            system:
              'Summarize only the supplied deterministic cash-close findings. Do not add findings, causes, accusations, or recommendations.',
            prompt: JSON.stringify(deterministic.anomalies),
            maxOutputTokens: 300,
          })
        ).text;
  } catch (error) {
    outcome = 'FAILURE';
    errorCode =
      error instanceof Error && error.message === 'AI_NOT_CONFIGURED'
        ? 'AI_NOT_CONFIGURED'
        : 'AI_SUMMARY_FAILED';
  }
  await actor.db.auditLog.create({
    data: {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      source: 'SYSTEM',
      category: 'FINANCE',
      operation: 'READ',
      action: 'ai.cashClose.analyze',
      outcome,
      targetType: 'RestaurantDailyClose',
      targetId: input.closeId,
      input: { branchId: input.branchId },
      changes: {
        old: null,
        new: {
          expectedCashMinor: deterministic.expectedCashMinor,
          anomalies: deterministic.anomalies,
        },
      },
      result: { summary },
      metadata: {
        label: CASH_ANOMALY_LABEL,
        provider: config?.provider ?? null,
        model: modelId,
        tier,
      },
      ...(errorCode ? { errorCode } : {}),
    },
  });
  return {
    ...deterministic,
    summary,
    ai: {
      status: outcome === 'SUCCESS' ? ('READY' as const) : ('UNAVAILABLE' as const),
      model: modelId,
      tier,
    },
  };
}
