import { describe, expect, it, vi } from 'vitest';

import {
  addSaleLine,
  addRestockInterest,
  captureSafeRestockArrival,
  changeSaleStatus,
  PharmacySaleError,
  priceFromLot,
  recoverDemandWithAlternate,
  recoverRestockInterest,
  returnSaleLine,
  validateDiscount,
} from './sales';

// Finance posting is outside these physical return-disposition assertions.
vi.mock('./finance-postings', async () => ({
  ...(await vi.importActual<typeof import('./finance-postings')>('./finance-postings')),
  postSaleReturnEntry: vi.fn(async () => undefined),
}));

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'user-a' };

describe('POS sale voiding', () => {
  it('restores exact allocated canonical units once with append-only reversals', async () => {
    let status = 'OPEN';
    const originals = [
      {
        id: 'sale-movement-a',
        inventoryLotId: 'lot-a',
        stockLocationId: 'shelf-a',
        disposition: 'AVAILABLE',
        quantityUnits: -7,
        sealedPackDelta: 0,
        looseUnitDelta: -7,
        idempotencyKey: 'sale:line-a:0',
      },
      {
        id: 'sale-movement-b',
        inventoryLotId: 'lot-b',
        stockLocationId: 'shelf-b',
        disposition: 'AVAILABLE',
        quantityUnits: -5,
        sealedPackDelta: -1,
        looseUnitDelta: 0,
        idempotencyKey: 'sale:line-a:1',
      },
    ];
    const reversals: Array<Record<string, unknown>> = [];
    let allocationQuery: Record<string, unknown> | undefined;
    const db = {
      pharmacySale: {
        findFirst: async () => ({ id: 'sale-a', status, lines: [] }),
        // Keeps this regression runnable against the original implementation:
        // baseline reaches reversal assertions and fails on missing behavior,
        // rather than failing because its former update method is absent.
        update: async ({ data }: { data: { status: string } }) => {
          status = data.status;
          return { id: 'sale-a', status };
        },
        updateMany: async ({
          where,
          data,
        }: {
          where: { status: string };
          data: { status: string };
        }) => {
          if (status !== where.status) return { count: 0 };
          status = data.status;
          return { count: 1 };
        },
      },
      pharmacySaleLineAllocation: {
        findMany: async (query: Record<string, unknown>) => {
          allocationQuery = query;
          return originals.map((movement) => ({ stockMovementId: movement.id }));
        },
      },
      pharmacyStockMovement: {
        findFirst: async ({ where }: { where: { id: string } }) =>
          originals.find((movement) => movement.id === where.id) ?? null,
        findMany: async () => originals,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          reversals.push(data);
          return { id: `reversal-${reversals.length}`, ...data };
        },
      },
      pharmacyControlledRegisterEntry: { findMany: async () => [] },
      pharmacySaleEvent: { create: async ({ data }: { data: Record<string, unknown> }) => data },
    };

    await changeSaleStatus(db as never, scope, 'sale-a', 'void', 'Customer cancelled');

    expect(allocationQuery).toMatchObject({
      where: {
        organizationId: 'org-a',
        branchId: 'branch-a',
        saleLine: { saleId: 'sale-a' },
      },
      select: { stockMovementId: true },
    });
    expect(originals.map((movement) => movement.quantityUnits)).toEqual([-7, -5]);
    expect(reversals).toEqual([
      expect.objectContaining({
        reversesMovementId: 'sale-movement-a',
        quantityUnits: 7,
        looseUnitDelta: 7,
      }),
      expect.objectContaining({
        reversesMovementId: 'sale-movement-b',
        quantityUnits: 5,
        sealedPackDelta: 1,
      }),
    ]);
    expect(Math.abs(Number(reversals[0]?.sealedPackDelta))).toBe(0);
    expect(Math.abs(Number(reversals[1]?.looseUnitDelta))).toBe(0);
    expect(reversals.reduce((units, movement) => units + Number(movement.quantityUnits), 0)).toBe(
      12
    );

    await expect(changeSaleStatus(db as never, scope, 'sale-a', 'void')).rejects.toThrow(
      'INVALID_STATE'
    );
    expect(reversals).toHaveLength(2);
  });

  it('gives a completed sale a receipt number', async () => {
    const sale = {
      id: 'sale-a',
      status: 'OPEN',
      receiptNumber: null as number | null,
      receiptDeviceId: null as string | null,
      businessDate: null as Date | null,
    };
    const db = {
      pharmacySale: {
        findFirst: async () => sale,
        updateMany: async () => {
          sale.status = 'COMPLETED';
          return { count: 1 };
        },
        update: async ({
          data,
        }: {
          data: { receiptNumber: number; receiptDeviceId: string; businessDate: Date };
        }) => {
          Object.assign(sale, data);
          return sale;
        },
      },
      $queryRaw: async () => [{ receipt_number: 7 }],
      pharmacySaleEvent: { create: async ({ data }: { data: Record<string, unknown> }) => data },
    };
    const completed = await changeSaleStatus(
      db as never,
      scope,
      'sale-a',
      'complete',
      undefined,
      'counter-1'
    );
    expect(completed).toMatchObject({
      status: 'COMPLETED',
      receiptNumber: 7,
      receiptDeviceId: 'counter-1',
    });
  });

  it('stops a losing add-line race before stock allocation', async () => {
    let medicineReads = 0;
    const db = {
      pharmacySale: {
        findFirst: async () => ({ id: 'sale-a', status: 'OPEN' }),
        updateMany: async () => ({ count: 0 }),
      },
      medicine: {
        findFirst: async () => {
          medicineReads += 1;
          return null;
        },
      },
    };

    await expect(
      addSaleLine(db as never, scope, {
        saleId: 'sale-a',
        medicineId: 'medicine-a',
        presentationId: 'presentation-a',
        packLevelId: 'pack-level-a',
        saleUnit: 'UNIT',
        quantity: 1,
        canonicalUnitsPerSaleUnit: 1,
        idempotencyKey: 'line-a',
      })
    ).rejects.toThrow('INVALID_STATE');
    expect(medicineReads).toBe(0);
  });
});

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

describe('DEM-03 restock interest', () => {
  it('refuses a contact when current reminders consent is not granted', async () => {
    const db = {
      unfulfilledDemandEvent: { findFirst: async () => ({ id: 'demand-a' }) },
      patientConsent: { findFirst: async () => ({ granted: false, revokedAt: null }) },
    };
    await expect(
      addRestockInterest(db as never, scope, {
        demandEventId: 'demand-a',
        patientId: 'patient-a',
        channel: 'WHATSAPP',
        quantityUnits: 2,
      })
    ).rejects.toThrow('CONSENT_REQUIRED');
  });

  it.each([
    {
      receivedAt: new Date(),
      state: 'ACTIVE',
      expiresAt: new Date('2026-01-01'),
      disposition: 'AVAILABLE',
    },
    {
      receivedAt: new Date(),
      state: 'ACTIVE',
      expiresAt: new Date('2027-01-01'),
      disposition: 'QUARANTINE',
    },
  ])(
    'does not queue for expired or quarantined arrivals',
    async ({ receivedAt, state, expiresAt, disposition }) => {
      let notifications = 0;
      const db = {
        pharmacyInventoryLot: {
          findFirst: async () => ({
            id: 'lot-a',
            receivedAt,
            batch: { medicineId: 'med-a', state, expiresAt },
            balances: disposition === 'AVAILABLE' ? [{ stockLocationId: 'shelf-a' }] : [],
          }),
        },
        pharmacyRestockNotification: {
          create: async () => {
            notifications += 1;
          },
        },
      };
      await expect(
        captureSafeRestockArrival(db as never, scope, {
          inventoryLotId: 'lot-a',
          at: new Date('2026-06-01'),
        })
      ).rejects.toThrow('UNSAFE_STOCK');
      expect(notifications).toBe(0);
    }
  );

  it('attributes the completed receipt to the originating event and interest', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const db = {
      pharmacyRestockInterest: {
        findFirst: async () => ({
          id: 'interest-a',
          demandEventId: 'demand-a',
          demandEvent: { requestedMedicineId: 'med-a' },
        }),
        update: async (args: { data: Record<string, unknown> }) => {
          writes.push(args.data);
          return { ...args.data, recoveredSale: { receiptNumber: 42 } };
        },
      },
      pharmacySaleLine: {
        findFirst: async () => ({
          id: 'line-a',
          saleId: 'sale-a',
          medicineId: 'med-a',
          sale: { status: 'COMPLETED', receiptNumber: 42 },
        }),
      },
      unfulfilledDemandEvent: {
        update: async (args: { data: Record<string, unknown> }) => {
          writes.push(args.data);
          return args;
        },
      },
      pharmacyRestockReservation: { updateMany: async () => ({ count: 1 }) },
    };
    const result = await recoverRestockInterest(db as never, scope, {
      interestId: 'interest-a',
      saleLineId: 'line-a',
    });
    expect(writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'RECOVERED', recoveredSaleLineId: 'line-a' }),
        expect.objectContaining({
          status: 'RECOVERED',
          recoveredSaleId: 'sale-a',
          recoveredSaleLineId: 'line-a',
        }),
      ])
    );
    expect(result).toMatchObject({ recoveredSale: { receiptNumber: 42 } });
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
      $queryRaw: vi.fn().mockResolvedValue([]),
      pharmacySaleEvent: { findFirst: vi.fn().mockResolvedValue(null) },
      pharmacySaleLine: {
        findFirst: async () => ({
          id: 'line-a',
          saleId: 'sale-a',
          canonicalUnits: 10,
          sale: { status: 'COMPLETED' },
          medicine: { controlled: false },
          allocations: [{ canonicalUnits: 10 }],
          unidentifiedReturnHolds: [],
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
        return {
          id: `new-${created.length}`,
          createdAt: new Date('2026-09-04T10:00:00Z'),
          ...data,
        };
      },
    };
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      pharmacyStockLocation: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'quarantine',
          organizationId: 'org-a',
          branchId: 'branch-a',
          active: true,
          kind: 'QUARANTINE',
        }),
      },
      pharmacySaleLine: {
        findFirst: async () => ({
          id: 'line-a',
          saleId: 'sale-a',
          canonicalUnits: 10,
          sale: { status: 'COMPLETED' },
          medicine: { controlled: false },
          allocations: [{ id: 'allocation-a', inventoryLotId: 'lot-a', canonicalUnits: 10 }],
          unidentifiedReturnHolds: [],
          returnLines: [],
        }),
      },
      pharmacySaleReturn: model,
      pharmacyStockMovement: model,
      pharmacySaleReturnLine: model,
      pharmacySaleEvent: { ...model, findFirst: vi.fn().mockResolvedValue(null) },
    };
    await returnSaleLine(db as never, scope, {
      saleLineId: 'line-a',
      lotId: 'lot-a',
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
