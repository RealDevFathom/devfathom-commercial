import { Prisma } from '@/generated/prisma/browser';

/** Restaurant major-unit Decimal inputs, never Pharmacy minor-unit numbers. */
export type ContributionInputs = {
  unitPrice: string;
  unitVariableCost: string;
  quantity: string;
  discount: string;
  incrementalCost: string;
};

export type ContributionContext = {
  currency: string;
  branchId: string | null;
  from: string | null;
  to: string | null;
};

export type ContributionRequest = {
  baseline: ContributionInputs;
  scenario: ContributionInputs;
  context: ContributionContext;
};

export const CONTRIBUTION_DEFINITION =
  '(Unit price − per-unit discount − unit variable cost) × assumed quantity − incremental cost';
export const CONTRIBUTION_CONDITIONS =
  'Price, per-unit discount and variable cost stay constant at every quantity. Incremental cost is a one-time amount for the period. Whole units only; capacity and demand are not predicted. Excludes unentered costs, taxes and overhead; contribution is not net profit or cash. Volume is an assumption, not causal price elasticity.';

type Threshold = {
  status: 'reachable' | 'unreachable';
  quantity: string | null;
  reason: string;
};

// The canonical server money helper is server-only. Reuse its Prisma Decimal
// through the generated browser entry. Inputs are already 2dp and quantity is
// integer, so all money arithmetic is exact without another rounding function.
// Bounds keep products below Decimal's default 20 significant-digit precision.
function amounts(input: ContributionInputs) {
  const netUnitPrice = new Prisma.Decimal(input.unitPrice).minus(input.discount);
  const unitContribution = netUnitPrice.minus(input.unitVariableCost);
  return {
    netUnitPrice: netUnitPrice.toFixed(2),
    unitContribution: unitContribution.toFixed(2),
    revenue: netUnitPrice.times(input.quantity).toFixed(2),
    variableCost: new Prisma.Decimal(input.unitVariableCost).times(input.quantity).toFixed(2),
    contribution: unitContribution.times(input.quantity).minus(input.incrementalCost).toFixed(2),
  };
}

/** Minimum nonnegative whole units to meet a contribution target. */
function threshold(unitContribution: string, incrementalCost: string, target: string): Threshold {
  const required = new Prisma.Decimal(target).plus(incrementalCost);
  if (required.lte(0)) {
    return { status: 'reachable', quantity: '0', reason: 'Zero units already meets this target.' };
  }
  const unit = new Prisma.Decimal(unitContribution);
  if (unit.lte(0)) {
    return {
      status: 'unreachable',
      quantity: null,
      reason: 'Nonpositive contribution per unit cannot cover this target.',
    };
  }
  // Integer quotient + exact remainder avoids division rounding at a boundary.
  const quantity = required.divToInt(unit).plus(required.mod(unit).isZero() ? 0 : 1);
  return {
    status: 'reachable',
    quantity: quantity.toFixed(0),
    reason: quantity.gt('1000000')
      ? 'Mathematical threshold exceeds the calculator limit of 1,000,000 units; feasibility is unverified.'
      : 'Minimum whole units under constant assumptions; feasibility is unverified.',
  };
}

function validDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

export function calculateContributionScenario(request: ContributionRequest) {
  const errors: Record<string, string> = {};
  for (const side of ['baseline', 'scenario'] as const) {
    const input = request[side];
    for (const field of ['unitPrice', 'unitVariableCost', 'discount', 'incrementalCost'] as const) {
      if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(input[field])) {
        errors[`${side}.${field}`] =
          'Enter a known amount from 0 to 9,999,999,999.99 with at most 2 decimal places.';
      }
    }
    if (!/^\d{1,7}$/.test(input.quantity) || new Prisma.Decimal(input.quantity).gt('1000000')) {
      errors[`${side}.quantity`] = 'Enter a whole quantity from 0 to 1,000,000.';
    }
    if (
      !errors[`${side}.unitPrice`] &&
      !errors[`${side}.discount`] &&
      new Prisma.Decimal(input.discount).gt(input.unitPrice)
    ) {
      errors[`${side}.discount`] = 'Per-unit discount cannot exceed unit price.';
    }
  }
  const { context } = request;
  if (!/^[A-Z]{3}$/.test(context.currency)) {
    errors.currency = 'Enter the three-letter currency code for all assumptions, such as PKR.';
  }
  for (const field of ['from', 'to'] as const) {
    if (context[field] !== null && !validDate(context[field])) {
      errors.period = 'Select valid calendar dates in the Insights filters.';
    }
  }
  if (context.from && context.to && context.from > context.to) {
    errors.period = 'From date must be on or before To date in the Insights filters.';
  }
  if (Object.keys(errors).length) return { ok: false as const, errors };

  const baseline = amounts(request.baseline);
  const scenario = amounts(request.scenario);
  return {
    ok: true as const,
    evidence: {
      version: 'restaurant-contribution-scenario-v1' as const,
      basis: 'assumptions' as const,
      currency: context.currency,
      moneyUnit: 'decimal-major' as const,
      period: { from: context.from, to: context.to, basis: 'planning-assumption' as const },
      scope: { branchId: context.branchId, basis: 'manual scenario; no branch data read' as const },
      source: 'User-entered baseline and scenario; no observed margin baseline supplied.',
      coverage: 'Only entered price, discount, quantity, variable cost and incremental cost.',
      freshness: 'Manual input snapshot; no historical freshness claim.',
      definition: CONTRIBUTION_DEFINITION,
      conditions: CONTRIBUTION_CONDITIONS,
      baseline: { inputs: { ...request.baseline }, ...baseline },
      scenario: { inputs: { ...request.scenario }, ...scenario },
      change: {
        contribution: new Prisma.Decimal(scenario.contribution)
          .minus(baseline.contribution)
          .toFixed(2),
        revenue: new Prisma.Decimal(scenario.revenue).minus(baseline.revenue).toFixed(2),
      },
      breakEven: threshold(scenario.unitContribution, request.scenario.incrementalCost, '0'),
      matchBaseline: threshold(
        scenario.unitContribution,
        request.scenario.incrementalCost,
        baseline.contribution
      ),
    },
  };
}

/** Shared serializable evidence contract for UI export and a future authorized adapter. */
export type ContributionEvidence = Extract<
  ReturnType<typeof calculateContributionScenario>,
  { ok: true }
>['evidence'];
