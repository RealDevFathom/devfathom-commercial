import { describe, expect, it } from 'vitest';
import { returnedSaleLineMoney } from './sale-pricing';

const line = {
  quantity: 2,
  canonicalUnits: 2,
  unitPriceMinor: 200,
  discountMinor: 0,
  allocations: [
    { inventoryLotId: 'cheap', canonicalUnits: 1, unitPriceMinor: 100 },
    { inventoryLotId: 'dear', canonicalUnits: 1, unitPriceMinor: 300 },
  ],
  returnLines: [] as Array<{ inventoryLotId: string; canonicalUnits: number }>,
  unidentifiedReturnHolds: [] as Array<{ canonicalUnits: number }>,
};

describe('mixed-lot return valuation', () => {
  it.each([
    ['cheap', 100],
    ['dear', 300],
  ] as const)('values the returned %s lot at its issued price', (inventoryLotId, expected) => {
    expect(
      returnedSaleLineMoney({ ...line, returnLines: [{ inventoryLotId, canonicalUnits: 1 }] })
    ).toEqual({ grossMinor: expected, discountMinor: 0, netMinor: expected });
  });

  it('apportions an approved discount over the actual returned value', () => {
    expect(
      returnedSaleLineMoney({
        ...line,
        discountMinor: 4,
        returnLines: [{ inventoryLotId: 'cheap', canonicalUnits: 1 }],
      })
    ).toEqual({ grossMinor: 100, discountMinor: 1, netMinor: 99 });
  });

  it('keeps legacy receipts on their original pro-rata pricing', () => {
    expect(
      returnedSaleLineMoney({
        ...line,
        allocations: line.allocations.map((row) => ({ ...row, unitPriceMinor: null })),
        returnLines: [{ inventoryLotId: 'cheap', canonicalUnits: 1 }],
      }).netMinor
    ).toBe(200);
  });

  it.each(['cheap', 'dear'])(
    'bounds unidentified plus %s returns by the entire paid line',
    (inventoryLotId) => {
      const returned = {
        ...line,
        priceAdjustmentMinor: 1,
        discountMinor: 2,
        unidentifiedReturnHolds: [{ canonicalUnits: 1 }],
      };
      expect(returnedSaleLineMoney(returned).netMinor).toBeLessThanOrEqual(397);
      expect(
        returnedSaleLineMoney({ ...returned, returnLines: [{ inventoryLotId, canonicalUnits: 1 }] })
          .netMinor
      ).toBe(397);
    }
  );
});

it.each(['cheap', 'dear'])(
  'fully returns an odd mixed-lot total with discount, %s lot first',
  (lotId) => {
    const priced = {
      ...line,
      unitPriceMinor: 101,
      priceAdjustmentMinor: 1,
      discountMinor: 3,
      allocations: [
        { inventoryLotId: 'cheap', canonicalUnits: 1, unitPriceMinor: 100 },
        { inventoryLotId: 'dear', canonicalUnits: 1, unitPriceMinor: 101 },
      ],
    };
    const first = returnedSaleLineMoney({
      ...priced,
      returnLines: [{ inventoryLotId: lotId, canonicalUnits: 1 }],
    });
    expect(first).toEqual(
      lotId === 'cheap'
        ? { grossMinor: 100, discountMinor: 2, netMinor: 98 }
        : { grossMinor: 101, discountMinor: 2, netMinor: 99 }
    );
    expect(
      returnedSaleLineMoney({
        ...priced,
        returnLines: priced.allocations.map(({ inventoryLotId, canonicalUnits }) => ({
          inventoryLotId,
          canonicalUnits,
        })),
      })
    ).toEqual({ grossMinor: 201, discountMinor: 3, netMinor: 198 });
  }
);
