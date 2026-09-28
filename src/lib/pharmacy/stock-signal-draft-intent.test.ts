// Source contract tests only. The query double cannot prove PostgreSQL locking,
// transaction rollback, unique-index enforcement, or forced RLS.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('./temperature-log', () => ({ loadTemperatureZoneStatuses: vi.fn(async () => []) }));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '@/server/trpc';
import { pharmacyInventoryRouter } from '@/server/routers/pharmacy-inventory';
import { createDraftAction, type DraftActionInput } from './stock-signals-operations';
import { evaluateStockSignals, type SignalFacts } from './stock-signals';

const now = new Date('2026-09-14T12:00:00.000Z');
const tomorrow = new Date('2026-09-15T12:00:00.000Z');
const scope = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'actor_a' };
const requisition: DraftActionInput = {
  kind: 'DRAFT_REQUISITION',
  signalId: 'signal_a',
  idempotencyKey: 'intent-a',
  reference: 'REQ-A',
  medicineId: 'medicine_a',
  packLevelId: 'pack_a',
  canonicalUnitsPerPack: 10,
  quantityPacks: 10,
};
const transfer: DraftActionInput = {
  kind: 'DRAFT_TRANSFER',
  signalId: 'signal_a',
  idempotencyKey: 'intent-a',
  fromBranchId: 'branch_b',
  lines: [
    {
      sourceLotId: 'lot_a',
      sourceStockLocationId: 'location_b',
      destinationStockLocationId: 'location_a',
      quantityUnits: 10,
    },
  ],
};
const claim: DraftActionInput = {
  kind: 'DRAFT_CLAIM',
  signalId: 'signal_a',
  idempotencyKey: 'intent-a',
  reference: 'CLAIM-A',
  supplierId: 'supplier_a',
  lines: [
    {
      inventoryLotId: 'lot_a',
      stockLocationId: 'location_a',
      quantityUnits: 10,
      reason: 'Expiry',
      returnWindowEndsAt: tomorrow,
      expectedCreditMinor: 100,
    },
  ],
};

type Row = Record<string, unknown>;
function fixture(input: DraftActionInput = requisition) {
  const facts: SignalFacts = {
    ...scope,
    at: now,
    sourceObservedAt: now,
    lots: [],
    inbound: [],
    countVariances: [],
    safetyStocks: [
      { medicineId: 'medicine_a', safetyStockUnits: 100, coverageDays: 30, approvedAt: now },
    ],
  };
  if (input.kind === 'DRAFT_CLAIM') {
    facts.lots = [
      {
        inventoryLotId: 'lot_a',
        medicineId: 'medicine_a',
        stockLocationId: 'location_a',
        expiresAt: tomorrow,
        receivedAt: now,
        disposition: 'AVAILABLE',
        batchState: 'ACTIVE',
        onHandUnits: 100,
        reservedUnits: 0,
        returnWindowEndsAt: null,
        medicineColdChain: false,
        locationColdChain: false,
        recallReference: null,
        unsettled: false,
      },
    ];
  }
  const derived = evaluateStockSignals(facts).find(
    (row) => row.kind === (input.kind === 'DRAFT_CLAIM' ? 'NEAR_EXPIRY' : 'STOCKOUT')
  )!;
  const signal = {
    ...derived,
    id: 'signal_a',
    ...scope,
    status: 'OPEN',
    snoozedUntil: null as Date | null,
  };
  const actions: Row[] = [];
  const writes: string[] = [];
  const binding = { organizationId: scope.organizationId, branchId: null as string | null };
  const user = {
    status: 'ACTIVE',
    organization: { status: 'ACTIVE', vertical: 'PHARMACY' },
    organizationRole: { permissions: [{ capability: 'pharmacy.*', effect: 'ALLOW' }] },
    permissionOverrides: [] as Array<{ capability: string; effect: string }>,
  };
  const create = (name: string) =>
    vi.fn(async ({ data }: { data: Row }) => {
      writes.push(name);
      return { id: `${name}-${writes.length}`, ...data };
    });
  const pack = {
    id: 'pack_a',
    presentationId: 'presentation_a',
    level: 'STRIP',
    unitsPerParent: 10,
    parentPackLevelId: null,
    effectiveFrom: now,
    effectiveTo: null,
  };
  const lot = {
    id: 'lot_a',
    manufacturingBatchId: 'batch_a',
    batch: { medicineId: 'medicine_a', state: 'ACTIVE', expiresAt: tomorrow },
  };
  const db = {
    $queryRaw: vi.fn(async (query: { sql: string; values: unknown[] }) => {
      const sql = query.sql;
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes("current_setting('app.current_organization_id'")) return [binding];
      if (sql.includes('SELECT * FROM "pharmacy_stock_signal_actions"')) {
        const [organizationId, branchId, idempotencyKey] = query.values;
        return actions.filter(
          (row) =>
            row.organizationId === organizationId &&
            row.branchId === branchId &&
            row.idempotencyKey === idempotencyKey
        );
      }
      if (sql.includes('INSERT INTO "pharmacy_stock_signal_actions"')) {
        const [
          id,
          organizationId,
          branchId,
          signalId,
          kind,
          actorId,
          requisitionId,
          transferId,
          purchaseReturnId,
          idempotencyKey,
          payloadHash,
        ] = query.values;
        const action = {
          id,
          organizationId,
          branchId,
          signalId,
          kind,
          actorId,
          requisitionId,
          transferId,
          purchaseReturnId,
          idempotencyKey,
          payloadHash,
          createdAt: now,
        };
        actions.push(action);
        writes.push('action');
        return [action];
      }
      if (sql.includes('FROM "pharmacy_stock_signals"') && sql.includes('FOR UPDATE'))
        return [{ id: signal.id }];
      if (sql.includes('FROM "pharmacy_stock_balances" balance')) return facts.lots;
      if (
        sql.includes('FROM "pharmacy_purchase_order_lines"') ||
        sql.includes('FROM "pharmacy_interbranch_transfer_lines"') ||
        sql.includes('FROM "pharmacy_inventory_count_lines"')
      )
        return [];
      throw new Error('Unexpected query in source test');
    }),
    user: {
      findFirst: vi.fn(async ({ where }: { where: Row }) =>
        where.id === scope.actorId && where.organizationId === scope.organizationId ? user : null
      ),
    },
    pharmacyBranch: {
      findFirst: vi.fn(async ({ where }: { where: Row }) =>
        where.organizationId === scope.organizationId &&
        ['branch_a', 'branch_b'].includes(String(where.id))
          ? { id: where.id, active: true }
          : null
      ),
    },
    pharmacyStockSignal: {
      findFirst: vi.fn(async ({ where }: { where: Row }) =>
        where.id === signal.id &&
        where.organizationId === signal.organizationId &&
        where.branchId === signal.branchId
          ? signal
          : null
      ),
    },
    pharmacySafetyStock: { findMany: vi.fn(async () => facts.safetyStocks) },
    pharmacyStockMovement: {
      aggregate: vi.fn(async () => ({ _max: { occurredAt: now } })),
      create: create('movement'),
    },
    medicine: { findFirst: vi.fn(async () => ({ id: 'medicine_a', coldChain: false })) },
    packLevel: { findFirst: vi.fn(async () => pack), findMany: vi.fn(async () => [pack]) },
    pharmacyInventoryLot: { findFirst: vi.fn(async () => lot) },
    pharmacyStockLocation: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => ({
        id: String(where.id),
        coldChain: false,
      })),
    },
    pharmacyStockBalance: {
      findFirst: vi.fn(async () => ({ onHandUnits: 100 })),
      aggregate: vi.fn(async () => ({ _sum: { onHandUnits: 100 } })),
    },
    pharmacySupplierClaim: {
      aggregate: vi.fn(async () => ({ _sum: { reservedUnits: 0 } })),
      create: create('reservation'),
    },
    pharmacyRecallNotice: { findFirst: vi.fn(async (): Promise<Row | null> => null) },
    pharmacySupplier: { findFirst: vi.fn(async () => ({ id: 'supplier_a' })) },
    pharmacyGoodsReceiptLine: { findFirst: vi.fn(async () => ({ id: 'receipt_line_a' })) },
    pharmacyRequisition: { create: create('requisition') },
    pharmacyRequisitionLine: { create: create('requisitionLine') },
    pharmacyInterbranchTransfer: { create: create('transfer') },
    pharmacyInterbranchTransferLine: { createMany: create('transferLines') },
    pharmacyPurchaseReturn: { create: create('claim') },
    pharmacyPurchaseReturnLine: { createMany: create('claimLines') },
    pharmacyStockSignalEvent: { create: create('event') },
    pharmacyPurchaseOrder: { create: create('purchaseOrder') },
    $transaction: vi.fn(async <T>(run: (tx: ScopedDb) => Promise<T>): Promise<T> =>
      run(db as unknown as ScopedDb)
    ),
  };
  const run = (value = input, actingScope = scope) =>
    createDraftAction(db as unknown as ScopedDb, actingScope, value);
  const caller = pharmacyInventoryRouter.createCaller({
    db,
    entitlements: { organizationId: scope.organizationId, enabledModules: ['pharmacy-inventory'] },
    session: {
      user: {
        id: scope.actorId,
        role: 'ADMIN',
        status: 'ACTIVE',
        organizationId: scope.organizationId,
      },
    },
    requestMeta: { ip: null, userAgent: null },
  } as unknown as TRPCContext);
  return { db, facts, signal, actions, writes, binding, user, pack, lot, run, caller };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.useRealTimers();
});

function noBusinessEffects(f: ReturnType<typeof fixture>) {
  expect(f.db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  expect(f.db.pharmacySupplierClaim.create).not.toHaveBeenCalled();
  expect(f.db.pharmacyPurchaseOrder.create).not.toHaveBeenCalled();
}

describe('Pharmacy native draft replay intent (source doubles, no DB proof)', () => {
  it.each([requisition, transfer, claim])(
    'returns the original $kind action/reference on identical replay',
    async (input) => {
      const f = fixture(input);
      const first = await f.run();
      const replay = await f.run(structuredClone(input));
      expect(replay).toEqual(first);
      expect(f.actions).toHaveLength(1);
      expect(f.writes).toHaveLength(4);
      expect(f.db.pharmacyStockSignalEvent.create).toHaveBeenCalledTimes(1);
      const draft = [
        f.db.pharmacyRequisition.create,
        f.db.pharmacyInterbranchTransfer.create,
        f.db.pharmacyPurchaseReturn.create,
      ].find((create) => create.mock.calls.length)!;
      expect(draft.mock.calls[0][0].data.status).toBe('DRAFT');
      noBusinessEffects(f);
    }
  );

  it('normalizes reference whitespace and key whitespace, ignores property insertion order', async () => {
    const f = fixture();
    const first = await f.run({
      ...requisition,
      reference: ' REQ-A ',
      idempotencyKey: ' intent-a ',
    });
    expect(
      await f.run({
        quantityPacks: 10,
        canonicalUnitsPerPack: 10,
        packLevelId: 'pack_a',
        medicineId: 'medicine_a',
        reference: 'REQ-A',
        signalId: 'signal_a',
        kind: 'DRAFT_REQUISITION',
        idempotencyKey: 'intent-a',
      })
    ).toEqual(first);
  });

  it.each([requisition, claim])(
    'reuses the existing unique native reference when a key is omitted: $kind',
    async (input) => {
      const f = fixture(input);
      const value = { ...input, idempotencyKey: undefined };
      expect(await f.run(value)).toEqual(await f.run(value));
      expect(f.actions).toHaveLength(1);
    }
  );

  it('rejects transfer without durable identity before any write', async () => {
    const f = fixture(transfer);
    await expect(f.run({ ...transfer, idempotencyKey: undefined })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(f.writes).toEqual([]);
  });

  it.each([
    { ...requisition, quantityPacks: 11 },
    { ...requisition, neededBy: tomorrow },
    { ...requisition, reference: 'REQ-B' },
    { ...requisition, medicineId: 'medicine_b' },
    { ...requisition, signalId: 'signal_b' },
    transfer,
  ])('conflicts when the same identity changes semantic input %#', async (changed) => {
    const f = fixture();
    await f.run();
    await expect(f.run(changed)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'IDEMPOTENCY_CONFLICT',
    });
    expect(f.writes).toHaveLength(4);
    noBusinessEffects(f);
  });

  it('normalizes claim reason/date input and conflicts on quantity changes', async () => {
    const f = fixture(claim);
    const first = await f.run();
    expect(
      await f.run({
        ...claim,
        lines: [
          {
            ...claim.lines[0],
            reason: ' Expiry ',
            returnWindowEndsAt: new Date(tomorrow.toISOString()),
          },
        ],
      })
    ).toEqual(first);
    await expect(
      f.run({ ...claim, lines: [{ ...claim.lines[0], quantityUnits: 11 }] })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('conflicts on changed transfer destination', async () => {
    const f = fixture(transfer);
    await f.run();
    await expect(
      f.run({ ...transfer, lines: [{ ...transfer.lines[0], destinationStockLocationId: 'other' }] })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('returns the original result after the original signal closes without re-evaluating stock', async () => {
    const f = fixture();
    const first = await f.run();
    f.signal.status = 'CLOSED';
    f.facts.safetyStocks = [];
    expect(await f.run()).toEqual(first);
    expect(f.db.medicine.findFirst).toHaveBeenCalledTimes(1);
  });

  it.each(['tenant', 'branch', 'actor', 'inactive', 'capability', 'branch-inactive'] as const)(
    'denies %s scope on replay before exposing a result',
    async (denial) => {
      const f = fixture();
      await f.run();
      if (denial === 'tenant') f.binding.organizationId = 'org_b';
      if (denial === 'branch') f.binding.branchId = 'branch_b';
      if (denial === 'inactive') f.user.status = 'INACTIVE';
      if (denial === 'capability')
        f.user.permissionOverrides = [{ capability: 'pharmacy.procurement', effect: 'DENY' }];
      if (denial === 'branch-inactive') f.db.pharmacyBranch.findFirst.mockResolvedValue(null);
      await expect(
        f.run(requisition, denial === 'actor' ? { ...scope, actorId: 'other' } : scope)
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.actions).toHaveLength(1);
      expect(f.writes).toHaveLength(4);
    }
  );

  it('does not return a different branch action for the same key', async () => {
    const f = fixture();
    await f.run();
    await expect(f.run(requisition, { ...scope, branchId: 'branch_b' })).rejects.toMatchObject({
      reason: 'NOT_FOUND',
    });
    expect(f.actions).toHaveLength(1);
  });

  it('checks the donor active branch and native inventory capability for transfers', async () => {
    const f = fixture(transfer);
    f.user.organizationRole.permissions = [{ capability: 'pharmacy.procurement', effect: 'ALLOW' }];
    await expect(f.run()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.writes).toEqual([]);
  });

  it.each(['CLOSED', 'DISMISSED', 'STALE', 'SNOOZED'])(
    'rejects %s signal before first creation',
    async (status) => {
      const f = fixture();
      f.signal.status = status;
      f.signal.snoozedUntil = tomorrow;
      await expect(f.run()).rejects.toMatchObject({ reason: 'INVALID_STATE' });
      expect(f.writes).toEqual([]);
    }
  );

  it('rejects stale computed data even without a persisted STALE marker', async () => {
    const f = fixture();
    f.signal.computedAt = new Date(0);
    await expect(f.run()).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    expect(f.writes).toEqual([]);
  });

  it('rejects a signal no longer produced from current facts', async () => {
    const f = fixture();
    f.facts.safetyStocks = [];
    await expect(f.run()).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    expect(f.writes).toEqual([]);
  });

  it.each(['medicine', 'pack', 'conversion', 'expired-pack', 'overflow'] as const)(
    'rejects invalid requisition %s before writes',
    async (invalid) => {
      const f = fixture();
      if (invalid === 'pack') f.db.packLevel.findFirst.mockResolvedValue(null as never);
      if (invalid === 'expired-pack') f.pack.effectiveFrom = tomorrow;
      const input = {
        ...requisition,
        ...(invalid === 'medicine' ? { medicineId: 'other' } : {}),
        ...(invalid === 'conversion' ? { canonicalUnitsPerPack: 11 } : {}),
        ...(invalid === 'overflow' ? { quantityPacks: 2_147_483_647 } : {}),
      };
      await expect(f.run(input)).rejects.toBeDefined();
      expect(f.writes).toEqual([]);
      if (invalid === 'pack')
        expect(f.db.packLevel.findFirst).toHaveBeenCalledWith({
          where: {
            id: 'pack_a',
            organizationId: 'org_a',
            presentation: { organizationId: 'org_a', medicineId: 'medicine_a' },
          },
        });
    }
  );

  it.each(['lot', 'location', 'medicine', 'expired', 'recall', 'reserved', 'duplicate'] as const)(
    'rejects ineligible transfer %s before writes',
    async (invalid) => {
      const f = fixture(transfer);
      if (invalid === 'lot') f.db.pharmacyInventoryLot.findFirst.mockResolvedValue(null as never);
      if (invalid === 'location')
        f.db.pharmacyStockLocation.findFirst.mockResolvedValue(null as never);
      if (invalid === 'medicine') f.lot.batch.medicineId = 'other';
      if (invalid === 'expired') f.lot.batch.expiresAt = now;
      if (invalid === 'recall')
        f.db.pharmacyRecallNotice.findFirst.mockResolvedValue({ id: 'recall_a' });
      if (invalid === 'reserved')
        f.db.pharmacySupplierClaim.aggregate.mockResolvedValue({ _sum: { reservedUnits: 95 } });
      const value =
        invalid === 'duplicate'
          ? {
              ...transfer,
              lines: [
                { ...transfer.lines[0], quantityUnits: 60 },
                { ...transfer.lines[0], quantityUnits: 60 },
              ],
            }
          : transfer;
      await expect(f.run(value)).rejects.toBeDefined();
      expect(f.writes).toEqual([]);
      noBusinessEffects(f);
    }
  );

  it.each(['supplier', 'receipt', 'window', 'credit', 'lot'] as const)(
    'rejects invalid claim %s before writes',
    async (invalid) => {
      const f = fixture(claim);
      if (invalid === 'supplier') f.db.pharmacySupplier.findFirst.mockResolvedValue(null as never);
      if (invalid === 'receipt')
        f.db.pharmacyGoodsReceiptLine.findFirst.mockResolvedValue(null as never);
      if (invalid === 'lot') f.signal.inventoryLotId = 'other';
      const value = {
        ...claim,
        lines: [
          {
            ...claim.lines[0],
            ...(invalid === 'window' ? { returnWindowEndsAt: now } : {}),
            ...(invalid === 'credit' ? { expectedCreditMinor: -1 } : {}),
          },
        ],
      };
      await expect(f.run(value)).rejects.toBeDefined();
      expect(f.writes).toEqual([]);
      noBusinessEffects(f);
    }
  );

  it('propagates event failures out of the owning transaction; never converts them into success', async () => {
    const f = fixture();
    f.db.pharmacyStockSignalEvent.create.mockRejectedValue(new Error('event failed'));
    await expect(
      f.caller.createDraftAction({ ...requisition, branchId: scope.branchId })
    ).rejects.toThrow('event failed');
    expect(f.db.$transaction).toHaveBeenCalledTimes(1);
    noBusinessEffects(f);
  });

  it('preserves supplied identity through transport and exposes semantic conflict as CONFLICT', async () => {
    const f = fixture();
    const first = await f.caller.createDraftAction({ ...requisition, branchId: scope.branchId });
    expect(await f.caller.createDraftAction({ ...requisition, branchId: scope.branchId })).toEqual(
      first
    );
    await expect(
      f.caller.createDraftAction({ ...requisition, quantityPacks: 11, branchId: scope.branchId })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.actions).toHaveLength(1);
  });

  it('maps denied draft capability to transport FORBIDDEN', async () => {
    const f = fixture();
    f.user.organizationRole.permissions = [];
    await expect(
      f.caller.createDraftAction({ ...requisition, branchId: scope.branchId })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.writes).toEqual([]);
  });
});
