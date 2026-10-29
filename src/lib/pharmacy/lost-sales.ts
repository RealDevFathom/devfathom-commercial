export const UNKNOWN_LOSS_PROBABILITY_ESTIMATE = 0.43;
export const MEASURED_RATE_MINIMUM_EVENTS = 200;
export const WILL_RETURN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const VISIT_WINDOW_MS = 10 * 60 * 1000;

export type LostSaleOutcome =
  | 'SUBSTITUTE_TAKEN'
  | 'WILL_RETURN'
  | 'WENT_ELSEWHERE'
  | 'ORDERED_FOR_CUSTOMER'
  | 'UNKNOWN';

export function outcomeLossProbability(
  outcome: LostSaleOutcome,
  options: {
    capturedAt?: Date;
    now?: Date;
    matchingSaleFound?: boolean;
    unknownProbability: number;
  }
) {
  if (outcome === 'SUBSTITUTE_TAKEN' || outcome === 'ORDERED_FOR_CUSTOMER') return 0;
  if (outcome === 'WENT_ELSEWHERE') return 1;
  if (outcome === 'UNKNOWN') return options.unknownProbability;
  const capturedAt = options.capturedAt ?? new Date();
  const now = options.now ?? capturedAt;
  return !options.matchingSaleFound && now.getTime() - capturedAt.getTime() >= WILL_RETURN_WINDOW_MS
    ? 1
    : 0;
}

export function effectiveUnknownProbability(input: {
  configuredEstimate: number;
  knownOutcomes: number;
  knownLostOutcomes: number;
  minimumKnownOutcomes?: number;
}) {
  const minimum = input.minimumKnownOutcomes ?? MEASURED_RATE_MINIMUM_EVENTS;
  return input.knownOutcomes >= minimum
    ? input.knownLostOutcomes / input.knownOutcomes
    : input.configuredEstimate;
}

export function estimatedLossPkr(quantity: number, unitPricePkr: number, probability: number) {
  return Math.round(quantity * unitPricePkr * probability * 100) / 100;
}

export function belongsToVisit(
  candidate: { terminalId: string; customerId?: string | null; createdAt: Date },
  current: { terminalId: string; customerId?: string | null; createdAt: Date }
) {
  return (
    candidate.terminalId === current.terminalId &&
    (candidate.customerId ?? null) === (current.customerId ?? null) &&
    Math.abs(current.createdAt.getTime() - candidate.createdAt.getTime()) <= VISIT_WINDOW_MS
  );
}
