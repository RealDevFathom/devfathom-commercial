import { describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  allocateCentralReceipt,
  centralDemand,
  CentralPurchasingError,
  createCentralPurchaseOrder,
} from './central-purchasing';

const scope = { organizationId: 'org_chain', actorId: 'user_branch' };

function fakeDb(overrides: Record<string, unknown> = {}) {
  return {
    user: { findUnique: async () => null },
    pharmacyCentralPurchasingAccess: {
      findMany: async () => [{ branchId: 'branch_a' }],
    },
    pharmacyStockSignal: {
      findMany: async ({ where }: { where: unknown }) => [
        { id: 'signal_a', branchId: 'branch_a', where },
      ],
    },
    ...overrides,
  } as unknown as ScopedDb;
}

describe('INV-10 central purchasing access', () => {
  it('denies a branch purchaser reading a sibling branch', async () => {
    await expect(centralDemand(fakeDb(), scope, 'branch_b')).rejects.toMatchObject({
      reason: 'FORBIDDEN',
    } satisfies Partial<CentralPurchasingError>);
  });

  it('allows an organization purchaser to aggregate every branch', async () => {
    let query: { where?: { branchId?: unknown } } = {};
    const db = fakeDb({
      pharmacyCentralPurchasingAccess: { findMany: async () => [{ branchId: null }] },
      pharmacyStockSignal: {
        findMany: async (input: typeof query) => {
          query = input;
          return [
            { id: 'one', branchId: 'branch_a' },
            { id: 'two', branchId: 'branch_b' },
          ];
        },
      },
    });
    const result = await centralDemand(db, { ...scope, actorId: 'user_central' });
    expect(result).toMatchObject({ organizationWide: true, branches: ['branch_a', 'branch_b'] });
    expect(query.where?.branchId).toBeUndefined();
  });

  it('denies a branch purchaser creating the organization PO', async () => {
    await expect(
      createCentralPurchaseOrder(fakeDb(), scope, {
        reference: 'PO-CENTRAL',
        supplierId: 'supplier',
        receivingBranchId: 'branch_a',
        lines: [
          {
            medicineId: 'medicine',
            packLevelId: 'pack',
            orderedPacks: 1,
            canonicalUnitsPerPack: 10,
            listPricePerPackMinor: 100,
          },
        ],
      })
    ).rejects.toMatchObject({ reason: 'FORBIDDEN' });
  });

  it('denies a branch purchaser allocating another branch from a central receipt', async () => {
    await expect(
      allocateCentralReceipt(fakeDb(), scope, {
        goodsReceiptId: 'receipt',
        allocations: [
          {
            goodsReceiptLineId: 'line',
            destinationBranchId: 'branch_b',
            destinationStockLocationId: 'branch_store',
            quantityUnits: 10,
          },
        ],
      })
    ).rejects.toMatchObject({ reason: 'FORBIDDEN' });
  });
});

describe('INV-10 receipt allocation', () => {
  it('requires allocations to equal received quantity before creating any INV-07 transfer', async () => {
    let transfersCreated = 0;
    const db = fakeDb({
      pharmacyCentralPurchasingAccess: { findMany: async () => [{ branchId: null }] },
      pharmacyGoodsReceipt: {
        findFirst: async () => ({
          id: 'receipt',
          branchId: 'central',
          lines: [
            {
              id: 'line',
              acceptedCanonicalUnits: 10,
              inventoryLotId: 'lot',
              stockLocationId: 'central_store',
            },
          ],
        }),
      },
      pharmacyCentralPurchaseAllocation: { count: async () => 0 },
      pharmacyInventoryLot: { findFirst: async () => ({ id: 'lot' }) },
      pharmacyStockLocation: { findFirst: async () => ({ id: 'branch_store' }) },
      pharmacyInterbranchTransfer: {
        create: async () => {
          transfersCreated += 1;
          return { id: 'transfer' };
        },
        findFirstOrThrow: async () => ({ id: 'transfer', lines: [{ id: 'transfer_line' }] }),
      },
      pharmacyInterbranchTransferLine: { createMany: async () => ({ count: 1 }) },
    });
    await expect(
      allocateCentralReceipt(
        db,
        { ...scope, actorId: 'user_central' },
        {
          goodsReceiptId: 'receipt',
          allocations: [
            {
              goodsReceiptLineId: 'line',
              destinationBranchId: 'branch_b',
              destinationStockLocationId: 'branch_store',
              quantityUnits: 9,
            },
          ],
        }
      )
    ).rejects.toMatchObject({ reason: 'INVALID_ALLOCATION' });
    expect(transfersCreated).toBe(0);
  });

  it('allocates the entire receipt once through INV-07 and records no stock itself', async () => {
    const evidence: unknown[] = [];
    const transferLines: unknown[] = [];
    const db = fakeDb({
      pharmacyCentralPurchasingAccess: { findMany: async () => [{ branchId: null }] },
      pharmacyGoodsReceipt: {
        findFirst: async () => ({
          id: 'receipt',
          branchId: 'central',
          lines: [
            {
              id: 'line',
              acceptedCanonicalUnits: 10,
              inventoryLotId: 'lot',
              stockLocationId: 'central_store',
            },
          ],
        }),
      },
      pharmacyCentralPurchaseAllocation: {
        count: async () => 0,
        create: async ({ data }: { data: unknown }) => {
          evidence.push(data);
          return data;
        },
      },
      pharmacyInventoryLot: { findFirst: async () => ({ id: 'lot' }) },
      pharmacyStockLocation: { findFirst: async () => ({ id: 'branch_store' }) },
      pharmacyInterbranchTransfer: {
        create: async () => ({ id: 'transfer' }),
        findFirstOrThrow: async () => ({ id: 'transfer', lines: [{ id: 'transfer_line' }] }),
      },
      pharmacyInterbranchTransferLine: {
        createMany: async ({ data }: { data: unknown[] }) => {
          transferLines.push(...data);
          return { count: data.length };
        },
      },
    });
    const result = await allocateCentralReceipt(
      db,
      { ...scope, actorId: 'user_central' },
      {
        goodsReceiptId: 'receipt',
        allocations: [
          {
            goodsReceiptLineId: 'line',
            destinationBranchId: 'branch_b',
            destinationStockLocationId: 'branch_store',
            quantityUnits: 10,
          },
        ],
      }
    );
    expect(result).toHaveLength(1);
    expect(transferLines).toEqual([
      expect.objectContaining({ quantityUnits: 10, sourceLotId: 'lot' }),
    ]);
    expect(evidence).toEqual([
      expect.objectContaining({ quantityUnits: 10, transferId: 'transfer' }),
    ]);
  });
});

it('gives an installed owner central branch access without duplicate grant rows', async () => {
  const db = fakeDb({
    user: {
      findUnique: async () => ({
        role: 'ADMIN',
        organizationRole: {
          key: 'owner',
          isSystem: true,
          permissions: [{ capability: 'pharmacy:*', effect: 'ALLOW' }],
        },
        permissionOverrides: [],
      }),
    },
    pharmacyCentralPurchasingAccess: {
      findMany: async () => {
        throw new Error('Owner must not need duplicate grants');
      },
    },
  });
  expect(await centralDemand(db, scope, 'branch_a')).toMatchObject({
    organizationWide: true,
    branches: ['branch_a'],
  });
});
