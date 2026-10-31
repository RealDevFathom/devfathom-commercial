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
      findFirst: vi.fn().mockResolvedValue({ printedMrpMinor: 100, unitsPerPack: 1 }),
    },
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
