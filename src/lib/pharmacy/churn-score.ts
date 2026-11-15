/**
 * RFM-based churn score for pharmacy customers (DEV-83).
 *
 * Recency, frequency and monetary value are each banded 1 (weak) to 5
 * (strong). The churn score is the weighted shortfall from a perfect 5/5/5,
 * scaled to 0 (retained) .. 100 (likely lapsed). Recency carries most weight
 * because a lapsed regular is the signal win-back acts on.
 */
export const CHURN_SCORING_POLICY = {
  /** Frequency and monetary value look back this many days. */
  windowDays: 365,
  /** Days since last receipt; reaching a threshold drops one recency band. */
  recencyDays: [30, 60, 90, 180],
  /** Receipts in the window; reaching a threshold raises one frequency band. */
  frequencyReceipts: [2, 4, 8, 12],
  /** Tendered value in the window (minor units); thresholds raise one band. */
  monetaryMinor: [100_000, 300_000, 750_000, 1_500_000],
  weights: { recency: 0.6, frequency: 0.25, monetary: 0.15 },
} as const;

export type ChurnFacts = {
  daysSinceLastReceipt: number;
  receiptCount: number;
  monetaryMinor: number;
};

export type ChurnScore = {
  score: number;
  recencyScore: number;
  frequencyScore: number;
  monetaryScore: number;
};

function requireFiniteNonNegative(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${field} must be a finite non-negative number.`);
}

const reached = (value: number, thresholds: readonly number[]) =>
  thresholds.filter((threshold) => value >= threshold).length;

export function computeChurnScore(facts: ChurnFacts): ChurnScore {
  requireFiniteNonNegative(facts.daysSinceLastReceipt, 'daysSinceLastReceipt');
  requireFiniteNonNegative(facts.receiptCount, 'receiptCount');
  requireFiniteNonNegative(facts.monetaryMinor, 'monetaryMinor');
  const policy = CHURN_SCORING_POLICY;
  const recencyScore = 5 - reached(facts.daysSinceLastReceipt, policy.recencyDays);
  const frequencyScore = 1 + reached(facts.receiptCount, policy.frequencyReceipts);
  const monetaryScore = 1 + reached(facts.monetaryMinor, policy.monetaryMinor);
  const shortfall =
    policy.weights.recency * (5 - recencyScore) +
    policy.weights.frequency * (5 - frequencyScore) +
    policy.weights.monetary * (5 - monetaryScore);
  return {
    score: Math.round((shortfall / 4) * 100),
    recencyScore,
    frequencyScore,
    monetaryScore,
  };
}

/** The 0..1 form that win-back planning (`rfm-winback.ts`) consumes. */
export function churnScoreFraction(score: number) {
  if (!Number.isInteger(score) || score < 0 || score > 100)
    throw new Error('A churn score must be an integer between 0 and 100.');
  return score / 100;
}
