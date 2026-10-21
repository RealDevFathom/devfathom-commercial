import { describe, expect, it } from 'vitest';

import { multiply, sub } from './money';
import {
  calculateContributionScenario,
  type ContributionInputs,
  type ContributionRequest,
} from './contribution-scenario';

const baseline: ContributionInputs = {
  unitPrice: '100',
  unitVariableCost: '60',
  quantity: '100',
  discount: '0',
  incrementalCost: '0',
};
const request: ContributionRequest = {
  baseline,
  scenario: { ...baseline },
  context: { currency: 'PKR', branchId: 'branch_1', from: '2026-09-01', to: '2026-09-30' },
};

function calculate(scenario: Partial<ContributionInputs> = {}) {
  const result = calculateContributionScenario({
    ...request,
    scenario: { ...baseline, ...scenario },
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.evidence;
}

describe('Restaurant contribution scenarios', () => {
  it('matches canonical Decimal major arithmetic exactly for the baseline', () => {
    const result = calculate();
    expect(result.baseline.contribution).toBe('4000.00');
    expect(result.baseline.contribution).toBe(multiply(sub('100', '60'), '100').toFixed(2));
    expect(result.change.contribution).toBe('0.00');
  });

  it('shows lower contribution despite higher revenue after a discount', () => {
    const result = calculate({ discount: '10', quantity: '120' });
    expect(result.scenario.contribution).toBe('3600.00');
    expect(result.scenario.revenue).toBe('10800.00');
    expect(result.change).toEqual({ contribution: '-400.00', revenue: '800.00' });
    expect(result.matchBaseline.quantity).toBe('134');
    expect(result.breakEven.quantity).toBe('0');
  });

  it('labels higher-price and lower-volume results as conditional assumptions', () => {
    const result = calculate({ unitPrice: '110', quantity: '90' });
    expect(result.scenario.contribution).toBe('4500.00');
    expect(result.change.contribution).toBe('500.00');
    expect(result.matchBaseline.quantity).toBe('80');
    expect(result.basis).toBe('assumptions');
    expect(result.conditions).toContain('Volume is an assumption, not causal price elasticity');
  });

  it('subtracts incremental costs once and ceilings the break-even threshold', () => {
    const result = calculate({ incrementalCost: '100.01' });
    expect(result.scenario.contribution).toBe('3899.99');
    expect(result.breakEven.quantity).toBe('3');
    expect(result.matchBaseline.quantity).toBe('103');
  });

  it('preserves cent precision and an exact integer threshold', () => {
    const result = calculate({
      unitPrice: '0.30',
      unitVariableCost: '0.10',
      discount: '0.10',
      quantity: '3',
      incrementalCost: '0.30',
    });
    expect(result.scenario.contribution).toBe('0.00');
    expect(result.breakEven.quantity).toBe('3');
  });

  it.each(['60', '50'])('reports an unreachable positive target for unit price %s', (unitPrice) => {
    const result = calculate({ unitPrice, incrementalCost: '1' });
    expect(result.breakEven).toMatchObject({ status: 'unreachable', quantity: null });
    expect(result.matchBaseline).toMatchObject({ status: 'unreachable', quantity: null });
  });

  it('allows explicit zero and zero-volume contribution without inventing cost', () => {
    const result = calculate({ unitPrice: '0', unitVariableCost: '0', quantity: '0' });
    expect(result.scenario.contribution).toBe('0.00');
    expect(result.breakEven.quantity).toBe('0');
    expect(result.matchBaseline.status).toBe('unreachable');
  });

  it.each(['', '-1', 'NaN', 'Infinity', '1e2', '0.001', '10000000000', ' 60 ', '60,00'])(
    'rejects unknown or invalid cost %j instead of substituting zero',
    (unitVariableCost) => {
      const result = calculateContributionScenario({
        ...request,
        scenario: { ...baseline, unitVariableCost },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors['scenario.unitVariableCost']).toBeTruthy();
    }
  );

  it.each(['-1', '0.5', '1000001', '', 'Infinity'])(
    'bounds whole-unit quantities: %j',
    (quantity) => {
      const result = calculateContributionScenario({
        ...request,
        baseline: { ...baseline, quantity },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors['baseline.quantity']).toBeTruthy();
    }
  );

  it('rejects discount above price and a missing incremental cost', () => {
    const result = calculateContributionScenario({
      ...request,
      scenario: { ...baseline, discount: '101', incrementalCost: '' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors['scenario.discount']).toContain('cannot exceed');
      expect(result.errors['scenario.incrementalCost']).toBeTruthy();
    }
  });

  it('keeps maximum supported arithmetic exact and flags infeasible-size thresholds', () => {
    const result = calculate({
      unitPrice: '9999999999.99',
      unitVariableCost: '0',
      quantity: '1000000',
    });
    expect(result.scenario.contribution).toBe('9999999999990000.00');
    const smallMargin = calculate({ unitPrice: '60.01', incrementalCost: '9999999999.99' });
    expect(smallMargin.breakEven.quantity).toBe('999999999999');
    expect(smallMargin.breakEven.reason).toContain('exceeds the calculator limit');
  });

  it.each([{ currency: '' }, { from: '2026-02-30' }, { from: '2026-10-01' }, { to: 'invalid' }])(
    'validates context %j',
    (context) => {
      expect(
        calculateContributionScenario({ ...request, context: { ...request.context, ...context } })
          .ok
      ).toBe(false);
    }
  );

  it('exports an immutable input snapshot with scope, period, currency, definition and evidence limits', () => {
    const input = structuredClone(request);
    const result = calculateContributionScenario(input);
    if (!result.ok) throw new Error('Expected valid fixture');
    input.scenario.unitPrice = '999';
    const evidence = JSON.parse(JSON.stringify(result.evidence));
    expect(evidence.scenario.inputs.unitPrice).toBe('100');
    expect(evidence).toMatchObject({
      currency: 'PKR',
      moneyUnit: 'decimal-major',
      basis: 'assumptions',
      period: { from: '2026-09-01', to: '2026-09-30', basis: 'planning-assumption' },
      scope: { branchId: 'branch_1' },
    });
    expect(evidence.source).toContain('no observed margin baseline');
    expect(evidence.coverage).toContain('Only entered');
    expect(evidence.freshness).toContain('no historical freshness claim');
    expect(evidence.definition).toContain('incremental cost');
  });
});
