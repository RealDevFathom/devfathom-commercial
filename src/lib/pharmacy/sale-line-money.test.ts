import { expect, it } from 'vitest';
import {
  apportionDiscount,
  priceReturn,
  returnedMoney,
  saleAllocationMoney,
} from './sale-line-money';

it('retains historical allocation attribution and uses new allocation snapshots', () => {
  const line = {
    quantity: 2,
    unitPriceMinor: 150,
    grossMinor: 300,
    canonicalUnits: 2,
    discountMinor: 3,
    allocations: [
      { id: 'cheap', canonicalUnits: 1, grossMinor: 100, discountMinor: 1 },
      { id: 'dear', canonicalUnits: 1, grossMinor: 200, discountMinor: 2 },
    ],
  };
  expect(saleAllocationMoney(line)).toEqual(line.allocations);
  expect(
    saleAllocationMoney({
      ...line,
      allocations: [
        { id: 'old-a', canonicalUnits: 1 },
        { id: 'old-b', canonicalUnits: 1 },
      ],
    })
  ).toEqual([
    { id: 'old-a', canonicalUnits: 1, grossMinor: 150, discountMinor: 1 },
    { id: 'old-b', canonicalUnits: 1, grossMinor: 150, discountMinor: 2 },
  ]);
});

it('keeps a full discount within every charged allocation, including zero-price shares', () => {
  expect(apportionDiscount(3, [0, 1, 2])).toEqual([0, 1, 2]);
  expect(apportionDiscount(2, [0, 1, 2])).toEqual([0, 0, 2]);
});

it('recovers cumulative net and discount rounding on partial allocation returns', () => {
  const line = {
    quantity: 1,
    unitPriceMinor: 102,
    grossMinor: 102,
    discountMinor: 2,
    canonicalUnits: 3,
    returnLines: [] as { canonicalUnits: number; grossMinor: number; discountMinor: number }[],
    unidentifiedReturnHolds: [],
  };
  const portions = [
    { grossMinor: 33, discountMinor: 0 },
    { grossMinor: 34, discountMinor: 1 },
    { grossMinor: 35, discountMinor: 1 },
  ];
  for (const charged of portions) {
    const snapshot = priceReturn(line, 1, charged);
    expect(snapshot).toEqual(charged);
    line.returnLines.push({ canonicalUnits: 1, ...snapshot });
  }
  expect(returnedMoney(line)).toEqual({ netMinor: 100, discountMinor: 2, units: 3 });
});

it('does not revalue prior unidentified returns or authorize more than the original net', () => {
  const line = {
    quantity: 3,
    unitPriceMinor: 200,
    grossMinor: 600,
    discountMinor: 0,
    canonicalUnits: 3,
    returnLines: [] as { canonicalUnits: number; grossMinor: number; discountMinor: number }[],
    unidentifiedReturnHolds: [] as {
      canonicalUnits: number;
      grossMinor: number;
      discountMinor: number;
    }[],
  };
  const hold = priceReturn(line, 1);
  expect(hold.grossMinor).toBe(200);
  line.unidentifiedReturnHolds.push({ canonicalUnits: 1, ...hold });
  const cheap = priceReturn(line, 1, { grossMinor: 100, discountMinor: 0 });
  expect(cheap.grossMinor).toBe(100);
  line.returnLines.push({ canonicalUnits: 1, ...cheap });
  const final = priceReturn(line, 1, { grossMinor: 400, discountMinor: 0 });
  expect(final.grossMinor).toBe(300);
  line.returnLines.push({ canonicalUnits: 1, ...final });
  expect(returnedMoney(line).netMinor).toBe(600);
  expect(hold.grossMinor).toBe(200);
});
