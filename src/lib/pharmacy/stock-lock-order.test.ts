import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';

/**
 * DEV-825: every stock path takes its locks in the one global order of
 * stock-lock-order.ts — register, batch, medicine, lot, balance — and each
 * class in ascending key order. These tests record the locks each path takes
 * (and its stock writes, which lock balances through the projection trigger)
 * and assert the recorded sequence never steps back to an earlier class.
 */

const witness = vi.hoisted(() => ({
  authorizeControlledRestoration: vi.fn(),
}));
vi.mock('./controlled-restoration-authorization', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./controlled-restoration-authorization')>()),
  authorizeControlledRestoration: witness.authorizeControlledRestoration,
}));
vi.mock('./regulatory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./regulatory')>()),
  assertStoredPharmacyMayOperate: vi.fn(async () => undefined),
}));
vi.mock('./finance-postings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./finance-postings')>()),
  postSaleReturnEntry: vi.fn(async () => undefined),
  postGoodsReceiptEntry: vi.fn(async () => ({ id: 'entry' })),
}));
const ledger = vi.hoisted(() => ({ receiveLot: vi.fn() }));
vi.mock('./stock-ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./stock-ledger')>()),
  receiveLot: ledger.receiveLot,
}));
const register = vi.hoisted(() => ({ appendControlledPurchaseEntries: vi.fn() }));
vi.mock('./controlled-register', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./controlled-register')>();
  return {
    ...actual,
    appendControlledPurchaseEntries: register.appendControlledPurchaseEntries.mockImplementation(
      // The real append takes the register lock itself; keep that behaviour.
      async (db: never, input: { organizationId: string; branchId: string }) =>
        actual.lockRegister(db, input.organizationId, input.branchId)
    ),
  };
});
vi.mock('@/lib/abac', () => ({ can: vi.fn(async () => true) }));
vi.mock('@/lib/restaurant/operator-credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/restaurant/operator-credentials')>()),
  verifyOperatorCredential: vi.fn(async () => true),
}));

import { reservationCandidates, transitionCustomerOrder } from './customer-ordering';
import { postGoodsReceipt } from './goods-receipt';
import { changeSaleStatus, returnSaleLine } from './sales';
import {
  allocateForSale,
  allocateReservedForSale,
  receiveLot,
  reverseMovements,
} from './stock-ledger';
import {
  STOCK_LOCK_ORDER,
  balanceLockOrderBy,
  compareBalanceLockKeys,
  lockStockBalances,
  lockStockRowsFrom,
  type StockLockClass,
} from './stock-lock-order';

type Step = StockLockClass | 'other';

function sqlText(args: unknown[]): { text: string; values: unknown[] } {
  const [first, ...rest] = args;
  // A tagged-template call nests Prisma.Sql fragments; flatten them as Prisma does.
  const sql = Array.isArray(first)
    ? Prisma.sql(first as unknown as TemplateStringsArray, ...rest)
    : (first as Prisma.Sql);
  return { text: sql.strings.join('?'), values: sql.values };
}

/** What lock class a raw statement takes, from its SQL. */
function classify(args: unknown[], scope: { organizationId: string; branchId: string }): Step {
  const { text, values } = sqlText(args);
  if (
    text.includes('pg_advisory_xact_lock') &&
    values.includes(`${scope.organizationId}:${scope.branchId}`)
  )
    return 'register';
  if (!/FOR (NO KEY )?UPDATE/.test(text) || text.includes('FOR UPDATE OF reservation'))
    return 'other';
  if (text.includes('stock_lock:batch') || /FOR (NO KEY )?UPDATE OF b(\s|$)/.test(text))
    return 'batch';
  if (text.includes('stock_lock:medicine')) return 'medicine';
  if (text.includes('stock_lock:lot')) return 'lot';
  if (text.includes('pharmacy_stock_balances')) return 'balance';
  return 'other';
}

function recorder(scope: { organizationId: string; branchId: string }) {
  const steps: Step[] = [];
  const statements: Array<{ step: Step; text: string; values: unknown[] }> = [];
  const queryRaw = vi.fn(async (...args: unknown[]): Promise<unknown[]> => {
    const step = classify(args, scope);
    steps.push(step);
    statements.push({ step, ...sqlText(args) });
    return [];
  });
  return {
    steps,
    statements,
    queryRaw,
    /** A stock movement write updates its balance row through the trigger. */
    write: () => steps.push('balance'),
    // Re-entering the register advisory lock already held is a no-op, not a new lock.
    locks: () =>
      steps.filter(
        (step, index): step is StockLockClass =>
          step !== 'other' && !(step === 'register' && steps.indexOf('register') < index)
      ),
  };
}

function expectGlobalOrder(locks: StockLockClass[]) {
  const ranks = locks.map((step) => STOCK_LOCK_ORDER.indexOf(step));
  expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
}

const scope = { organizationId: 'org', branchId: 'branch', actorId: 'actor' };

beforeEach(() => {
  witness.authorizeControlledRestoration.mockReset().mockResolvedValue({
    witnessedByUserId: 'witness',
    signatureRef: 'pin:witness',
  });
  ledger.receiveLot.mockReset();
});

describe('the documented global stock lock order', () => {
  it('is register, batch, medicine, lot, balance', () => {
    expect(STOCK_LOCK_ORDER).toEqual(['register', 'batch', 'medicine', 'lot', 'balance']);
  });

  it('orders balance keys by lot, then location, then disposition, by code unit', () => {
    const keys = [
      { inventoryLotId: 'lot-b', stockLocationId: 'a', disposition: 'AVAILABLE' },
      { inventoryLotId: 'lot-a', stockLocationId: 'b', disposition: 'AVAILABLE' },
      { inventoryLotId: 'lot-a', stockLocationId: 'a', disposition: 'QUARANTINE' },
      { inventoryLotId: 'lot-a', stockLocationId: 'a', disposition: 'AVAILABLE' },
      { inventoryLotId: 'Lot-z', stockLocationId: 'a', disposition: 'AVAILABLE' },
    ];
    expect(
      [...keys]
        .sort(compareBalanceLockKeys)
        .map((key) => `${key.inventoryLotId}/${key.stockLocationId}/${key.disposition}`)
    ).toEqual([
      'Lot-z/a/AVAILABLE',
      'lot-a/a/AVAILABLE',
      'lot-a/a/QUARANTINE',
      'lot-a/b/AVAILABLE',
      'lot-b/a/AVAILABLE',
    ]);
  });

  it('sorts SQL balance locks under the C collation, matching the JavaScript order', () => {
    expect(balanceLockOrderBy('balance').sql).toBe(
      'ORDER BY "balance"."inventoryLotId" COLLATE "C", "balance"."stockLocationId" COLLATE "C", "balance"."disposition"::text COLLATE "C"'
    );
  });

  it('locks balance keys once each, sorted, in a single FOR UPDATE statement', async () => {
    const trace = recorder(scope);
    await lockStockBalances({ $queryRaw: trace.queryRaw } as never, scope, [
      { inventoryLotId: 'lot-b', stockLocationId: 'shelf', disposition: 'AVAILABLE' },
      { inventoryLotId: 'lot-a', stockLocationId: 'shelf', disposition: 'AVAILABLE' },
      { inventoryLotId: 'lot-b', stockLocationId: 'shelf', disposition: 'AVAILABLE' },
    ]);
    expect(trace.steps).toEqual(['balance']);
    const [statement] = trace.statements;
    expect(statement!.text).toContain('FOR UPDATE');
    expect(statement!.values).toEqual([
      'org',
      'branch',
      'lot-a',
      'shelf',
      'AVAILABLE',
      'lot-b',
      'shelf',
      'AVAILABLE',
    ]);
  });

  it('locks a joined stock query class by class, never row by row', async () => {
    const trace = recorder(scope);
    await lockStockRowsFrom({ $queryRaw: trace.queryRaw } as never, 'org', {
      strings: ['SELECT 1'],
      values: [],
      sql: 'SELECT 1',
    } as unknown as Prisma.Sql);
    expect(trace.steps).toEqual(['batch', 'medicine', 'lot', 'balance']);
    for (const { text, step } of trace.statements.slice(0, 3)) {
      // Never FOR UPDATE: a foreign-key check's FOR KEY SHARE must not wait on it.
      expect(text, step).toContain('FOR NO KEY UPDATE');
      expect(text, step).toContain('ORDER BY "id" COLLATE "C"');
    }
  });
});

describe('goods-in takes stock locks in the global order', () => {
  function receiptDb(trace: ReturnType<typeof recorder>) {
    ledger.receiveLot.mockImplementation(async () => {
      trace.write();
      return { lot: { id: 'lot' }, movement: { id: 'move' }, quarantineMovement: null };
    });
    const receipt = {
      id: 'gr',
      organizationId: 'org',
      branchId: 'branch',
      status: 'DRAFT',
      reference: 'GRN-1',
      receivedAt: new Date('2026-11-01T00:00:00.000Z'),
      supplierInvoiceRef: 'INV',
      warrantyEvidenceRef: 'WAR',
      supplierId: 'supplier',
      purchaseOrderId: null,
      qualifiedPersonUserId: 'pharmacist',
      freightMinor: 0,
      supplier: {
        name: 'Supplier',
        authorized: true,
        licences: [
          {
            expiresAt: new Date('2030-01-01T00:00:00.000Z'),
            verifiedAt: new Date('2020-01-01T00:00:00.000Z'),
          },
        ],
      },
      lines: [
        {
          id: 'line',
          ocrFieldEvidence: null,
          batchNumber: 'B',
          printedExpiry: new Date('2028-12-31T00:00:00.000Z'),
          canonicalUnitsPerPack: 10,
          printedMrpMinor: 100,
          acceptedCanonicalUnits: 10,
          rejectedCanonicalUnits: 0,
          gs1Warnings: [],
          expiryPrecision: 'DAY',
          medicineId: 'controlled-medicine',
          packLevelId: 'pack',
          stockLocationId: 'shelf',
          unitCostMinor: 10,
          lineNumber: 1,
          receivedPacks: 1,
          bonusPacks: 0,
          receivedCanonicalUnits: 10,
          bonusCanonicalUnits: 0,
          invoicedPricePerPackMinor: 100,
          discountBps: 0,
          taxBps: 0,
          taxCreditable: false,
          allocatedOrderChargeMinor: 0,
          purchaseOrderLineId: null,
          quarantineLocationId: null,
          rejectionReason: null,
        },
      ],
    };
    return {
      $queryRaw: trace.queryRaw,
      medicine: {
        findMany: vi.fn(async () => [{ id: 'controlled-medicine', manufacturer: 'Maker' }]),
      },
      restaurantOperatorCredential: {
        findFirst: vi.fn(async () => ({
          id: 'credential',
          credentialHash: 'hash',
          failedAttempts: 0,
          lockedUntil: null,
          staffProfile: {
            status: 'ACTIVE',
            user: { id: 'pharmacist', organizationId: 'org', status: 'ACTIVE' },
          },
        })),
        update: vi.fn(),
      },
      pharmacyGoodsReceipt: {
        findFirst: vi.fn(async () => receipt),
        update: vi.fn(async () => ({})),
      },
      pharmacySupplierLicence: { findMany: vi.fn(async () => []) },
      pharmacyManufacturingBatch: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: 'batch' })),
      },
      pharmacyGoodsReceiptLine: { update: vi.fn(async () => ({})) },
      pharmacyPurchaseOrderLine: { findMany: vi.fn(async () => []) },
      pharmacyReceivingException: { create: vi.fn(async () => ({ id: 'exception' })) },
      pharmacyPurchaseOrder: { updateMany: vi.fn(async () => ({ count: 1 })) },
    };
  }

  it('takes the register lock before posting any controlled stock', async () => {
    const trace = recorder(scope);
    const db = receiptDb(trace);
    await postGoodsReceipt(db as never, scope, {
      goodsReceiptId: 'gr',
      at: new Date('2026-11-02T00:00:00.000Z'),
      staffProfileId: 'staff',
      pin: '1234',
    });
    expect(receiveLot).toHaveBeenCalledOnce();
    expect(register.appendControlledPurchaseEntries).toHaveBeenCalledOnce();
    expect(trace.locks()[0]).toBe('register');
    expect(trace.locks()).toContain('balance');
    expectGlobalOrder(trace.locks());
  });
});

describe('sales, voids and returns take stock locks in the global order', () => {
  it('locks counter-sale candidates in balance key order, not FEFO order', async () => {
    const trace = recorder(scope);
    const db = { $queryRaw: trace.queryRaw };
    await expect(
      allocateForSale(db as never, scope, {
        medicineId: 'medicine',
        requiredUnits: 1,
        at: new Date(),
        idempotencyKeyPrefix: 'sale:line',
      })
    ).rejects.toThrow();
    const lock = trace.statements.find((statement) => statement.step === 'balance');
    expect(lock?.text).toContain(balanceLockOrderBy('balance').sql);
    expect(lock?.text).not.toMatch(/ORDER BY[^?]*expiresAt/);
  });

  it('locks a reserved sale batch, medicine, lot, then balance before writing', async () => {
    const trace = recorder(scope);
    const row = {
      ...scope,
      inventoryLotId: 'lot-b',
      stockLocationId: 'shelf',
      batchState: 'ACTIVE',
      disposition: 'AVAILABLE',
      expiresAt: new Date('2100-01-01'),
      receivedAt: new Date('2020-01-01'),
      availableUnits: 10,
      unitsPerPack: 1,
      sealedPacks: 0,
      looseUnits: 10,
    };
    trace.queryRaw.mockImplementation(async (...args: unknown[]) => {
      const step = classify(args, scope);
      trace.steps.push(step);
      trace.statements.push({ step, ...sqlText(args) });
      return step === 'other' ? [row, { ...row, inventoryLotId: 'lot-a' }] : [];
    });
    const db = {
      $queryRaw: trace.queryRaw,
      pharmacyStockMovement: {
        create: vi.fn(async ({ data }: { data: { idempotencyKey: string } }) => {
          trace.write();
          return { ...data, id: data.idempotencyKey };
        }),
      },
    };
    await allocateReservedForSale(
      db as never,
      scope,
      { medicineId: 'medicine', requiredUnits: 2, at: new Date(), idempotencyKeyPrefix: 'p' },
      'pack',
      {
        expiresAt: new Date('2099-01-01'),
        allocations: [
          { inventoryLotId: 'lot-b', stockLocationId: 'shelf', units: 1 },
          { inventoryLotId: 'lot-a', stockLocationId: 'shelf', units: 1 },
        ],
      }
    );
    expect(trace.locks()).toEqual(['batch', 'medicine', 'lot', 'balance', 'balance', 'balance']);
    expectGlobalOrder(trace.locks());
    // No statement locks more than one class: the joined FOR UPDATE OF list is gone.
    expect(trace.statements.some(({ text }) => /FOR UPDATE OF \w+,/.test(text))).toBe(false);
  });

  it('locks reversal balances in key order before the first reversal write', async () => {
    const trace = recorder(scope);
    const originals = ['lot-c', 'lot-a', 'lot-b'].map((lot, index) => ({
      id: `movement-${index}`,
      inventoryLotId: lot,
      stockLocationId: 'shelf',
      disposition: 'AVAILABLE',
      quantityUnits: -1,
      sealedPackDelta: 0,
      looseUnitDelta: -1,
      idempotencyKey: `sale:${index}`,
    }));
    const db = {
      $queryRaw: trace.queryRaw,
      pharmacyStockMovement: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          originals.find((movement) => movement.id === where.id)
        ),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          trace.write();
          return { id: `reversal:${String(data.reversesMovementId)}`, ...data };
        }),
      },
    };
    await reverseMovements(db as never, scope, {
      movementIds: originals.map((movement) => movement.id),
      reason: 'Sale voided',
      at: new Date(),
    });
    const [lock] = trace.statements;
    expect(lock?.step).toBe('balance');
    expect(lock?.values.filter((value) => String(value).startsWith('lot-'))).toEqual([
      'lot-a',
      'lot-b',
      'lot-c',
    ]);
    expect(trace.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.pharmacyStockMovement.create.mock.invocationCallOrder[0]!
    );
  });

  it('takes the register lock before a controlled void reverses any stock', async () => {
    const trace = recorder(scope);
    let status = 'OPEN';
    const original = {
      id: 'sale-movement',
      inventoryLotId: 'lot',
      stockLocationId: 'shelf',
      disposition: 'AVAILABLE',
      quantityUnits: -2,
      sealedPackDelta: 0,
      looseUnitDelta: -2,
      idempotencyKey: 'sale:line:0',
    };
    const db = {
      $queryRaw: trace.queryRaw,
      pharmacySale: {
        findFirst: async () => ({
          id: 'sale',
          status,
          lines: [{ medicine: { controlled: true } }],
        }),
        updateMany: async ({ data }: { data: { status: string } }) => {
          status = data.status;
          return { count: 1 };
        },
      },
      pharmacyTender: { findMany: async () => [] },
      pharmacySaleLineAllocation: { findMany: async () => [{ stockMovementId: original.id }] },
      pharmacyStockMovement: {
        findFirst: async () => original,
        findMany: async () => [original],
        create: async ({ data }: { data: Record<string, unknown> }) => {
          trace.write();
          return { id: 'reversal', ...data };
        },
      },
      pharmacyControlledRegisterEntry: { findMany: async () => [] },
      pharmacySaleEvent: { create: async () => ({}) },
    };
    await changeSaleStatus(
      db as never,
      scope,
      'sale',
      'void',
      { kind: 'COUNTER', actorIsManager: true },
      'Customer cancelled',
      { staffProfileId: 'staff', pin: '1234' }
    );
    expect(trace.locks()[0]).toBe('register');
    expect(trace.locks()).toContain('balance');
    expectGlobalOrder(trace.locks());
  });

  it('takes the register lock before a controlled return locks its batch or stock', async () => {
    const trace = recorder(scope);
    const line = {
      id: 'line',
      saleId: 'sale',
      canonicalUnits: 4,
      sale: { status: 'COMPLETED' },
      medicine: { controlled: true },
      allocations: [
        {
          id: 'allocation',
          inventoryLotId: 'lot',
          stockLocationId: 'shelf',
          canonicalUnits: 4,
          stockMovementId: 'sale-movement',
        },
      ],
      unidentifiedReturnHolds: [],
      returnLines: [],
      quantity: 4,
      unitPriceMinor: 100,
      discountMinor: 0,
      grossMinor: 400,
    };
    const db = {
      $queryRaw: trace.queryRaw,
      pharmacySaleLine: { findFirst: vi.fn(async () => line) },
      pharmacySaleEvent: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) },
      pharmacyStockLocation: { findFirst: vi.fn(async () => ({ id: 'shelf' })) },
      pharmacyInventoryLot: {
        findFirst: vi.fn(async () => ({
          batch: { state: 'ACTIVE', expiresAt: new Date('2099-01-01') },
        })),
      },
      pharmacySaleReturn: {
        create: vi.fn(async () => ({ id: 'return', createdAt: new Date() })),
      },
      pharmacyStockMovement: {
        create: vi.fn(async () => {
          trace.write();
          return { id: 'return-movement' };
        }),
      },
      pharmacySaleReturnLine: { create: vi.fn(async () => ({ id: 'return-line' })) },
      pharmacyControlledRegisterEntry: { findMany: vi.fn(async () => []) },
    };
    await returnSaleLine(db as never, scope, {
      saleLineId: 'line',
      lotId: 'lot',
      canonicalUnits: 2,
      disposition: 'RESTOCK',
      reason: 'WRONG_ITEM',
      integrityDecision: 'sealed, storage verified',
      idempotencyKey: 'return-key',
      controlledWitness: { staffProfileId: 'staff', pin: '1234' },
    });
    expect(trace.locks()).toEqual(['register', 'batch', 'balance']);
    expectGlobalOrder(trace.locks());
  });

  it('locks a customer-order handoff class by class before its reservations', async () => {
    const trace = recorder(scope);
    const db = {
      $queryRaw: trace.queryRaw,
      pharmacyCustomerOrder: {
        findFirst: vi.fn(async () => ({
          id: 'order',
          status: 'PACKING',
          fulfillment: 'COLLECT',
          counterSaleId: null,
          reservationExpiresAt: new Date(Date.now() + 60_000),
        })),
      },
      pharmacyCustomerOrderLine: { findMany: vi.fn(async () => []) },
    };
    // No reserved line covers the order, so the handoff refuses after locking.
    await expect(
      transitionCustomerOrder(db as never, scope, { orderId: 'order', action: 'ready' })
    ).rejects.toMatchObject({ reason: 'RESERVATION_UNAVAILABLE' });
    expect(trace.locks()).toEqual(['batch', 'medicine', 'lot', 'balance']);
    const reservationLock = trace.statements.findIndex(({ text }) =>
      text.includes('FOR UPDATE OF reservation')
    );
    expect(reservationLock).toBeGreaterThan(
      trace.statements.findIndex(({ step }) => step === 'balance')
    );
    expect(trace.statements.some(({ text }) => /FOR UPDATE OF \w+,/.test(text))).toBe(false);
  });

  it('locks customer-order and refill reservation candidates in balance key order', async () => {
    const trace = recorder(scope);
    await reservationCandidates({ $queryRaw: trace.queryRaw } as never, scope, 'medicine', 'pack');
    const locking = trace.statements.filter(({ text }) => /FOR (NO KEY )?UPDATE/.test(text));
    expect(locking).toHaveLength(1);
    expect(locking[0]!.text).toContain(balanceLockOrderBy('balance').sql);
    expect(locking[0]!.text).not.toMatch(/ORDER BY[^?]*expiresAt/);
    // The FEFO read comes after the lock, in its own statement.
    expect(trace.statements.at(-1)!.text).toMatch(/ORDER BY batch."expiresAt"/);
    expect(trace.statements.at(-1)!.text).not.toMatch(/FOR (NO KEY )?UPDATE/);
  });
});
