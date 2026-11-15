/**
 * DEV-774 — purchasing quantities and costs must stay inside the finite
 * DECIMAL(18,6) domain. NaN/±Infinity are valid `Prisma.Decimal` values and
 * PostgreSQL `numeric` stores NaN past a `>= 0` CHECK, so the command layer and
 * the ledger primitive must refuse them BEFORE any write (no receipt, movement,
 * idempotency key or PO status change). Runs without a database: every model
 * delegate is a spy, and a rejected command must not call any of them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('server-only', () => ({}));

import {
  addPurchaseOrderLine,
  createPurchaseOrder,
  createSupplierReturn,
  receivePurchaseOrder,
  updatePurchaseOrderLine,
} from './purchasing';
import { postStockMovements } from './inventory-ledger';

const calls: string[] = [];

/** A db whose every delegate method is recorded; reads resolve to a DRAFT PO. */
function recordingDb(): ScopedDb {
  const delegate = (model: string) =>
    new Proxy(
      {},
      {
        get: (_target, method: string) =>
          vi.fn(async () => {
            calls.push(`${model}.${method}`);
            return { id: 'po1', status: 'DRAFT' };
          }),
      }
    );
  return new Proxy(
    {},
    {
      get: (_target, model: string) => {
        if (model === '$transaction') {
          return vi.fn(async () => {
            calls.push('$transaction');
            throw new Error('transaction must not open for an invalid command');
          });
        }
        return delegate(model);
      },
    }
  ) as unknown as ScopedDb;
}

const writes = () => calls.filter((call) => !/\.(findUnique|findFirst|findMany)$/.test(call));

const INVALID: Array<[string, Prisma.Decimal | string | number]> = [
  ['NaN text', 'NaN'],
  ['NaN number', Number.NaN],
  ['NaN Decimal', new Prisma.Decimal(Number.NaN)],
  ['Infinity text', 'Infinity'],
  ['-Infinity number', Number.NEGATIVE_INFINITY],
  ['malformed text', 'abc'],
  ['negative', '-1'],
  ['excess scale', '1.0000001'],
  ['excess range', '1000000000000'],
];

beforeEach(() => {
  calls.length = 0;
});

describe('purchasing decimal domain (DEV-774)', () => {
  it.each(INVALID)(
    'rejects a %s received quantity before opening the receive transaction',
    async (_label, value) => {
      await expect(
        receivePurchaseOrder(recordingDb(), {
          purchaseOrderId: 'po1',
          actor: { idempotencyKey: 'idem-nan' },
          lines: [{ purchaseOrderLineId: 'l1', receivedQuantity: value }],
        })
      ).rejects.toMatchObject({ name: 'PurchasingError', reason: 'INVALID' });
      expect(calls).toEqual([]);
    }
  );

  it.each(INVALID)('rejects a %s receive cost or discrepancy quantity', async (_label, value) => {
    await expect(
      receivePurchaseOrder(recordingDb(), {
        purchaseOrderId: 'po1',
        lines: [{ purchaseOrderLineId: 'l1', receivedQuantity: '1', unitCost: value }],
      })
    ).rejects.toMatchObject({ name: 'PurchasingError', reason: 'INVALID' });
    await expect(
      receivePurchaseOrder(recordingDb(), {
        purchaseOrderId: 'po1',
        lines: [
          {
            purchaseOrderLineId: 'l1',
            receivedQuantity: '1',
            discrepancies: [{ kind: 'SHORTAGE', expectedQuantity: value, receivedQuantity: '1' }],
          },
        ],
      })
    ).rejects.toMatchObject({ name: 'PurchasingError', reason: 'INVALID' });
    expect(calls).toEqual([]);
  });

  it.each(INVALID)('rejects a %s order quantity or cost without writing', async (_label, value) => {
    const line = { stockItemId: 'si1', orderedQuantity: '1', unitId: 'u1', unitCost: '1' };
    await expect(
      createPurchaseOrder(recordingDb(), {
        supplierId: 's1',
        branchId: 'b1',
        lines: [{ ...line, orderedQuantity: value }],
      })
    ).rejects.toMatchObject({ name: 'PurchasingError', reason: 'INVALID' });
    await expect(
      addPurchaseOrderLine(recordingDb(), 'po1', { ...line, unitCost: value })
    ).rejects.toMatchObject({ name: 'PurchasingError', reason: 'INVALID' });
    await expect(
      updatePurchaseOrderLine(recordingDb(), 'po1', 'l1', { orderedQuantity: value })
    ).rejects.toMatchObject({ name: 'PurchasingError', reason: 'INVALID' });
    expect(writes()).toEqual([]);
  });

  it.each([...INVALID, ['zero', '0'] as [string, string]])(
    'rejects a %s supplier-return quantity without posting',
    async (_label, value) => {
      await expect(
        createSupplierReturn(recordingDb(), {
          locationId: 'loc1',
          lines: [{ stockItemId: 'si1', quantity: value }],
        })
      ).rejects.toMatchObject({ name: 'PurchasingError', reason: 'INVALID' });
      expect(calls).toEqual([]);
    }
  );

  it('rejects a non-finite supplier-return cost without posting', async () => {
    await expect(
      createSupplierReturn(recordingDb(), {
        locationId: 'loc1',
        lines: [{ stockItemId: 'si1', quantity: '1', unitCost: 'NaN' }],
      })
    ).rejects.toMatchObject({ name: 'PurchasingError', reason: 'INVALID' });
    expect(calls).toEqual([]);
  });
});

describe('stock ledger finite guard (DEV-774)', () => {
  it.each([
    ['NaN quantity', { quantity: 'NaN' }],
    ['Infinity quantity', { quantity: Number.POSITIVE_INFINITY }],
    ['NaN Decimal quantity', { quantity: new Prisma.Decimal(Number.NaN) }],
    ['malformed quantity', { quantity: 'abc' }],
    ['NaN unit cost', { quantity: '1', unitCost: 'NaN' }],
  ])('refuses a %s before opening the transaction', async (_label, values) => {
    await expect(
      postStockMovements(recordingDb(), {
        actor: { idempotencyKey: 'ledger-nan' },
        movements: [
          {
            stockItemId: 'si1',
            locationId: 'loc1',
            reason: 'PURCHASE_RECEIPT',
            ...values,
          },
        ],
      })
    ).rejects.toMatchObject({ name: 'StockLedgerError', reason: 'INVALID' });
    expect(calls).toEqual([]);
  });
});
