import { describe, expect, it } from 'vitest';

import {
  diagnosticAmount,
  profitabilityDiagnostics,
  type ProfitabilityDiagnostics,
} from './profitability-diagnostics';

type Report = Extract<ProfitabilityDiagnostics, { status: 'ready' }>['report'];
const product = (
  productId: string,
  netSales: string,
  theoreticalCost: string
): Report['products'][number] => ({
  productId,
  productName: productId,
  categoryId: null,
  categoryName: 'Food',
  quantity: '2',
  netSales,
  theoreticalCost,
  foodCostPercent: '0',
  grossMargin: '0',
  marginPerItem: '0',
});
const report = (products: Report['products'] = []): Report => ({
  range: { from: '2026-09-01', to: '2026-09-12', branchIds: ['branch'] },
  products,
  uncostedProducts: [],
  truncated: false,
});

describe('profitabilityDiagnostics', () => {
  it('ranks largest known negative contributions, independently of supplied rounded margins', () => {
    const result = profitabilityDiagnostics(
      report([
        product('positive', '10', '1'),
        product('small', '10', '11'),
        product('large', '10', '30'),
      ])
    );
    expect(result.negative.map((row) => [row.productId, row.contribution])).toEqual([
      ['large', '-20'],
      ['small', '-1'],
    ]);
    expect(result.concentration).toBe('100.00');
  });
  it('aggregates multiple missing-cost reasons without ranking unknown costs as profit', () => {
    const input = report([product('mixed', '5', '1')]);
    input.uncostedProducts = [
      {
        productId: 'mixed',
        productName: 'Mixed',
        categoryName: 'Food',
        branchNames: 'Branch',
        quantity: '1',
        netSales: '10.10',
        reason: 'NO_RECIPE',
        missingIngredientCount: 0,
      },
      {
        productId: 'mixed',
        productName: 'Mixed',
        categoryName: 'Food',
        branchNames: 'Branch',
        quantity: '2',
        netSales: '20.20',
        reason: 'MISSING_INGREDIENT_COST',
        missingIngredientCount: 1,
      },
    ];
    const result = profitabilityDiagnostics(input);
    expect(result.negative).toEqual([]);
    expect(result.gaps[0]).toMatchObject({
      netSales: '30.3',
      quantity: '3',
      reasons: ['NO_RECIPE', 'MISSING_INGREDIENT_COST'],
    });
    expect(result.productCount).toBe(1);
    expect(result.gapCount).toBe(1);
  });
  it('keeps fraction precision for ranking and rounds HALF_UP only for display', () => {
    const result = profitabilityDiagnostics(
      report([product('a', '0.004', '0.01'), product('b', '0.003', '0.01')])
    );
    expect(result.negative.map((row) => row.contribution)).toEqual(['-0.007', '-0.006']);
    expect(result.negativeTotal).toBe('0.013');
    expect(diagnosticAmount('1.005', 'PKR')).toBe('PKR 1.01');
    expect(diagnosticAmount('9007199254740993.01', 'PKR')).toBe('PKR 9007199254740993.01');
    expect(diagnosticAmount('0', null)).toBe('Currency unknown 0.00');
  });
  it('bounds top rows and gives concentration against all returned negative magnitudes', () => {
    const input = report(
      Array.from({ length: 6 }, (_, index) => product(String(index), '0', String(index + 1)))
    );
    input.truncated = true;
    const result = profitabilityDiagnostics(input);
    expect(result.negative).toHaveLength(5);
    expect(result.topTotal).toBe('20');
    expect(result.negativeTotal).toBe('21');
    expect(result.concentration).toBe('95.24');
  });
  it('handles no data without manufacturing a concentration', () => {
    expect(profitabilityDiagnostics(report())).toMatchObject({
      concentration: null,
      productCount: 0,
      negative: [],
      gaps: [],
    });
  });
  it('rejects invalid dates and nonfinite amounts', () => {
    const input = report();
    input.range.to = '2026-08-01';
    expect(() => profitabilityDiagnostics(input)).toThrow();
    input.range.to = '2026-12-31';
    expect(() => profitabilityDiagnostics(input)).toThrow();
    expect(() => profitabilityDiagnostics(report([product('bad', 'NaN', '1')]))).toThrow();
  });
});
