import 'server-only';

import { generateText } from 'ai';
import { z } from 'zod';
import { routeAI } from '@/lib/ai/router';
import { getTierForFeature } from '@/lib/ai/tiers';

export type OwnerInsightAggregates = {
  dailyRevenueMinor: number;
  grossMarginMinor: number | null;
  nearExpiryStockValueMinor: number;
  churnRiskCount: number;
};

const output = z.object({ tips: z.array(z.string().trim().min(1).max(240)).max(3) });
const dailyCache = new Map<string, { aggregates: OwnerInsightAggregates; tips: string[] }>();

export function ownerInsightsPrompt(value: OwnerInsightAggregates) {
  return `Aggregates only (minor currency units): ${JSON.stringify(value)}. Return up to 3 concise, practical owner tips as JSON {"tips":[]}. Do not infer people, patients, medicines, or transactions.`;
}

export async function buildOwnerInsights(options: {
  organizationId: string;
  day: string;
  aggregates: OwnerInsightAggregates;
  aiEnabled: boolean;
  auditGenerated?: (model: { provider: string; modelId: string; tier: string }) => Promise<void>;
}) {
  const key = `${options.organizationId}:${options.day}:${options.aiEnabled}`;
  const cached = dailyCache.get(key);
  if (cached) return { ...cached, aiEnabled: options.aiEnabled && cached.tips.length > 0 };
  let tips: string[] = [];
  if (options.aiEnabled) {
    try {
      tips = await routeAI({
        tier: getTierForFeature('pharmacy-owner-insights'),
        feature: 'pharmacy-owner-insights',
        organizationId: options.organizationId,
        execute: async (selection) => {
          const result = await generateText({
            model: selection.model,
            providerOptions: selection.providerOptions,
            prompt: ownerInsightsPrompt(options.aggregates),
            maxOutputTokens: 400,
            maxRetries: 0,
          });
          await options.auditGenerated?.({
            provider: selection.provider,
            modelId: selection.modelId,
            tier: getTierForFeature('pharmacy-owner-insights'),
          });
          return { value: output.parse(JSON.parse(result.text)).tips, usage: result.usage };
        },
      });
    } catch {
      tips = [];
    }
  }
  const value = { aggregates: options.aggregates, tips };
  dailyCache.set(key, value);
  return { ...value, aiEnabled: options.aiEnabled && tips.length > 0 };
}

export function __resetOwnerInsightsCache() {
  dailyCache.clear();
}
