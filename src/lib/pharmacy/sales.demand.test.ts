import { describe, expect, it, vi } from 'vitest';
import { captureDemand } from './sales';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'staff-a' };
const terminalId = 'counter-11111111-1111-4111-8111-111111111111';
const input = {
  terminalId,
  saleUnit: 'UNIT' as const,
  quantity: 3,
  requestedMedicineId: 'medicine-a',
  reason: 'STOCKOUT' as const,
  inventoryRuleSnapshot: {},
  outcome: 'WENT_ELSEWHERE' as const,
};
function fixture() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacySale: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyRegisteredDevice: { findFirst: vi.fn().mockResolvedValue(null) },
    medicine: { count: vi.fn().mockResolvedValue(1) },
    pharmacyBranch: {
      findFirstOrThrow: vi
        .fn()
        .mockResolvedValue({
          lostSalesUnknownProbability: 0.43,
          lostSalesMeasuredRateMinimum: 200,
        }),
    },
    pharmacyInventoryLot: {
      findFirst: vi.fn().mockResolvedValue({ printedMrpMinor: 100, unitsPerPack: 1,
        packLevelId: 'pack-a', packLevel: { presentationId: 'presentation-a' } }),
    },
    packLevel: { findMany: vi.fn().mockResolvedValue([]) },
    unfulfilledDemandEvent: {
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(async ({ data }) => ({ id: 'demand-a', ...data })),
    },
  };
}

describe('lost-sales capture regressions', () => {
  it('groups a loyalty customer via the sale without writing a customer ID into the patient FK', async () => {
    const db = fixture();
    db.pharmacySale.findFirst.mockResolvedValue({
      customerId: 'loyalty-customer',
      status: 'OPEN',
      receiptDeviceId: null,
      lines: [],
    } as never);
    const captured = await captureDemand(db as never, scope, { ...input, saleId: 'sale-a' });
    expect(captured.customerId).toBeUndefined();
    expect(captured.consentRecorded).toBeUndefined();
    expect(db.unfulfilledDemandEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          customerId: null,
          sale: { customerId: 'loyalty-customer' },
          terminalId,
        }),
      })
    );
    expect(db.pharmacyRegisteredDevice.findFirst).not.toHaveBeenCalled();
  });

  it('retains explicit patient linkage and requires its consent', async () => {
    const db = fixture();
    await expect(
      captureDemand(db as never, scope, { ...input, customerId: 'patient-a' })
    ).rejects.toThrow('CONSENT_REQUIRED');
    const result = await captureDemand(db as never, scope, {
      ...input,
      customerId: 'patient-a',
      consentRecorded: true,
    });
    expect(result).toMatchObject({ customerId: 'patient-a', consentRecorded: true });
  });

  it('includes the unpaid basket in a walk-out once per sale/visit', async () => {
    const db = fixture();
    db.pharmacySale.findFirst.mockResolvedValue({
      customerId: null,
      status: 'OPEN',
      lines: [{ quantity: 1, unitPriceMinor: 1000, discountMinor: 0 }],
    } as never);
    const first = await captureDemand(db as never, scope, { ...input, saleId: 'sale-a' });
    expect(first).toMatchObject({
      visitType: 'WALK_OUT',
      unitPricePkr: 1,
      abandonedBasketPkr: 10,
      estLossPkr: 13,
    });
    db.unfulfilledDemandEvent.findFirst
      .mockResolvedValueOnce({ visitId: first.visitId } as never)
      .mockResolvedValueOnce({ id: first.id } as never);
    const next = await captureDemand(db as never, scope, { ...input, saleId: 'sale-a' });
    expect(next).toMatchObject({ visitId: first.visitId, abandonedBasketPkr: 0, estLossPkr: 3 });
  });

  it('does not count a completed or explicitly partial basket as abandoned', async () => {
    const db = fixture();
    const sale = {
      customerId: null,
      status: 'COMPLETED',
      lines: [{ quantity: 1, unitPriceMinor: 1000, discountMinor: 0 }],
    };
    db.pharmacySale.findFirst.mockResolvedValue(sale as never);
    expect(await captureDemand(db as never, scope, { ...input, saleId: 'sale-a' })).toMatchObject({
      visitType: 'PARTIAL',
      abandonedBasketPkr: 0,
      estLossPkr: 3,
    });
    db.pharmacySale.findFirst.mockResolvedValue({ ...sale, status: 'OPEN' } as never);
    expect(
      await captureDemand(db as never, scope, { ...input, saleId: 'sale-a', visitType: 'PARTIAL' })
    ).toMatchObject({ visitType: 'PARTIAL', abandonedBasketPkr: 0, estLossPkr: 3 });
  });

  it('locks the terminal/customer tuple before reading a previous visit', async () => {
    const db = fixture();
    await captureDemand(db as never, scope, input);
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.unfulfilledDemandEvent.findFirst.mock.invocationCallOrder[0]!
    );
    const sql = db.$queryRaw.mock.calls[0]![0] as unknown as { values: unknown[]; text: string };
    expect(sql.text).toContain('pg_advisory_xact_lock');
    expect(sql.values).toEqual([JSON.stringify(['org-a', 'branch-a', terminalId, null])]);
  });

  it('prices an explicitly abandoned Unknown basket at full missing-item value', async () => {
    const db = fixture();
    db.pharmacySale.findFirst.mockResolvedValue({ customerId: null, status: 'OPEN',
      lines: [{ quantity: 1, unitPriceMinor: 1000, discountMinor: 0 }] } as never);
    expect(await captureDemand(db as never, scope, {
      ...input, saleId: 'sale-a', outcome: 'UNKNOWN', visitType: 'WALK_OUT',
    })).toMatchObject({ lossProbability: 1, abandonedBasketPkr: 10, estLossPkr: 13 });
    expect(await captureDemand(db as never, scope, {
      ...input, saleId: 'sale-a', outcome: 'UNKNOWN', visitType: 'PARTIAL',
    })).toMatchObject({ lossProbability: 0.43, abandonedBasketPkr: 0, estLossPkr: 1.29 });
  });

  it.each([['PACK', 100, 43], ['STRIP', 10, 4.3]] as const)(
    'normalizes %s demand using the lot pack hierarchy', async (saleUnit, requestedQty, estLossPkr) => {
      const db = fixture();
      db.pharmacyInventoryLot.findFirst.mockResolvedValue({ printedMrpMinor: 10000, unitsPerPack: 100,
        packLevelId: 'pack-a', packLevel: { presentationId: 'presentation-a' } });
      db.packLevel.findMany.mockResolvedValue([
        { id: 'pack-a', level: 'BOX', parentPackLevelId: null, unitsPerParent: 1 },
        { id: 'strip-a', level: 'STRIP', parentPackLevelId: 'pack-a', unitsPerParent: 10 },
        { id: 'unit-a', level: 'UNIT', parentPackLevelId: 'strip-a', unitsPerParent: 10 },
      ] as never);
      expect(await captureDemand(db as never, scope, {
        ...input, saleUnit, quantity: 1, outcome: 'UNKNOWN',
      })).toMatchObject({ quantity: 1, saleUnit, requestedQty, unitPricePkr: 1, estLossPkr });
      expect(db.packLevel.findMany).toHaveBeenCalledWith({
        where: { organizationId: 'org-a', presentationId: 'presentation-a' },
      });
    }
  );

  it('keeps fractional canonical-unit prices until the final loss is rounded', async () => {
    const db = fixture();
    db.pharmacyInventoryLot.findFirst.mockResolvedValue({ printedMrpMinor: 1000, unitsPerPack: 3,
      packLevelId: 'pack-a', packLevel: { presentationId: 'presentation-a' } });
    expect(await captureDemand(db as never, scope, input)).toMatchObject({
      unitPricePkr: 3.333333333333, estLossPkr: 10,
    });
  });

  it('waits for the shared checkout row lock before re-reading a completed basket', async () => {
    const db = fixture();
    db.$queryRaw.mockImplementation(async () => {
      db.pharmacySale.findFirst.mockResolvedValue({ status: 'COMPLETED', customerId: null,
        lines: [{ quantity: 2, unitPriceMinor: 100, discountMinor: 0 }] } as never);
      return [];
    });
    expect(await captureDemand(db as never, scope, {
      ...input, saleId: 'sale-a', outcome: 'UNKNOWN', visitType: 'WALK_OUT',
    })).toMatchObject({ visitType: 'PARTIAL', abandonedBasketPkr: 0, lossProbability: 0.43 });
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.pharmacySale.findFirst.mock.invocationCallOrder[0]!
    );
    const lock = db.$queryRaw.mock.calls[0]![0] as unknown as { text: string; values: unknown[] };
    expect(lock.text).toContain('FOR UPDATE');
    expect(lock.values).toEqual(['sale-a', 'org-a', 'branch-a']);
  });

  it('excludes fresh unresolved return promises from the measured-rate denominator', async () => {
    const db = fixture();
    db.unfulfilledDemandEvent.count.mockImplementation(async ({ where }) => {
      // 200 fresh promises must not displace the configured Unknown estimate.
      // A broad not-Unknown denominator would incorrectly count these as known.
      return where.outcome?.not === 'UNKNOWN' ? 200 : 0;
    });
    expect(await captureDemand(db as never, scope, { ...input, outcome: 'UNKNOWN' }))
      .toMatchObject({ lossProbability: 0.43 });
    expect(db.unfulfilledDemandEvent.count).toHaveBeenNthCalledWith(1, {
      where: {
        organizationId: 'org-a', branchId: 'branch-a', OR: [
          { outcome: { in: ['SUBSTITUTE_TAKEN', 'ORDERED_FOR_CUSTOMER', 'WENT_ELSEWHERE'] } },
          { outcome: 'WILL_RETURN', OR: [
            { resolvedBySaleId: { not: null } }, { createdAt: { lte: expect.any(Date) } },
          ] },
        ],
      },
    });
  });

  it('refuses medicine or sale references outside the current scope before writing', async () => {
    const db = fixture();
    db.medicine.count.mockResolvedValue(0);
    await expect(captureDemand(db as never, scope, input)).rejects.toThrow(
      'CROSS_BRANCH_REFERENCE'
    );
    await expect(
      captureDemand(db as never, scope, { ...input, saleId: 'foreign-sale' })
    ).rejects.toThrow('CROSS_BRANCH_REFERENCE');
    expect(db.unfulfilledDemandEvent.create).not.toHaveBeenCalled();
  });
});
