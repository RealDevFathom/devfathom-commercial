/**
 * #709 — the FBR "Am I Tier-1?" self-check.
 *
 * A pure, dependency-free evaluator shared by the router (which is the only
 * place a result is ever decided and stored) and the wizard (which shows the
 * same criteria and citations the stored result was decided against).
 *
 * The rules, and why they are shaped this way:
 *
 * - **Any one confirmed criterion alone makes the retailer Tier-1.** The FBR
 *   POS booklet lists them as alternatives, not a scorecard.
 * - **"I don't know" is never "no".** An unanswered criterion with no "yes"
 *   elsewhere returns UNSURE ("ask your tax adviser"), never NOT_TIER_1.
 * - **An unconfirmed criterion never decides Tier-1 on its own.** The reported
 *   Finance Act 2026 turnover test is a vendor claim FBR has not confirmed, so a
 *   turnover above it returns UNSURE until `confirmed` is set from an FBR source.
 * - **This is not tax advice.** The disclaimer travels with every result.
 */

export const FBR_TIER1_CHECK_ACTION = 'pharmacy.fbrTier1Check';
export const FBR_TIER1_CHECK_TARGET_TYPE = 'FbrTier1SelfCheck';
/** The check is asked again this many months after the last answer. */
export const FBR_TIER1_RECHECK_MONTHS = 12;
/** Bumped whenever a criterion, threshold or source changes. */
export const FBR_TIER1_RULES_VERSION = '2026-10-31';

/** Rs 1.2 million over the preceding 12 consecutive months. */
export const FBR_TIER1_ELECTRICITY_THRESHOLD_RUPEES = 1_200_000;
/** The reported (unconfirmed) Finance Act 2026 turnover test: Rs 200 million. */
export const FBR_TIER1_TURNOVER_THRESHOLD_RUPEES = 200_000_000;
/** Upper bound for rupee answers; anything larger is a typing error. */
export const FBR_TIER1_MAX_RUPEES = 1_000_000_000_000;

export const FBR_TIER1_DISCLAIMER =
  'This self-check is guidance only and is not tax advice. FBR decides who is a Tier-1 retailer; confirm your status with your tax adviser or FBR before relying on it.';

export type FbrTier1Answer = 'YES' | 'NO' | 'UNSURE';
export type FbrTier1Result = 'TIER_1' | 'NOT_TIER_1' | 'UNSURE';
export type FbrTier1CriterionKey =
  | 'chainOutlet'
  | 'airConditionedMallOrPlaza'
  | 'electricityBill12Months'
  | 'wholesaleAndRetail'
  | 'annualTurnover';
export type FbrTier1CriterionOutcome = 'MET' | 'NOT_MET' | 'UNKNOWN';

export type FbrTier1Answers = {
  chainOutlet: FbrTier1Answer;
  airConditionedMallOrPlaza: FbrTier1Answer;
  /** Total electricity billed over the last 12 months, whole rupees; null = not known. */
  electricityBillRupees12Months: number | null;
  wholesaleAndRetail: FbrTier1Answer;
  /** Annual turnover, whole rupees; null = not known. */
  annualTurnoverRupees: number | null;
};

export type FbrTier1Source = {
  title: string;
  url: string;
  /** ISO date of the source document (or of access, for a web claim). */
  date: string;
  /** FACT for an FBR publication, VENDOR_CLAIM for an unconfirmed third-party statement. */
  kind: 'FACT' | 'VENDOR_CLAIM';
};

export type FbrTier1Criterion = {
  key: FbrTier1CriterionKey;
  question: string;
  help: string;
  /** False when the criterion is not confirmed by FBR; it can then only yield UNSURE. */
  confirmed: boolean;
  source: FbrTier1Source;
};

const FBR_POS_BOOKLET: FbrTier1Source = {
  title: 'FBR Point of Sale (POS) Integration booklet',
  url: 'https://download1.fbr.gov.pk/Docs/202551615541769POSBooklet.pdf',
  date: '2025-05-16',
  kind: 'FACT',
};

const TURNOVER_VENDOR_CLAIM: FbrTier1Source = {
  title: 'Reported Finance Act 2026 turnover test (not confirmed by FBR)',
  url: 'https://medipos.pk',
  date: '2026-10-28',
  kind: 'VENDOR_CLAIM',
};

export const FBR_TIER1_CRITERIA: readonly FbrTier1Criterion[] = [
  {
    key: 'chainOutlet',
    question: 'Is this store an outlet of a national or international chain of stores?',
    help: 'A franchise or branch trading under a chain’s name counts.',
    confirmed: true,
    source: FBR_POS_BOOKLET,
  },
  {
    key: 'airConditionedMallOrPlaza',
    question: 'Is the store inside an air-conditioned shopping mall, plaza or centre?',
    help: 'A kiosk in a mall is treated differently — answer “Not sure” if that is you.',
    confirmed: true,
    source: FBR_POS_BOOKLET,
  },
  {
    key: 'electricityBill12Months',
    question: 'What was the total electricity bill for the last 12 months, in rupees?',
    help: 'Add up the last 12 monthly bills. Tier-1 applies above Rs 1,200,000.',
    confirmed: true,
    source: FBR_POS_BOOKLET,
  },
  {
    key: 'wholesaleAndRetail',
    question:
      'Do you also sell wholesale — supplying other retailers as well as selling to customers?',
    help: 'A wholesaler-cum-retailer is Tier-1 whatever its size.',
    confirmed: true,
    source: FBR_POS_BOOKLET,
  },
  {
    key: 'annualTurnover',
    question: 'What was the business’s turnover for the last 12 months, in rupees?',
    help: 'A Rs 200 million turnover test has been reported for Finance Act 2026 but FBR has not confirmed it, so a turnover above it is reported as “Unsure”.',
    confirmed: false,
    source: TURNOVER_VENDOR_CLAIM,
  },
];

export type FbrTier1CriterionEvaluation = {
  key: FbrTier1CriterionKey;
  outcome: FbrTier1CriterionOutcome;
  confirmed: boolean;
  source: FbrTier1Source;
};

export type FbrTier1Evaluation = {
  result: FbrTier1Result;
  headline: string;
  criteria: FbrTier1CriterionEvaluation[];
  rulesVersion: string;
  disclaimer: string;
};

export const FBR_TIER1_HEADLINES: Record<FbrTier1Result, string> = {
  TIER_1: 'Tier-1: FBR integration required',
  NOT_TIER_1: 'Not Tier-1',
  UNSURE: 'Unsure: ask your tax adviser',
};

function fromAnswer(answer: FbrTier1Answer): FbrTier1CriterionOutcome {
  if (answer === 'YES') return 'MET';
  if (answer === 'NO') return 'NOT_MET';
  return 'UNKNOWN';
}

function fromAmount(amount: number | null, threshold: number): FbrTier1CriterionOutcome {
  if (amount === null || !Number.isFinite(amount) || amount < 0) return 'UNKNOWN';
  return amount > threshold ? 'MET' : 'NOT_MET';
}

export function criterionOutcome(
  key: FbrTier1CriterionKey,
  answers: FbrTier1Answers
): FbrTier1CriterionOutcome {
  switch (key) {
    case 'chainOutlet':
      return fromAnswer(answers.chainOutlet);
    case 'airConditionedMallOrPlaza':
      return fromAnswer(answers.airConditionedMallOrPlaza);
    case 'electricityBill12Months':
      return fromAmount(
        answers.electricityBillRupees12Months,
        FBR_TIER1_ELECTRICITY_THRESHOLD_RUPEES
      );
    case 'wholesaleAndRetail':
      return fromAnswer(answers.wholesaleAndRetail);
    case 'annualTurnover':
      return fromAmount(answers.annualTurnoverRupees, FBR_TIER1_TURNOVER_THRESHOLD_RUPEES);
  }
}

export function evaluateFbrTier1(
  answers: FbrTier1Answers,
  criteria: readonly FbrTier1Criterion[] = FBR_TIER1_CRITERIA
): FbrTier1Evaluation {
  const evaluated = criteria.map((criterion) => ({
    key: criterion.key,
    outcome: criterionOutcome(criterion.key, answers),
    confirmed: criterion.confirmed,
    source: criterion.source,
  }));
  const result: FbrTier1Result = evaluated.some(
    (criterion) => criterion.confirmed && criterion.outcome === 'MET'
  )
    ? 'TIER_1'
    : evaluated.some((criterion) => criterion.outcome !== 'NOT_MET')
      ? 'UNSURE'
      : 'NOT_TIER_1';
  return {
    result,
    headline: FBR_TIER1_HEADLINES[result],
    criteria: evaluated,
    rulesVersion: FBR_TIER1_RULES_VERSION,
    disclaimer: FBR_TIER1_DISCLAIMER,
  };
}

/** When the self-check must be asked again: 12 calendar months after it was answered. */
export function fbrTier1RecheckDueAt(assessedAt: Date): Date {
  const due = new Date(assessedAt);
  const day = due.getUTCDate();
  due.setUTCDate(1);
  due.setUTCMonth(due.getUTCMonth() + FBR_TIER1_RECHECK_MONTHS);
  // Clamp 29 Feb (and similar) to the last day of the target month.
  const lastDay = new Date(
    Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + 1, 0)
  ).getUTCDate();
  due.setUTCDate(Math.min(day, lastDay));
  return due;
}

export function isFbrTier1RecheckDue(assessedAt: Date | null, now: Date): boolean {
  if (!assessedAt) return true;
  return now.getTime() >= fbrTier1RecheckDueAt(assessedAt).getTime();
}

const ANSWERS = new Set<FbrTier1Answer>(['YES', 'NO', 'UNSURE']);

function readAmount(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Read answers back out of a stored audit row. Returns null for anything that
 * is not a complete, well-formed set, so a malformed row is treated as "never
 * asked" rather than trusted.
 */
export function parseStoredFbrTier1Answers(value: unknown): FbrTier1Answers | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const choice = (key: string) =>
    typeof record[key] === 'string' && ANSWERS.has(record[key] as FbrTier1Answer)
      ? (record[key] as FbrTier1Answer)
      : undefined;
  const chainOutlet = choice('chainOutlet');
  const airConditionedMallOrPlaza = choice('airConditionedMallOrPlaza');
  const wholesaleAndRetail = choice('wholesaleAndRetail');
  const electricityBillRupees12Months = readAmount(record.electricityBillRupees12Months);
  const annualTurnoverRupees = readAmount(record.annualTurnoverRupees);
  if (
    !chainOutlet ||
    !airConditionedMallOrPlaza ||
    !wholesaleAndRetail ||
    electricityBillRupees12Months === undefined ||
    annualTurnoverRupees === undefined
  )
    return null;
  return {
    chainOutlet,
    airConditionedMallOrPlaza,
    electricityBillRupees12Months,
    wholesaleAndRetail,
    annualTurnoverRupees,
  };
}
