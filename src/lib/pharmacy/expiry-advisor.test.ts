import { describe, expect, it } from 'vitest';

import { adviseExpiryLots, type ExpiryLotFact } from './expiry-advisor';

const at = new Date('2026-09-05T00:00:00.000Z');
const fact = (overrides: Partial<ExpiryLotFact> = {}): ExpiryLotFact => ({
  lotId: 'lot-1',
  branchId: 'branch-1',
  medicineName: 'Medicine',
  batchNumber: 'B-1',
  supplierId: 'supplier-1',
  supplierName: 'Supplier',
  stockLocationId: 'location-1',
  onHandUnits: 100,
  unitCostMinor: 500,
  expiresAt: new Date('2026-10-05T00:00:00.000Z'),
  soldUnits: 10,
  historyDays: 30,
  returnWindowDays: 45,
  coldChain: false,
  ...overrides,
});

describe('expiry and return advisor', () => {
  it('classifies only at-risk stock inside the recorded window as returnable', () => {
    expect(adviseExpiryLots([fact()], at)[0]).toMatchObject({
      classification: 'RETURNABLE',
      projectedUnsoldUnits: 90,
      valueAtRiskMinor: 45_000,
      proposalAllowed: true,
    });
    expect(adviseExpiryLots([fact({ returnWindowDays: 10 })], at)[0]?.classification).toBe(
      'AT_RISK'
    );
  });

  it('never fabricates a rate when the branch has no history', () => {
    expect(adviseExpiryLots([fact({ soldUnits: 0, historyDays: 0 })], at)[0]).toMatchObject({
      classification: 'INSUFFICIENT_HISTORY',
      observedUnitsPerDay: null,
      projectedClearAt: null,
      proposalAllowed: false,
    });
  });

  it('ranks by value at risk and blocks an unvalidated cold-chain return route', () => {
    const advice = adviseExpiryLots(
      [
        fact({ lotId: 'cheap', unitCostMinor: 10 }),
        fact({ lotId: 'valuable-cold', unitCostMinor: 1_000, coldChain: true }),
      ],
      at
    );
    expect(advice.map((item) => item.lotId)).toEqual(['valuable-cold', 'cheap']);
    expect(advice[0]).toMatchObject({ classification: 'RETURNABLE', proposalAllowed: false });
  });

  it('marks stock sellable when branch demand clears it before expiry', () => {
    expect(adviseExpiryLots([fact({ soldUnits: 150 })], at)[0]).toMatchObject({
      classification: 'SELLABLE',
      projectedUnsoldUnits: 0,
      valueAtRiskMinor: 0,
    });
  });
});

describe('no-expiry lots (QA-3)', () => {
  it('never prints the 9998-12-31 storage marker as an expiry or a return window', () => {
    const [advice] = adviseExpiryLots(
      [fact({ expiresAt: new Date('9998-12-31T19:00:00.000Z'), returnWindowDays: 45 })],
      at
    );
    expect(advice.explanation).toContain('expiry: none');
    expect(advice.explanation).toContain('supplier return window: none, the item has no expiry');
    expect(advice.explanation).not.toContain('9998');
    expect(advice.proposalAllowed).toBe(false);
  });
});

it('shows the projected clearance date at 00:30 in Karachi', () => {
  const [item] = adviseExpiryLots(
    [fact({ onHandUnits: 1, soldUnits: 30, historyDays: 30 })],
    new Date('2026-09-05T00:30:00+05:00'),
    'Asia/Karachi'
  );
  expect(item?.explanation).toContain('Projected clear: 2026-09-06');
});
