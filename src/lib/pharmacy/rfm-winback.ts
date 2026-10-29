/**
 * RFM and win-back policy for pharmacy customers.
 *
 * Churn scores are inputs on purpose: churn detection is owned by #729. This
 * module only turns that existing signal and commercial receipt facts into an
 * explainable segment and a policy-safe next action.
 */

export type RfmWinBackConfig = {
  recencyDays: readonly [number, number, number, number];
  frequencyReceipts: readonly [number, number, number, number];
  monetaryMinor: readonly [number, number, number, number];
  winBackChurnScore: number;
  clvProjectionPeriods: number;
};

export type RfmCustomerFacts = {
  customerId: string;
  daysSinceLastReceipt: number;
  receiptCount: number;
  completedSalesMinor: number;
  observedPeriods: number;
  /** Supplied by the churn-scoring feature (#729); it is never recomputed here. */
  churnScore: number;
  hasDrugPurchase: boolean;
  refillDue: boolean;
  reminderWhatsAppConsent: boolean;
  marketingWhatsAppConsent: boolean;
};

export type RfmSegment = 'CHAMPION' | 'LOYAL' | 'PROMISING' | 'NEEDS_ATTENTION' | 'AT_RISK';

export type RfmCustomerResult = {
  customerId: string;
  recencyScore: number;
  frequencyScore: number;
  monetaryScore: number;
  segment: RfmSegment;
  observedValueMinor: number;
  estimatedClvMinor: number;
  clvIsEstimate: true;
  churnScore: number;
};

function requireFiniteNonNegative(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${field} must be a finite non-negative number.`);
}

function validateThresholds(values: readonly number[], field: string) {
  if (values.length !== 4) throw new Error(`${field} must contain four thresholds.`);
  values.forEach((value) => requireFiniteNonNegative(value, field));
  if (values.some((value, index) => index > 0 && value <= values[index - 1]!))
    throw new Error(`${field} thresholds must be strictly increasing.`);
}

function ascendingScore(value: number, thresholds: readonly number[]) {
  return 1 + thresholds.filter((threshold) => value >= threshold).length;
}

function segmentFor(recency: number, frequency: number, monetary: number): RfmSegment {
  const total = recency + frequency + monetary;
  if (total >= 13 && recency >= 4) return 'CHAMPION';
  if (total >= 10 && recency >= 3) return 'LOYAL';
  if (recency >= 4) return 'PROMISING';
  if (recency <= 2 && (frequency >= 3 || monetary >= 3)) return 'AT_RISK';
  return 'NEEDS_ATTENTION';
}

export function computeRfmSegments(
  customers: readonly RfmCustomerFacts[],
  config: RfmWinBackConfig
): RfmCustomerResult[] {
  validateThresholds(config.recencyDays, 'recencyDays');
  validateThresholds(config.frequencyReceipts, 'frequencyReceipts');
  validateThresholds(config.monetaryMinor, 'monetaryMinor');
  requireFiniteNonNegative(config.clvProjectionPeriods, 'clvProjectionPeriods');

  return customers.map((customer) => {
    requireFiniteNonNegative(customer.daysSinceLastReceipt, 'daysSinceLastReceipt');
    requireFiniteNonNegative(customer.receiptCount, 'receiptCount');
    requireFiniteNonNegative(customer.completedSalesMinor, 'completedSalesMinor');
    requireFiniteNonNegative(customer.observedPeriods, 'observedPeriods');
    if (customer.churnScore < 0 || customer.churnScore > 1)
      throw new Error('churnScore must be between zero and one.');

    // Lower recency is better. Exact configured boundaries belong to the less
    // recent band, making boundary behaviour stable and easy to audit.
    const recencyScore =
      5 -
      config.recencyDays.filter((threshold) => customer.daysSinceLastReceipt >= threshold).length;
    const frequencyScore = ascendingScore(customer.receiptCount, config.frequencyReceipts);
    const monetaryScore = ascendingScore(customer.completedSalesMinor, config.monetaryMinor);
    const averagePerPeriod = customer.observedPeriods
      ? customer.completedSalesMinor / customer.observedPeriods
      : 0;

    return {
      customerId: customer.customerId,
      recencyScore,
      frequencyScore,
      monetaryScore,
      segment: segmentFor(recencyScore, frequencyScore, monetaryScore),
      observedValueMinor: Math.round(customer.completedSalesMinor),
      estimatedClvMinor: Math.round(
        customer.completedSalesMinor + averagePerPeriod * config.clvProjectionPeriods
      ),
      clvIsEstimate: true,
      churnScore: customer.churnScore,
    };
  });
}

export type WinBackAction =
  | { customerId: string; kind: 'REFILL_DUE_UTILITY'; text: string; includesOffer: false }
  | { customerId: string; kind: 'NON_DRUG_MARKETING'; text: string; includesOffer: true };

const REFILL_DUE_UTILITY_TEXT =
  'Your refill may be due soon. Reply YES if you would like the pharmacy team to contact you.';

/**
 * Produces mutually exclusive actions. Any customer with drug history is kept
 * on the fixed utility path, even if they also bought non-drug goods or have
 * marketing consent. Consequently no caller-controlled copy can leak a drug,
 * salt, medicine category, or offer into their WhatsApp message.
 */
export function planRfmWinBack(
  customers: readonly RfmCustomerFacts[],
  config: RfmWinBackConfig,
  nonDrugOfferText: string
): WinBackAction[] {
  if (!nonDrugOfferText.trim()) throw new Error('A non-drug offer is required.');
  return customers.flatMap((customer): WinBackAction[] => {
    if (customer.churnScore < config.winBackChurnScore) return [];
    if (customer.hasDrugPurchase) {
      return customer.refillDue && customer.reminderWhatsAppConsent
        ? [
            {
              customerId: customer.customerId,
              kind: 'REFILL_DUE_UTILITY',
              text: REFILL_DUE_UTILITY_TEXT,
              includesOffer: false,
            },
          ]
        : [];
    }
    return customer.marketingWhatsAppConsent
      ? [
          {
            customerId: customer.customerId,
            kind: 'NON_DRUG_MARKETING',
            text: nonDrugOfferText,
            includesOffer: true,
          },
        ]
      : [];
  });
}
