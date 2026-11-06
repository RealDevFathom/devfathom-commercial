/**
 * #729 — RFM churn scoring (model v1), pure and deterministic.
 *
 * Inputs are retail-only per-customer aggregates for one branch: the last
 * completed receipt, completed receipts in the trailing window and their net
 * line value. No clinical, prescription or medicine data is read or produced.
 *
 * - Recency (R) uses absolute day thresholds so a lapse is a lapse in any cohort.
 * - Frequency (F) uses absolute receipt-count thresholds in the trailing window.
 * - Monetary (M) is relative to the branch cohort (quintile by "share of the
 *   cohort spending strictly less"); cohorts below {@link MIN_MONETARY_COHORT}
 *   receive a neutral 3 so a tiny branch cannot manufacture extremes.
 *
 * churnScore = round(100 × (0.60·(5−R) + 0.25·(5−F) + 0.15·(5−M)) / 4), 0–100,
 * higher meaning more likely to have churned.
 */
export const CHURN_MODEL_VERSION = 1;
export const CHURN_WINDOW_DAYS = 365;
export const MIN_MONETARY_COHORT = 5;
/** Upper bound of the stored, segment-facing churn score (`churnScore` is 0–100). */
export const CHURN_SCORE_MAX = 100;
export const CHURN_RISK_BANDS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type ChurnRiskBand = (typeof CHURN_RISK_BANDS)[number];

const DAY = 86_400_000;
const ZERO = BigInt(0);
const RECENCY_THRESHOLDS = [30, 60, 90, 180] as const; // ≤30d → 5 … >180d → 1
const FREQUENCY_THRESHOLDS = [9, 5, 3, 2] as const; // ≥9 → 5 … ≤1 → 1
const WEIGHTS = { recency: 0.6, frequency: 0.25, monetary: 0.15 } as const;

export type ChurnInputRow = {
  customerId: string;
  lastCompletedAt: Date;
  /** Completed, unreturned receipts inside the trailing window. */
  frequency: number;
  /** Net line value (minor units) of those receipts; never negative. */
  monetaryMinor: bigint;
};

export type ChurnScoreRow = {
  customerId: string;
  modelVersion: number;
  recencyDays: number;
  frequency: number;
  monetaryMinor: bigint;
  recencyScore: number;
  frequencyScore: number;
  monetaryScore: number;
  churnScore: number;
  riskBand: ChurnRiskBand;
};

export function recencyScore(days: number): number {
  const index = RECENCY_THRESHOLDS.findIndex((limit) => days <= limit);
  return index === -1 ? 1 : 5 - index;
}

export function frequencyScore(receipts: number): number {
  const index = FREQUENCY_THRESHOLDS.findIndex((floor) => receipts >= floor);
  return index === -1 ? 1 : 5 - index;
}

export function churnRiskBand(score: number): ChurnRiskBand {
  return score >= 70 ? 'HIGH' : score >= 40 ? 'MEDIUM' : 'LOW';
}

export function combineChurnScore(r: number, f: number, m: number): number {
  const weighted =
    WEIGHTS.recency * (5 - r) + WEIGHTS.frequency * (5 - f) + WEIGHTS.monetary * (5 - m);
  return Math.min(CHURN_SCORE_MAX, Math.max(0, Math.round((CHURN_SCORE_MAX * weighted) / 4)));
}

function monetaryScores(rows: ChurnInputRow[]): number[] {
  if (rows.length < MIN_MONETARY_COHORT) return rows.map(() => 3);
  const sorted = rows.map((row) => row.monetaryMinor).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return rows.map((row) => {
    // Lower bound: how many cohort members spent strictly less. Ties share a score.
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (sorted[mid] < row.monetaryMinor) low = mid + 1;
      else high = mid;
    }
    return Math.min(5, 1 + Math.floor((5 * low) / sorted.length));
  });
}

/**
 * The stored 0–100 churn score as the 0–1 probability-style value that the
 * win-back policy (`rfm-winback.ts`, #750) validates and compares against
 * `winBackChurnScore`. Every consumer on the 0–1 scale must convert through
 * this helper rather than passing stored rows straight through.
 */
export function churnScoreToUnitInterval(score: number): number {
  if (!Number.isFinite(score) || score < 0 || score > CHURN_SCORE_MAX)
    throw new Error(`churnScore must be a finite number between 0 and ${CHURN_SCORE_MAX}.`);
  return score / CHURN_SCORE_MAX;
}

export function scoreChurnRfm(rows: ChurnInputRow[], asOf: Date): ChurnScoreRow[] {
  const monetary = monetaryScores(rows);
  return rows.map((row, index) => {
    const recencyDays = Math.max(
      0,
      Math.floor((asOf.getTime() - row.lastCompletedAt.getTime()) / DAY)
    );
    const frequency = Math.max(0, Math.floor(row.frequency));
    const monetaryMinor = row.monetaryMinor < ZERO ? ZERO : row.monetaryMinor;
    const r = recencyScore(recencyDays);
    const f = frequencyScore(frequency);
    const m = monetary[index] ?? 3;
    const churnScore = combineChurnScore(r, f, m);
    return {
      customerId: row.customerId,
      modelVersion: CHURN_MODEL_VERSION,
      recencyDays,
      frequency,
      monetaryMinor,
      recencyScore: r,
      frequencyScore: f,
      monetaryScore: m,
      churnScore,
      riskBand: churnRiskBand(churnScore),
    };
  });
}
