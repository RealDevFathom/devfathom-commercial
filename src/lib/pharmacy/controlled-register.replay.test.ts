import { describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  appendControlledCorrection,
  appendControlledPurchaseEntries,
  appendControlledRestorations,
  appendControlledSaleEntries,
} from './controlled-register';

/**
 * QA sequence on one lot, then a second lot, then a correction that would
 * walk the printed balance away from the shelf. After every accepted row the
 * latest running balance for that lot equals sellable stock.
 */
describe('controlled register replay', () => {
  it('keeps each lot balance equal to stock through sale, void, return and a second receipt', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const stock = new Map<string, number>([
      ['lot-a', 10],
      ['lot-b', 0],
    ]);
    const movements = new Map<
      string,
      { id: string; inventoryLotId: string; quantityUnits: number }
    >([
      ['m-buy-a', { id: 'm-buy-a', inventoryLotId: 'lot-a', quantityUnits: 10 }],
      ['m-sale-2', { id: 'm-sale-2', inventoryLotId: 'lot-a', quantityUnits: -2 }],
      ['m-sale-1', { id: 'm-sale-1', inventoryLotId: 'lot-a', quantityUnits: -1 }],
      ['m-buy-b', { id: 'm-buy-b', inventoryLotId: 'lot-b', quantityUnits: 5 }],
    ]);
    const lots = new Map([
      ['lot-a', { id: 'lot-a', batch: { batchNumber: 'CD-QA-1001' } }],
      ['lot-b', { id: 'lot-b', batch: { batchNumber: 'CD-QA-UI' } }],
    ]);

    function matches(row: Record<string, unknown>, where: Record<string, unknown>) {
      return Object.entries(where).every(([key, value]) => {
        if (value && typeof value === 'object' && 'in' in value) {
          return (value as { in: unknown[] }).in.includes(row[key]);
        }
        return row[key] === value;
      });
    }

    const db = {
      $queryRaw: async () => [],
      pharmacyStockBalance: {
        aggregate: async ({ where }: { where: { inventoryLotId: string } }) => ({
          _sum: { onHandUnits: stock.get(where.inventoryLotId) ?? 0 },
        }),
      },
      pharmacyStockMovement: {
        findFirstOrThrow: async ({ where }: { where: { id: string } }) => {
          const movement = movements.get(where.id);
          if (!movement) throw new Error('missing movement');
          return { ...movement, organizationId: 'org', branchId: 'branch' };
        },
      },
      pharmacyInventoryLot: {
        findFirstOrThrow: async ({ where }: { where: { id: string } }) => {
          const lot = lots.get(where.id);
          if (!lot) throw new Error('missing lot');
          return lot;
        },
      },
      pharmacyControlledRegisterEntry: {
        aggregate: async () => ({
          _sum: { quantityCanonicalUnits: null },
          _max: { serial: rows.reduce((max, row) => Math.max(max, Number(row.serial)), 0) || null },
        }),
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          rows.filter((row) => matches(row, where)),
        findFirst: async ({
          where,
          orderBy,
        }: {
          where: Record<string, unknown>;
          orderBy?: { serial: 'desc' };
        }) => {
          const found = rows.filter((row) => matches(row, where));
          if (orderBy?.serial === 'desc') {
            found.sort((left, right) => Number(right.serial) - Number(left.serial));
          }
          return found[0] ?? null;
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `row-${rows.length + 1}`, ...data };
          rows.push(row);
          return row;
        },
      },
    } as unknown as ScopedDb;

    const scope = { organizationId: 'org', branchId: 'gulberg' };
    const purchase = {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      recordedByUserId: 'receiver',
      witnessedByUserId: 'pharmacist',
      signatureRef: 'pin:pharmacist',
    };
    const sale = {
      ...scope,
      patientId: 'patient',
      patientAddress: '12 Mall Road, Gulberg',
      medicineId: 'med',
      manufacturer: 'Maker',
      prescriberId: 'prescriber',
      prescriberName: 'Dr Khan',
      prescriberRegNo: 'R-1',
      prescriptionId: 'rx',
      prescriptionLineId: 'line',
      emergency: false,
      rxSerialWritten: true,
      refEntryId: null,
      recordedByUserId: 'pharmacist',
      witnessedByUserId: 'pharmacist',
      signatureRef: 'pin:pharmacist',
    };

    function closing(lotId: string) {
      return rows
        .filter((row) => row.inventoryLotId === lotId)
        .reduce(
          (latest, row) => (!latest || Number(row.serial) > Number(latest.serial) ? row : latest),
          undefined as Record<string, unknown> | undefined
        );
    }

    function expectOnHand(lotId: string) {
      expect(closing(lotId)?.runningBalance).toBe(stock.get(lotId));
    }

    await appendControlledPurchaseEntries(db, {
      ...purchase,
      lines: [
        {
          medicineId: 'med',
          manufacturer: 'Maker',
          inventoryLotId: 'lot-a',
          stockMovementId: 'm-buy-a',
          batchNumber: 'CD-QA-1001',
          quantityCanonicalUnits: 10,
          counterpartyName: 'Supplier',
        },
      ],
    });
    expectOnHand('lot-a');

    stock.set('lot-a', 8);
    await appendControlledSaleEntries(db, { ...sale, movementIds: ['m-sale-2'] });
    expectOnHand('lot-a');

    stock.set('lot-a', 10);
    await appendControlledRestorations(db, {
      ...scope,
      recordedByUserId: 'pharmacist',
      witness: { witnessedByUserId: 'new-witness', signatureRef: 'pin:fresh-void' },
      reason: 'Sale voided',
      lines: [
        {
          sourceMovementId: 'm-sale-2',
          restorationMovementId: 'm-void-2',
          quantityCanonicalUnits: 2,
          restoreSellable: true,
        },
      ],
    });
    expectOnHand('lot-a');
    expect(rows.at(-1)).toMatchObject({
      witnessedByUserId: 'new-witness',
      signatureRef: 'pin:fresh-void',
    });
    expect(rows.filter((row) => row.correctionReason === 'Sale voided')).toHaveLength(1);

    stock.set('lot-a', 9);
    await appendControlledSaleEntries(db, { ...sale, movementIds: ['m-sale-1'] });
    expectOnHand('lot-a');

    stock.set('lot-a', 10);
    await appendControlledRestorations(db, {
      ...scope,
      recordedByUserId: 'pharmacist',
      witness: { witnessedByUserId: 'return-witness', signatureRef: 'pin:fresh-return' },
      reason: 'Returned to stock',
      lines: [
        {
          sourceMovementId: 'm-sale-1',
          restorationMovementId: 'm-return-1',
          quantityCanonicalUnits: 1,
          restoreSellable: true,
        },
      ],
    });
    expectOnHand('lot-a');
    expect(rows.filter((row) => row.correctionReason === 'Returned to stock')).toHaveLength(1);

    stock.set('lot-b', 5);
    await appendControlledPurchaseEntries(db, {
      ...purchase,
      lines: [
        {
          medicineId: 'med',
          manufacturer: 'Maker',
          inventoryLotId: 'lot-b',
          stockMovementId: 'm-buy-b',
          batchNumber: 'CD-QA-UI',
          quantityCanonicalUnits: 5,
          counterpartyName: 'Supplier',
        },
      ],
    });
    expectOnHand('lot-a');
    expectOnHand('lot-b');
    expect(closing('lot-b')?.runningBalance).toBe(5);
    expect(closing('lot-a')?.runningBalance).toBe(10);

    const before = rows.length;
    const opening = rows.find((row) => row.stockMovementId === 'm-buy-a');
    await expect(
      appendControlledCorrection(db, {
        ...scope,
        correctsEntryId: String(opening?.id),
        correctionReason: 'Counted six short of the shelf.',
        quantityCanonicalUnits: 4,
        recordedByUserId: 'pharmacist',
        witnessedByUserId: 'witness',
        signatureRef: 'pin:witness',
      })
    ).rejects.toThrow('STOCK');
    expect(rows).toHaveLength(before);
    expectOnHand('lot-a');
    expectOnHand('lot-b');
  });
});
