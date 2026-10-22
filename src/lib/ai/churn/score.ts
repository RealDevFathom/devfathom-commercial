import 'server-only';

import { getTierForFeature, type AITier } from '../tiers';

export type ChurnBand = 'LOW' | 'MEDIUM' | 'HIGH';

export type CustomerRfm = {
  customerId: string;
  recencyDays: number;
  frequency: number;
  monetaryMinor: number;
};

export type RfmBaseline = Omit<CustomerRfm, 'customerId'>;

export type ChurnScore = {
  customerId: string;
  score: number;
  band: ChurnBand;
  components: { recency: number; frequency: number; monetary: number };
  explanation?: string;
};

const bounded = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

function relativeRisk(value: number, baseline: number, inverse: boolean): number {
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(baseline) || baseline < 0)
    throw new Error('RFM values must be finite and non-negative.');
  if (baseline === 0) return value === 0 ? 50 : inverse ? 0 : 100;
  const ratio = Math.min(value / baseline, 2);
  return bounded((inverse ? 2 - ratio : ratio) * 50);
}

/**
 * Deterministic churn risk. A customer exactly at the shop baseline scores 50;
 * stale visits increase risk while frequency and spend decrease it.
 */
export function scoreCustomerChurn(customer: CustomerRfm, baseline: RfmBaseline): ChurnScore {
  const components = {
    recency: relativeRisk(customer.recencyDays, baseline.recencyDays, false),
    frequency: relativeRisk(customer.frequency, baseline.frequency, true),
    monetary: relativeRisk(customer.monetaryMinor, baseline.monetaryMinor, true),
  };
  const score = bounded(
    components.recency * 0.5 + components.frequency * 0.3 + components.monetary * 0.2
  );
  return {
    customerId: customer.customerId,
    score,
    band: score >= 67 ? 'HIGH' : score >= 34 ? 'MEDIUM' : 'LOW',
    components,
  };
}

export function calculateShopBaseline(customers: CustomerRfm[]): RfmBaseline {
  if (!customers.length) return { recencyDays: 0, frequency: 0, monetaryMinor: 0 };
  const total = customers.reduce(
    (sum, customer) => ({
      recencyDays: sum.recencyDays + customer.recencyDays,
      frequency: sum.frequency + customer.frequency,
      monetaryMinor: sum.monetaryMinor + customer.monetaryMinor,
    }),
    { recencyDays: 0, frequency: 0, monetaryMinor: 0 }
  );
  return {
    recencyDays: total.recencyDays / customers.length,
    frequency: total.frequency / customers.length,
    monetaryMinor: total.monetaryMinor / customers.length,
  };
}

type TenantWhere = { organizationId: string };

export type ChurnScoreStore = {
  readRfm(input: { where: TenantWhere }): Promise<CustomerRfm[]>;
  writeScore(input: {
    where: TenantWhere & { customerId: string };
    score: ChurnScore;
  }): Promise<void>;
  hasAIProviderSecret(input: { where: TenantWhere }): Promise<boolean>;
  readPreviousExplanation(input: {
    where: TenantWhere & { customerId: string };
  }): Promise<string | null>;
  writeAudit(input: {
    actorId: string;
    organizationId: string;
    action: 'AI_CHURN_EXPLANATION';
    oldValue: string | null;
    newValue: string;
    model: string;
    tier: AITier;
  }): Promise<void>;
};

export type ChurnExplanationGenerator = (input: {
  // Deliberately aggregate-only: no customer id, name, contact detail, or transactions.
  score: number;
  band: ChurnBand;
  components: ChurnScore['components'];
  baseline: RfmBaseline;
  model: string;
  tier: AITier;
}) => Promise<string>;

export async function runChurnScoreBatch(options: {
  organizationId: string;
  actorId: string;
  store: ChurnScoreStore;
  can: (action: 'ai:churn:explain') => Promise<boolean>;
  explanation?: { model: string; generate: ChurnExplanationGenerator };
}): Promise<ChurnScore[]> {
  const where = { organizationId: options.organizationId };
  const customers = await options.store.readRfm({ where });
  const baseline = calculateShopBaseline(customers);
  const scores = customers.map((customer) => scoreCustomerChurn(customer, baseline));

  // AI is an optional explanation layer. Scores are saved even when AI is off or denied.
  const mayExplain =
    Boolean(options.explanation) &&
    (await options.store.hasAIProviderSecret({ where })) &&
    (await options.can('ai:churn:explain')); // an explicit false always wins
  const tier = getTierForFeature('retention');

  for (const score of scores) {
    if (mayExplain && options.explanation) {
      const oldValue = await options.store.readPreviousExplanation({
        where: { ...where, customerId: score.customerId },
      });
      score.explanation = await options.explanation.generate({
        score: score.score,
        band: score.band,
        components: score.components,
        baseline,
        model: options.explanation.model,
        tier,
      });
      await options.store.writeAudit({
        actorId: options.actorId,
        organizationId: options.organizationId,
        action: 'AI_CHURN_EXPLANATION',
        oldValue,
        newValue: score.explanation,
        model: options.explanation.model,
        tier,
      });
    }
    await options.store.writeScore({
      where: { ...where, customerId: score.customerId },
      score,
    });
  }
  return scores;
}
