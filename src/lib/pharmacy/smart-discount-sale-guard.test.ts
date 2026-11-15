/**
 * DEV-66: the server-side sale path enforces the branch's configured minimum
 * margin on a discounted line, not just the UI suggestion.
 */
import { describe, expect, it, vi } from 'vitest';

import { addSaleLine } from './sales';

vi.mock('./regulatory', async () => ({
  ...(await vi.importActual<typeof import('./regulatory')>('./regulatory')),
  assertStoredPharmacyMayOperate: vi.fn(async () => undefined),
}));

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };

// One sealed pack of 10 at MRP 1000; cost 70 per unit (700 per pack).
const lot = {
  id: 'lot-a',
  packLevelId: 'pack-box',
  unitsPerPack: 10,
  printedMrpMinor: 1_000,
  unitCostMinor: 70,
  receivedAt: new Date('2026-01-01T00:00:00Z'),
  batch: { batchNumber: 'B-1' },
};

function saleDb(discountPolicy: unknown) {
  const candidate = {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    inventoryLotId: 'lot-a',
    stockLocationId: 'shelf-a',
    batchState: 'ACTIVE',
    disposition: 'AVAILABLE',
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    receivedAt: lot.receivedAt,
    availableUnits: 30,
    unitsPerPack: 10,
    sealedPacks: 3,
    looseUnits: 0,
  };
  return {
    $queryRaw: vi.fn(async () => [candidate]),
    pharmacyStockMovement: {
      create: vi.fn(async ({ data }: { data: { idempotencyKey: string } }) => ({
        ...data,
        id: `movement:${data.idempotencyKey}`,
      })),
    },
    pharmacySale: {
      findFirst: vi.fn(async () => ({ id: 'sale-a', status: 'OPEN' })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    pharmacyBranch: { findFirst: vi.fn(async () => ({ discountPolicy })) },
    medicine: {
      findFirst: vi.fn(async () => ({
        id: 'medicine-a',
        saleable: true,
        rx: false,
        otc: false,
        restricted: false,
        controlled: false,
        productFamily: 'FRONT_SHOP',
      })),
    },
    pharmacyVoucher: {
      findFirst: vi.fn(async () => ({
        id: 'voucher-a',
        discountMinor: 200,
        eligibleCategories: ['NON_DRUG'],
        issuedByUserId: 'owner-a',
        validUntil: null,
      })),
    },
    pharmacyInventoryLot: { findMany: vi.fn(async () => [lot]) },
    medicinePackMrp: { findMany: vi.fn(async () => []) },
    pharmacySaleLine: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'sale-line-a',
        ...data,
      })),
    },
    pharmacySaleLineAllocation: { create: vi.fn() },
    pharmacySaleEvent: { create: vi.fn() },
  };
}

const discountedLine = {
  saleId: 'sale-a',
  medicineId: 'medicine-a',
  presentationId: 'presentation-a',
  packLevelId: 'pack-box',
  saleUnit: 'UNIT' as const,
  quantity: 10,
  canonicalUnitsPerSaleUnit: 1,
  idempotencyKey: 'line-a',
  discountKind: 'DISCOUNT' as const,
  discountMinor: 200,
  approvedByUserId: 'manager-a',
  approvalPolicy: 'MANAGER_PIN',
};

describe('DEV-66 minimum-margin guard on the sale path', () => {
  it('refuses a discount that breaches the configured minimum margin', async () => {
    // Net 800 is above cost 700 but below the 25% margin floor of 934.
    const db = saleDb({ minMarginBps: 2_500 });
    await expect(addSaleLine(db as never, scope, discountedLine)).rejects.toThrow(
      'MARGIN_GUARDRAIL'
    );
    expect(db.pharmacySaleLine.create).not.toHaveBeenCalled();
  });

  it('accepts the same discount when the branch keeps the default cost floor', async () => {
    const db = saleDb(null);
    const { line } = await addSaleLine(db as never, scope, discountedLine);
    expect(line).toMatchObject({ grossMinor: 1_000, discountMinor: 200 });
  });

  it('does not read the policy for an undiscounted line', async () => {
    const db = saleDb({ minMarginBps: 9_000 });
    await addSaleLine(db as never, scope, {
      ...discountedLine,
      discountKind: undefined,
      discountMinor: 0,
      approvedByUserId: undefined,
      approvalPolicy: undefined,
    });
    expect(db.pharmacyBranch.findFirst).not.toHaveBeenCalled();
  });

  describe('DEV-27 voucher redemption', () => {
    const voucherLine = {
      saleId: 'sale-a',
      medicineId: 'medicine-a',
      presentationId: 'presentation-a',
      packLevelId: 'pack-box',
      saleUnit: 'UNIT' as const,
      quantity: 10,
      canonicalUnitsPerSaleUnit: 1,
      idempotencyKey: 'line-voucher',
      voucherId: 'voucher-a',
    };

    it('refuses a voucher that would breach the configured minimum margin', async () => {
      // The stored voucher takes 200 off 1000: above cost 700, below the 934 floor.
      const db = saleDb({ minMarginBps: 2_500 });
      await expect(addSaleLine(db as never, scope, voucherLine)).rejects.toThrow(
        'MARGIN_GUARDRAIL'
      );
      expect(db.pharmacySaleLine.create).not.toHaveBeenCalled();
    });

    it('redeems the same voucher under the default cost floor', async () => {
      const db = saleDb(null);
      const { line } = await addSaleLine(db as never, scope, voucherLine);
      expect(line).toMatchObject({ discountKind: 'VOUCHER', discountMinor: 200 });
    });
  });
});
