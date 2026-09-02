import { describe, expect, it } from 'vitest';

import {
  PharmacySaleError,
  priceFromLot,
  recoverDemandWithAlternate,
  returnSaleLine,
  validateDiscount,
} from './sales';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'user-a' };

describe('POS-03 lot-derived pack/strip/unit pricing', () => {
  it('derives a strip price from the allocated lot printed MRP', () => {
    expect(
      priceFromLot({
        printedMrpMinor: 1_003,
        canonicalUnitsInPack: 20,
        canonicalUnitsPerSaleUnit: 10,
        roundingIncrementMinor: 1,
      })
    ).toEqual({ unitPriceMinor: 500, proRataCeilingMinor: 500 });
  });

  it('rounds down and never exceeds the pro-rata ceiling', () => {
    const price = priceFromLot({
      printedMrpMinor: 1_000,
      canonicalUnitsInPack: 3,
      canonicalUnitsPerSaleUnit: 1,
      roundingIncrementMinor: 5,
    });
    expect(price).toEqual({ unitPriceMinor: 330, proRataCeilingMinor: 333 });
    expect(price.unitPriceMinor).toBeLessThanOrEqual(price.proRataCeilingMinor);
  });
});

describe('POS-04 discount guardrails', () => {
  it('fails closed for Rx/restricted/controlled medicine', () => {
    expect(() =>
      validateDiscount({
        regulated: true,
        discountMinor: 1,
        grossMinor: 100,
        costMinor: 20,
        approvedByUserId: 'manager',
        approvalPolicy: 'D06',
      })
    ).toThrow(new PharmacySaleError('REGULATED_DISCOUNT_REFUSED'));
  });

  it('requires attributable approval and refuses below-cost discounting', () => {
    expect(() =>
      validateDiscount({ regulated: false, discountMinor: 10, grossMinor: 100, costMinor: 20 })
    ).toThrow('APPROVAL_REQUIRED');
    expect(() =>
      validateDiscount({
        regulated: false,
        discountMinor: 90,
        grossMinor: 100,
        costMinor: 20,
        approvedByUserId: 'manager',
        approvalPolicy: 'standard',
      })
    ).toThrow('MARGIN_GUARDRAIL');
  });
});

describe('POS-06 linked returns', () => {
  it('refuses cumulative returns above the quantity sold', async () => {
    const db = {
      pharmacySaleLine: {
        findFirst: async () => ({
          id: 'line-a',
          saleId: 'sale-a',
          canonicalUnits: 10,
          sale: { status: 'COMPLETED' },
          allocations: [{ canonicalUnits: 10 }],
          returnLines: [{ canonicalUnits: 7 }],
        }),
      },
    };
    await expect(
      returnSaleLine(db as never, scope, {
        saleLineId: 'line-a',
        canonicalUnits: 4,
        quarantineLocationId: 'quarantine',
        reason: 'customer return',
        integrityDecision: 'seal unknown',
        idempotencyKey: 'return-a',
      })
    ).rejects.toThrow('RETURN_EXCEEDS_SOLD');
  });

  it('posts accepted returns only to QUARANTINE', async () => {
    const created: Array<Record<string, unknown>> = [];
    const model = {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: `new-${created.length}`, ...data };
      },
    };
    const db = {
      pharmacySaleLine: {
        findFirst: async () => ({
          id: 'line-a',
          saleId: 'sale-a',
          canonicalUnits: 10,
          sale: { status: 'COMPLETED' },
          allocations: [{ inventoryLotId: 'lot-a', canonicalUnits: 10 }],
          returnLines: [],
        }),
      },
      pharmacySaleReturn: model,
      pharmacyStockMovement: model,
      pharmacySaleReturnLine: model,
      pharmacySaleEvent: model,
    };
    await returnSaleLine(db as never, scope, {
      saleLineId: 'line-a',
      canonicalUnits: 2,
      quarantineLocationId: 'quarantine',
      reason: 'customer return',
      integrityDecision: 'seal unknown',
      idempotencyKey: 'return-a',
    });
    expect(created[1]).toMatchObject({
      kind: 'RETURN',
      disposition: 'QUARANTINE',
      quantityUnits: 2,
      stockLocationId: 'quarantine',
    });
  });
});

describe('POS-10 recovered alternate', () => {
  it('closes an explicit event only when the alternate belongs to the same sale', async () => {
    let update: unknown;
    const db = {
      unfulfilledDemandEvent: {
        findFirst: async () => ({ id: 'demand-a', saleId: 'sale-a' }),
        update: async (args: unknown) => {
          update = args;
          return args;
        },
      },
      pharmacySaleLine: { findFirst: async () => ({ id: 'line-a', saleId: 'sale-a' }) },
    };
    await recoverDemandWithAlternate(db as never, scope, 'demand-a', 'line-a');
    expect(update).toMatchObject({ data: { status: 'RECOVERED', recoveredSaleLineId: 'line-a' } });
  });
});
