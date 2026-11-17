/**
 * PH-INV / INV-01..04 — the transport layer.
 *
 * These cases cover only what the router itself owns: the `pharmacy-inventory`
 * entitlement mapping, the refusal to take the tenant or the actor from the
 * payload, and cross-tenant ID substitution on the two references the router
 * checks before it reaches the ledger. Every invariant the ledger and its
 * triggers own is proved against a real database in
 * `lib/pharmacy/stock-ledger.db.test.ts`, not here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const hasModule = vi.fn<(view: { enabledModules: string[] }, key: string) => boolean>();
  hasModule.mockReturnValue(true);
  const postWriteOffEntry = vi.fn();
  const postInterbranchTransferLossEntry = vi.fn();
  const afterTenantTransaction = vi.fn<(work: () => void) => void>();
  const withTenantDb = vi.fn();
  // DEV-628: a witness PIN matches the stored hash `hash:<pin>`; no bcrypt in unit tests.
  const verifyOperatorCredential = vi.fn(
    async (_type: string, secret: string, credentialHash: string) =>
      credentialHash === `hash:${secret}`
  );
  return {
    verifyOperatorCredential,
    hasModule,
    postWriteOffEntry,
    postInterbranchTransferLossEntry,
    afterTenantTransaction,
    withTenantDb,
  };
});
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(() => ({})),
  withTenantDb: mocks.withTenantDb,
}));
vi.mock('@/lib/side-effects/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/side-effects/scope')>()),
  afterTenantTransaction: mocks.afterTenantTransaction,
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/restaurant/operator-credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/restaurant/operator-credentials')>()),
  verifyOperatorCredential: mocks.verifyOperatorCredential,
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.hasModule,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/finance-postings', () => ({
  postWriteOffEntry: mocks.postWriteOffEntry,
  postInterbranchTransferLossEntry: mocks.postInterbranchTransferLossEntry,
}));

import { Prisma } from '@/generated/prisma/client';
import { FinancePostingError } from '@/lib/finance/journal';
import { moduleForProcedure } from '@/lib/module-catalog';
import { EXPIRY_CLAIM_MAX_POSITIONS } from '@/lib/pharmacy/expiry-claim';
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';

import { admittedInventoryBranchIds, pharmacyInventoryRouter } from './pharmacy-inventory';
import type { TRPCContext } from '../trpc';

function model() {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    create: vi
      .fn()
      .mockImplementation(async ({ data }: { data: object }) => ({ id: 'new', ...data })),
    update: vi.fn(),
    count: vi.fn(),
  };
}

function makeDb() {
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: { permissions: [] },
        permissionOverrides: [],
      }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    medicine: model(),
    packLevel: model(),
    camera: model(),
    pharmacyStockLocation: model(),
    pharmacyColdChainSensor: Object.assign(model(), {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'sensor_existing' }),
    }),
    pharmacyTemperatureLog: Object.assign(model(), {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    }),
    pharmacyManufacturingBatch: Object.assign(model(), {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    }),
    pharmacyRecallNotice: model(),
    pharmacyInventoryLot: model(),
    pharmacySupplier: model(),
    pharmacySupplierClaim: model(),
    pharmacyStockMovement: model(),
    pharmacyCustodyRecord: model(),
    pharmacyStockBalance: model(),
    pharmacyRecallQuarantineAction: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    pharmacyAllocationOverride: model(),
    pharmacyStockDiscrepancy: model(),
    pharmacyRecallAcknowledgement: model(),
    pharmacySafetyStock: Object.assign(model(), {
      upsert: vi
        .fn()
        .mockImplementation(async ({ create }: { create: object }) => ({ id: 'new', ...create })),
      findMany: vi.fn().mockResolvedValue([]),
    }),
    pharmacyStockSignal: Object.assign(model(), { findMany: vi.fn().mockResolvedValue([]) }),
    pharmacyStockSignalEvent: model(),
    pharmacyStockSignalAction: model(),
    pharmacyRequisition: model(),
    pharmacyRequisitionLine: model(),
    pharmacyInterbranchTransfer: model(),
    pharmacyPurchaseReturn: model(),
    pharmacyPurchaseReturnLine: model(),
    restaurantOperatorCredential: model(),
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    pharmacyBranchAssignment: {
      findFirst: vi.fn().mockResolvedValue({ id: 'assignment_a' }),
      findMany: vi.fn().mockResolvedValue([{ branchId: 'branch_a' }]),
    },
    pharmacyBranch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'branch_a' }),
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        (where.id?.in ?? []).map((id) => ({ id }))
      ),
    },
  };
  return Object.assign(db, {
    $transaction: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)),
    $queryRaw: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []),
  });
}

let db = makeDb();
/** The session role every caller() carries; reset to ADMIN before each test. */
let sessionRole: 'ADMIN' | 'EMPLOYEE' = 'ADMIN';
/** Extra session-user fields, e.g. a platform support session. Reset before each test. */
let sessionExtras: Record<string, unknown> = {};
function caller(overrides: { enabledModules?: string[]; userId?: string | null } = {}) {
  return pharmacyInventoryRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules: overrides.enabledModules ?? ['pharmacy-inventory'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session:
      overrides.userId === null
        ? null
        : {
            expires: 'later',
            user: {
              id: overrides.userId ?? 'user_a',
              role: sessionRole,
              status: 'ACTIVE',
              ...sessionExtras,
            },
          },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const allow = (capability: string): Rule => ({ capability, effect: 'ALLOW' });
const deny = (capability: string): Rule => ({ capability, effect: 'DENY' });

/** What `can()` reads: the member's role rules and their own overrides. */
function grant(role: Rule[], overrides: Rule[] = []) {
  db.user.findUnique.mockResolvedValue({
    organizationRole: { permissions: role },
    permissionOverrides: overrides,
  });
}

/** DEV-628: the named witness has a live PIN, verified in its own tenant transaction. */
function witnessPinOnFile(pin = '2468') {
  db.restaurantOperatorCredential.findFirst.mockResolvedValue({
    id: 'credential_witness',
    credentialHash: `hash:${pin}`,
    failedAttempts: 0,
    lockedUntil: null,
  });
  mocks.withTenantDb.mockImplementation(async (_org: string, run: (tx: unknown) => unknown) =>
    run(db)
  );
}

/** The capability middleware's refusal, as opposed to a handler's own FORBIDDEN. */
const CAPABILITY_REFUSAL = {
  code: 'FORBIDDEN',
  message: 'You do not have permission for this action.',
};

beforeEach(() => {
  db = makeDb();
  sessionRole = 'ADMIN';
  sessionExtras = {};
  mocks.afterTenantTransaction.mockReset();
  mocks.withTenantDb.mockReset();
  mocks.hasModule.mockImplementation((view, key) => view.enabledModules.includes(key));
  mocks.postWriteOffEntry.mockReset();
  mocks.postInterbranchTransferLossEntry.mockReset();
});

describe('pharmacy write-off accounting', () => {
  it('posts the write-off journal in the same transaction as the stock movement', async () => {
    grant([allow('pharmacy:inventory')]);
    witnessPinOnFile();
    db.user.findFirst.mockResolvedValue({ id: 'user_b' });
    const occurredAt = new Date('2026-10-29T00:02:07.000Z');
    db.user.findFirst.mockResolvedValue({ id: 'user_b' });
    db.pharmacyInventoryLot.findFirst.mockResolvedValue({
      id: 'lot_1',
      unitsPerPack: 10,
    });
    db.pharmacyStockBalance.findFirst.mockResolvedValue({
      onHandUnits: 20,
      sealedPacks: 2,
      looseUnits: 0,
    });
    db.pharmacyStockMovement.create.mockResolvedValue({
      id: 'movement_1',
      occurredAt,
    });

    await caller().writeOff({
      branchId: 'branch_a',
      inventoryLotId: 'lot_1',
      stockLocationId: 'location_1',
      units: 10,
      witnessId: 'user_b',
      witnessPin: '2468',
      reason: 'Expired stock destroyed',
      evidenceRef: 'DEST-1',
      idempotencyKey: 'writeoff-1',
    });

    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(mocks.postWriteOffEntry).toHaveBeenCalledWith(
      db,
      { organizationId: 'org_a', branchId: 'branch_a', actorId: 'user_a' },
      { stockMovementId: 'movement_1', at: occurredAt }
    );
  });
});

describe('transfer short-close accounting (DEV-131)', () => {
  it('journals the units written off out of transit in the same transaction', async () => {
    grant([allow('pharmacy:inventory')]);
    witnessPinOnFile();
    db.user.findFirst.mockResolvedValue({ id: 'user_b' });
    db.$queryRaw
      .mockResolvedValueOnce([{ id: 'transfer_1' }] as never)
      // DEV-825: the witness credential (document class) is locked before any
      // stock row, then the IN_TRANSIT balances are locked before they are read.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { onHandUnits: 20, sealedPacks: 2, looseUnits: 0, unitsPerPack: 10 },
      ] as never);
    db.pharmacyInterbranchTransfer.findFirst.mockResolvedValue({
      id: 'transfer_1',
      status: 'DISPATCHED',
      fromBranchId: 'branch_src',
      toBranchId: 'branch_a',
      lines: [
        {
          id: 'line_1',
          sourceLotId: 'lot_src',
          sourceStockLocationId: 'location_src',
          destinationStockLocationId: 'location_1',
          quantityUnits: 20,
          receivedUnits: 0,
        },
      ],
    });
    const occurredAt = new Date('2026-11-02T09:00:00.000Z');
    db.pharmacyStockMovement.create.mockResolvedValue({ id: 'loss_movement', occurredAt });

    await caller().receiveTransferWithVariance({
      branchId: 'branch_a',
      transferId: 'transfer_1',
      lines: [{ lineId: 'line_1', receivedUnits: 0 }],
      variance: {
        reason: 'Lost in transit',
        witnessId: 'user_b',
        witnessPin: '2468',
        evidenceRef: 'COURIER-1',
      },
      idempotencyKeyPrefix: 'receive-1',
    });

    expect(db.pharmacyStockMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'WRITE_OFF',
        disposition: 'IN_TRANSIT',
        quantityUnits: -20,
      }),
    });
    expect(mocks.postInterbranchTransferLossEntry).toHaveBeenCalledWith(
      db,
      { organizationId: 'org_a', branchId: 'branch_a', actorId: 'user_a' },
      { transferLineId: 'line_1', stockMovementId: 'loss_movement', at: occurredAt }
    );
  });
});

describe('DEV-877 transfer postings inside a closed accounting period', () => {
  it('refuses a transit loss with a typed PERIOD_CLOSED instead of an internal error', async () => {
    grant([allow('pharmacy:inventory')]);
    witnessPinOnFile();
    db.user.findFirst.mockResolvedValue({ id: 'user_b' });
    db.$queryRaw
      .mockResolvedValueOnce([{ id: 'transfer_1' }] as never)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { onHandUnits: 20, sealedPacks: 2, looseUnits: 0, unitsPerPack: 10 },
      ] as never);
    db.pharmacyInterbranchTransfer.findFirst.mockResolvedValue({
      id: 'transfer_1',
      status: 'DISPATCHED',
      fromBranchId: 'branch_src',
      toBranchId: 'branch_a',
      lines: [
        {
          id: 'line_1',
          sourceLotId: 'lot_src',
          sourceStockLocationId: 'location_src',
          destinationStockLocationId: 'location_1',
          quantityUnits: 20,
          receivedUnits: 0,
        },
      ],
    });
    db.pharmacyStockMovement.create.mockResolvedValue({
      id: 'loss_movement',
      occurredAt: new Date('2026-11-02T09:00:00.000Z'),
    });
    mocks.postInterbranchTransferLossEntry.mockRejectedValueOnce(
      new FinancePostingError('PERIOD_CLOSED')
    );

    await expect(
      caller().receiveTransferWithVariance({
        branchId: 'branch_a',
        transferId: 'transfer_1',
        lines: [{ lineId: 'line_1', receivedUnits: 0 }],
        variance: {
          reason: 'Lost in transit',
          witnessId: 'user_b',
          witnessPin: '2468',
          evidenceRef: 'COURIER-1',
        },
        idempotencyKeyPrefix: 'receive-1',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'PERIOD_CLOSED' });
  });
});

describe('DEV-825 transfer receipt lock order', () => {
  it('locks every IN_TRANSIT balance, sorted, before reading or writing any line', async () => {
    grant([allow('pharmacy:inventory')]);
    witnessPinOnFile();
    db.user.findFirst.mockResolvedValue({ id: 'user_b' });
    db.$queryRaw.mockImplementation(async (sql: unknown) => {
      const text = (sql as { strings?: string[] }).strings?.join('') ?? '';
      if (text.includes('pharmacy_interbranch_transfers')) return [{ id: 'transfer_1' }];
      if (text.includes('FOR UPDATE')) return [];
      return [{ onHandUnits: 20, sealedPacks: 2, looseUnits: 0, unitsPerPack: 10 }];
    });
    const transitLine = (id: string, lot: string) => ({
      id,
      sourceLotId: lot,
      sourceStockLocationId: 'location_src',
      destinationStockLocationId: 'location_1',
      quantityUnits: 20,
      receivedUnits: 0,
    });
    db.pharmacyInterbranchTransfer.findFirst.mockResolvedValue({
      id: 'transfer_1',
      status: 'DISPATCHED',
      fromBranchId: 'branch_src',
      toBranchId: 'branch_a',
      lines: [transitLine('line_2', 'lot_b'), transitLine('line_1', 'lot_a')],
    });
    db.pharmacyStockMovement.create.mockResolvedValue({ id: 'loss', occurredAt: new Date() });

    await caller().receiveTransferWithVariance({
      branchId: 'branch_a',
      transferId: 'transfer_1',
      lines: [
        { lineId: 'line_2', receivedUnits: 0 },
        { lineId: 'line_1', receivedUnits: 0 },
      ],
      variance: {
        reason: 'Lost in transit',
        witnessId: 'user_b',
        witnessPin: '2468',
        evidenceRef: 'COURIER-1',
      },
      idempotencyKeyPrefix: 'receive-2',
    });

    const statements = db.$queryRaw.mock.calls.map(
      ([sql]) => sql as unknown as { strings: string[]; values: unknown[] }
    );
    const lockIndex = statements.findIndex((sql) =>
      sql.strings?.join('').includes('stock_lock:balance')
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(statements[lockIndex]!.values).toEqual([
      'org_a',
      'branch_src',
      'lot_a',
      'location_src',
      'IN_TRANSIT',
      'lot_b',
      'location_src',
      'IN_TRANSIT',
    ]);
    // The witness credential is a document-class lock: it comes before any stock row.
    const credentialIndex = statements.findIndex((sql) =>
      (sql.strings?.join('') ?? (sql as unknown as string[]).join?.('') ?? '').includes(
        'restaurant_operator_credentials'
      )
    );
    expect(credentialIndex).toBeGreaterThanOrEqual(0);
    expect(credentialIndex).toBeLessThan(lockIndex);
    // Every balance read and write comes after that one lock; no per-line lock remains.
    statements.slice(lockIndex + 1).forEach((sql) => {
      expect(sql.strings?.join('') ?? '').not.toMatch(/pharmacy_stock_balances[\s\S]*FOR UPDATE/);
    });
    expect(db.$queryRaw.mock.invocationCallOrder[lockIndex]).toBeLessThan(
      db.pharmacyStockMovement.create.mock.invocationCallOrder[0]!
    );
  });
});

describe('DEV-728 distributor expiry claim draft', () => {
  const soon = () => new Date(Date.now() + 20 * 86_400_000);
  function lotRow(id: string, unitCostMinor = 1_000) {
    return {
      id,
      unitCostMinor,
      supplierName: 'Distributor',
      batch: { batchNumber: `B-${id}`, expiresAt: soon(), state: 'ACTIVE', medicine: {} },
    };
  }
  function prepare({
    open = new Set<string>(),
    reserved = {} as Record<string, number>,
    receivedFrom = { supplierId: 'supplier_1', supplier: { active: true } } as {
      supplierId: string;
      supplier: { active: boolean };
    } | null,
  }: {
    open?: Set<string>;
    reserved?: Record<string, number>;
    receivedFrom?: { supplierId: string; supplier: { active: boolean } } | null;
  } = {}) {
    grant([allow('pharmacy:inventory')]);
    const receiptLine = {
      findFirst: vi.fn().mockResolvedValue(receivedFrom ? { goodsReceipt: receivedFrom } : null),
    };
    Object.assign(db, { pharmacyGoodsReceiptLine: receiptLine });
    db.pharmacySupplier.findFirst.mockResolvedValue({ id: 'supplier_1', name: 'Distributor' });
    db.pharmacyInventoryLot.findFirst.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        lotRow(where.id, where.id === 'lot_2' ? 2_000 : 1_000)
    );
    db.pharmacyStockLocation.findFirst.mockResolvedValue({ id: 'location_1' });
    db.pharmacyStockBalance.findFirst.mockResolvedValue({ onHandUnits: 10 });
    db.pharmacyPurchaseReturnLine.findFirst.mockImplementation(
      async ({ where }: { where: { inventoryLotId: string } }) =>
        open.has(where.inventoryLotId)
          ? { purchaseReturn: { id: 'ret_old', reference: 'EXP-OLD', status: 'DRAFT' } }
          : null
    );
    const aggregate = vi.fn(async ({ where }: { where: { inventoryLotId: string } }) => ({
      _sum: { reservedUnits: reserved[where.inventoryLotId] ?? null },
    }));
    const createMany = vi.fn().mockResolvedValue({ count: 0 });
    const findFirstOrThrow = vi.fn().mockResolvedValue({
      id: 'ret_new',
      reference: 'EXPC-NEW',
      status: 'DRAFT',
    });
    Object.assign(db.pharmacySupplierClaim, { aggregate });
    Object.assign(db.pharmacyPurchaseReturnLine, { createMany });
    Object.assign(db.pharmacyPurchaseReturn, { findFirstOrThrow });
    return { createMany };
  }
  const claim = (positions: string[]) =>
    caller().draftExpiryReturnClaim({
      branchId: 'branch_a',
      supplierId: 'supplier_1',
      positions: positions.map((inventoryLotId) => ({
        inventoryLotId,
        stockLocationId: 'location_1',
      })),
      reason: 'Near-expiry return claim',
    });

  it('drafts one EXPIRY_CLAIM for the distributor with every claimable lot as a line', async () => {
    const { createMany } = prepare({ reserved: { lot_2: 4 } });

    const result = await claim(['lot_2', 'lot_1']);

    expect(result).toEqual({
      created: true,
      purchaseReturn: { id: 'ret_new', reference: 'EXPC-NEW', status: 'DRAFT' },
      lineCount: 2,
      skipped: 0,
    });
    expect(db.pharmacyPurchaseReturn.create).toHaveBeenCalledOnce();
    expect(db.pharmacyPurchaseReturn.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org_a',
        branchId: 'branch_a',
        supplierId: 'supplier_1',
        kind: 'EXPIRY_CLAIM',
        createdByUserId: 'user_a',
      }),
    });
    // Only unreserved units are claimed, and the credit is priced at the lot cost.
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          lineNumber: 1,
          inventoryLotId: 'lot_1',
          quantityUnits: 10,
          expectedCreditMinor: 10_000,
        }),
        expect.objectContaining({
          lineNumber: 2,
          inventoryLotId: 'lot_2',
          quantityUnits: 6,
          expectedCreditMinor: 12_000,
        }),
      ],
    });
    // Every lot is locked before it is read.
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('skips lots already on an open return or fully reserved', async () => {
    const { createMany } = prepare({ open: new Set(['lot_1']), reserved: { lot_3: 10 } });

    const result = await claim(['lot_1', 'lot_2', 'lot_3']);

    expect(result).toMatchObject({ created: true, lineCount: 1, skipped: 2 });
    expect(createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ inventoryLotId: 'lot_2', quantityUnits: 10 })],
    });
  });

  it('replays the existing return instead of drafting a duplicate claim', async () => {
    prepare({ open: new Set(['lot_1']) });

    await expect(claim(['lot_1'])).resolves.toEqual({
      created: false,
      purchaseReturn: { id: 'ret_old', reference: 'EXP-OLD', status: 'DRAFT' },
      lineCount: 0,
      skipped: 0,
    });
    expect(db.pharmacyPurchaseReturn.create).not.toHaveBeenCalled();
  });

  it('refuses when no unit is left to claim', async () => {
    prepare({ reserved: { lot_1: 10 } });

    await expect(claim(['lot_1'])).rejects.toMatchObject({ message: 'INSUFFICIENT_STOCK' });
    expect(db.pharmacyPurchaseReturn.create).not.toHaveBeenCalled();
  });

  it('refuses a supplier outside the workspace before touching any lot', async () => {
    prepare();
    db.pharmacySupplier.findFirst.mockResolvedValue(null);

    await expect(claim(['lot_1'])).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Supplier is outside this workspace.',
    });
    expect(db.pharmacySupplier.findFirst).toHaveBeenCalledWith({
      where: { id: 'supplier_1', organizationId: 'org_a', active: true },
      select: { id: true, name: true },
    });
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.pharmacyPurchaseReturn.create).not.toHaveBeenCalled();
  });

  it('leaves expired lots off the claim, since their return window has closed', async () => {
    const { createMany } = prepare();
    const lots = db.pharmacyInventoryLot.findFirst.getMockImplementation()!;
    db.pharmacyInventoryLot.findFirst.mockImplementation(
      async (args: { where: { id: string } }) => {
        const lot = await lots(args);
        return args.where.id === 'lot_1'
          ? { ...lot, batch: { ...lot.batch, expiresAt: new Date(Date.now() - 86_400_000) } }
          : lot;
      }
    );

    await expect(claim(['lot_1', 'lot_2'])).resolves.toMatchObject({
      created: true,
      lineCount: 1,
      skipped: 1,
    });
    expect(createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ inventoryLotId: 'lot_2' })],
    });
  });

  it('refuses a claim whose every lot has expired', async () => {
    prepare();
    db.pharmacyInventoryLot.findFirst.mockResolvedValue({
      ...lotRow('lot_1'),
      batch: {
        batchNumber: 'B',
        expiresAt: new Date(Date.now() - 86_400_000),
        state: 'ACTIVE',
        medicine: {},
      },
    });

    await expect(claim(['lot_1'])).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'RETURN_WINDOW_CLOSED',
    });
    expect(db.pharmacyPurchaseReturn.create).not.toHaveBeenCalled();
  });

  it('refuses more positions than one claim may carry', async () => {
    prepare();
    await expect(
      claim(Array.from({ length: EXPIRY_CLAIM_MAX_POSITIONS + 1 }, (_, i) => `lot_${i}`))
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacyPurchaseReturn.create).not.toHaveBeenCalled();
  });

  it('checks each lot against the supplier on its posted goods receipt', async () => {
    prepare();

    await expect(claim(['lot_1'])).resolves.toMatchObject({ created: true });
    expect(
      (db as unknown as { pharmacyGoodsReceiptLine: { findFirst: ReturnType<typeof vi.fn> } })
        .pharmacyGoodsReceiptLine.findFirst
    ).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_a',
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        goodsReceipt: { status: 'POSTED' },
      },
      select: {
        goodsReceipt: { select: { supplierId: true, supplier: { select: { active: true } } } },
      },
    });
  });

  it('refuses a lot received from a different supplier', async () => {
    prepare({ receivedFrom: { supplierId: 'supplier_2', supplier: { active: true } } });

    await expect(claim(['lot_1'])).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'A lot on this claim did not come from that supplier.',
    });
    expect(db.pharmacyPurchaseReturn.create).not.toHaveBeenCalled();
  });

  it('falls back to the supplier name on the lot without an active receipt supplier', async () => {
    prepare({ receivedFrom: null });
    db.pharmacyInventoryLot.findFirst.mockResolvedValue({
      ...lotRow('lot_1'),
      supplierName: '  distributor ',
    });
    await expect(claim(['lot_1'])).resolves.toMatchObject({ created: true });

    db = makeDb();
    prepare({ receivedFrom: { supplierId: 'supplier_2', supplier: { active: false } } });
    db.pharmacyInventoryLot.findFirst.mockResolvedValue({
      ...lotRow('lot_1'),
      supplierName: 'Another distributor',
    });
    await expect(claim(['lot_1'])).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'A lot on this claim did not come from that supplier.',
    });
    expect(db.pharmacyPurchaseReturn.create).not.toHaveBeenCalled();
  });

  it('refuses a lot beyond the action horizon', async () => {
    prepare();
    db.pharmacyInventoryLot.findFirst.mockResolvedValue({
      ...lotRow('lot_1'),
      batch: {
        batchNumber: 'B',
        expiresAt: new Date(Date.now() + 400 * 86_400_000),
        state: 'ACTIVE',
        medicine: {},
      },
    });

    await expect(claim(['lot_1'])).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacyPurchaseReturn.create).not.toHaveBeenCalled();
  });

  it('refuses duplicated positions and a caller without the inventory capability', async () => {
    prepare();
    await expect(claim(['lot_1', 'lot_1'])).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    grant([]);
    await expect(claim(['lot_1'])).rejects.toMatchObject(CAPABILITY_REFUSAL);
    expect(db.pharmacyPurchaseReturn.create).not.toHaveBeenCalled();
  });
});

describe('PH-A5 expiry recovery integration', () => {
  function position(id: string, expiresAt: Date, unitCostMinor = 2_500) {
    return {
      inventoryLotId: id,
      stockLocationId: 'location_1',
      onHandUnits: 10,
      location: { name: 'Main shelf' },
      lot: {
        supplierName: 'Fallback name',
        unitsPerPack: 10,
        unitCostMinor,
        printedMrpMinor: 5_000,
        batch: {
          batchNumber: 'B-1',
          expiresAt,
          state: 'ACTIVE',
          medicine: {
            productName: 'OTC medicine',
            brandName: null,
            rx: false,
            otc: true,
            restricted: false,
            controlled: false,
            productFamily: 'PHARMACEUTICAL',
          },
        },
        receiptLines: [{ goodsReceipt: { supplierId: 'supplier_1' } }],
      },
    };
  }

  it('uses the active branch relationship and returns risk/calendar facts', async () => {
    grant([allow('pharmacy:inventory'), allow('reports:financial')]);
    const expiresAt = new Date(Date.now() + 45 * 86_400_000);
    db.pharmacyStockBalance.findMany.mockResolvedValueOnce([position('lot_1', expiresAt)]);
    db.pharmacySupplier.findMany.mockResolvedValue([
      {
        id: 'supplier_1',
        name: 'Branch distributor',
        relationships: [{ expiryReturnWindowDays: 30 }],
      },
    ]);

    const board = await caller().expiryBoardLots({ branchId: 'branch_a', withinDays: 60 });

    expect(db.pharmacySupplier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          relationships: expect.objectContaining({
            where: { branchId: 'branch_a', active: true },
          }),
        }),
      })
    );
    expect(board.riskBuckets).toEqual([
      { days: 30, valueAtRiskMinor: 0 },
      { days: 60, valueAtRiskMinor: 25_000 },
      { days: 90, valueAtRiskMinor: 25_000 },
    ]);
    expect(board.rows[0]).toMatchObject({
      suggestedSupplierId: 'supplier_1',
      markdownEligible: true,
      returnDeadlineAt: expiresAt,
    });
    expect(board.rows[0]?.returnWindowOpensAt?.toISOString()).toBe(
      new Date(expiresAt.getTime() - 30 * 86_400_000).toISOString()
    );
  });

  it.each([30, 60, 90, 180] as const)(
    'keeps cumulative risk independent of the %s-day list filter and excludes expired stock',
    async (withinDays) => {
      grant([allow('pharmacy:inventory'), allow('reports:financial')]);
      const now = Date.now();
      const day = 86_400_000;
      const positions = [
        position('expired', new Date(now - day)),
        position('just_expired', new Date(now - 3_600_000)),
        position('lot_20', new Date(now + 20 * day), 12_500),
        position('lot_45', new Date(now + 45 * day), 7_500),
        position('lot_80', new Date(now + 80 * day), 5_000),
        position('lot_120', new Date(now + 120 * day), 10_000),
      ];
      db.pharmacyStockBalance.findMany.mockResolvedValueOnce(
        positions.filter(
          (row) => row.lot.batch.expiresAt.getTime() <= now + Math.max(withinDays, 90) * day
        )
      );

      const board = await caller().expiryBoardLots({ branchId: 'branch_a', withinDays });

      expect(db.pharmacyStockBalance.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: 'org_a',
            branchId: 'branch_a',
            lot: {
              batch: {
                expiresAt: {
                  lte: new Date(board.generatedAt.getTime() + Math.max(withinDays, 90) * day),
                },
              },
            },
          }),
        })
      );
      expect(board.riskBuckets).toEqual([
        { days: 30, valueAtRiskMinor: 125_000 },
        { days: 60, valueAtRiskMinor: 200_000 },
        { days: 90, valueAtRiskMinor: 250_000 },
      ]);
      expect(board.rows.map((row) => row.inventoryLotId)).toEqual(
        positions
          .filter((row) => row.lot.batch.expiresAt.getTime() <= now + withinDays * day)
          .map((row) => row.inventoryLotId)
      );
    }
  );

  describe('DEV-627: purchase cost on the expiry board', () => {
    /** A stored mark-down draft carries the lot's unit cost as evidence. */
    const storedDraft = (inventoryLotId: string, unitCostMinor: number) => ({
      inventoryLotId,
      stockLocationId: 'location_1',
      batchNumber: 'B-1',
      markdownPercent: 20,
      printedMrpMinor: 5_000,
      proposedPackPriceMinor: 4_000,
      unitsPerPack: 10,
      unitCostMinor,
      onHandUnits: 10,
      expiresAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
    });

    function seedBoard() {
      const now = Date.now();
      db.pharmacyStockBalance.findMany.mockResolvedValueOnce([
        position('lot_cheap', new Date(now + 20 * 86_400_000), 1_000),
        position('lot_dear', new Date(now + 20 * 86_400_000), 9_000),
      ]);
      db.pharmacyStockSignalEvent.findMany.mockResolvedValueOnce([
        {
          id: 'event_dear',
          reason: 'Near expiry',
          detail: `DRAFT mark-down ${JSON.stringify(storedDraft('lot_dear', 9_000))}`,
          createdAt: new Date(now - 86_400_000),
        },
      ]);
    }

    it('withholds unit cost, value at risk and PKR buckets from a cashier without reports:financial', async () => {
      sessionRole = 'EMPLOYEE';
      grant([allow('pharmacy:inventory'), allow('pharmacy:counter')]);
      seedBoard();

      const board = await caller().expiryBoardLots({ branchId: 'branch_a', withinDays: 30 });

      expect(board.costVisible).toBe(false);
      expect(board.riskBuckets).toEqual([]);
      expect(board.rows).toHaveLength(2);
      for (const row of board.rows) {
        expect(row).not.toHaveProperty('unitCostMinor');
        expect(row.valueAtRiskMinor).toBeNull();
        expect(row).toMatchObject({ onHandUnits: 10, printedMrpMinor: 5_000 });
      }
      // The order must not rank positions by their hidden cost either.
      expect(board.rows.map((row) => row.inventoryLotId)).toEqual(['lot_cheap', 'lot_dear']);
      // The seeded mark-down draft still reaches the board, without its stored unit cost.
      const drafted = board.rows.find((row) => row.inventoryLotId === 'lot_dear');
      expect(drafted?.markdown).toMatchObject({
        eventId: 'event_dear',
        markdownPercent: 20,
        printedMrpMinor: 5_000,
        proposedPackPriceMinor: 4_000,
      });
      expect(drafted?.markdown).not.toHaveProperty('unitCostMinor');
      expect(JSON.stringify(board)).not.toMatch(/unitCost|9000|90000/);
    });

    it('withholds cost from a tenant ADMIN whose role explicitly denies reports:financial', async () => {
      grant([allow('pharmacy:inventory'), deny('reports:financial')]);
      seedBoard();

      const board = await caller().expiryBoardLots({ branchId: 'branch_a', withinDays: 30 });

      expect(board.costVisible).toBe(false);
      expect(board.riskBuckets).toEqual([]);
      expect(board.rows.every((row) => row.valueAtRiskMinor === null)).toBe(true);
    });

    it('releases value at risk, but never the unit cost, to a reports:financial holder', async () => {
      grant([allow('pharmacy:inventory'), allow('reports:financial')]);
      seedBoard();

      const board = await caller().expiryBoardLots({ branchId: 'branch_a', withinDays: 30 });

      expect(board.costVisible).toBe(true);
      expect(board.riskBuckets[0]).toEqual({ days: 30, valueAtRiskMinor: 100_000 });
      expect(board.rows.map((row) => [row.inventoryLotId, row.valueAtRiskMinor])).toEqual([
        ['lot_dear', 90_000],
        ['lot_cheap', 10_000],
      ]);
      for (const row of board.rows) expect(row).not.toHaveProperty('unitCostMinor');
      expect(board.rows[0]?.markdown).toMatchObject({ eventId: 'event_dear' });
      expect(board.rows[0]?.markdown).not.toHaveProperty('unitCostMinor');
    });

    function seedMarkdownLot() {
      sessionRole = 'EMPLOYEE';
      grant([allow('pharmacy:inventory'), allow('pharmacy:counter')]);
      db.pharmacyInventoryLot.findFirst.mockResolvedValue({
        printedMrpMinor: 5_000,
        unitsPerPack: 10,
        unitCostMinor: 9_000,
        batch: {
          batchNumber: 'B-1',
          expiresAt: new Date(Date.now() + 20 * 86_400_000),
          state: 'ACTIVE',
          medicineId: 'medicine_1',
          medicine: {
            rx: false,
            otc: true,
            restricted: false,
            controlled: false,
            productFamily: 'PHARMACEUTICAL',
          },
        },
      });
      db.pharmacyStockBalance.findFirst.mockResolvedValue({ onHandUnits: 10 });
      db.pharmacyStockSignal.findFirst.mockResolvedValue({ id: 'signal_1' });
    }
    const markdownInput = {
      branchId: 'branch_a',
      inventoryLotId: 'lot_dear',
      stockLocationId: 'location_1',
      markdownPercent: 20,
      reason: 'Near expiry',
    };

    it('records the unit cost as evidence but returns a new mark-down draft without it', async () => {
      seedMarkdownLot();

      const result = await caller().draftExpiryMarkdown(markdownInput);

      expect(result.created).toBe(true);
      expect(result.draft).toMatchObject({ markdownPercent: 20, proposedPackPriceMinor: 4_000 });
      expect(result.draft).not.toHaveProperty('unitCostMinor');
      expect(JSON.stringify(result)).not.toMatch(/unitCost|9000/);
      const stored = db.pharmacyStockSignalEvent.create.mock.calls[0]![0] as {
        data: { detail: string };
      };
      expect(stored.data.detail).toContain('"unitCostMinor":9000');
    });

    it('returns a replayed mark-down draft without its stored unit cost', async () => {
      seedMarkdownLot();
      db.pharmacyStockSignalEvent.findMany.mockResolvedValueOnce([
        {
          id: 'event_dear',
          detail: `DRAFT mark-down ${JSON.stringify(storedDraft('lot_dear', 9_000))}`,
        },
      ]);

      const result = await caller().draftExpiryMarkdown(markdownInput);

      expect(result).toMatchObject({ created: false, eventId: 'event_dear' });
      expect(result.draft).not.toHaveProperty('unitCostMinor');
      expect(db.pharmacyStockSignalEvent.create).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['Rx', { rx: true, restricted: false, controlled: false }],
    ['restricted', { rx: false, restricted: true, controlled: false }],
    ['controlled', { rx: false, restricted: false, controlled: true }],
  ])(
    'rejects a mark-down mutation for %s medicine before recording an event',
    async (_kind, flags) => {
      grant([allow('pharmacy:inventory')]);
      db.pharmacyInventoryLot.findFirst.mockResolvedValue({
        printedMrpMinor: 5_000,
        batch: {
          expiresAt: new Date(Date.now() + 30 * 86_400_000),
          state: 'ACTIVE',
          medicineId: 'medicine_1',
          medicine: { ...flags, otc: true, productFamily: 'PHARMACEUTICAL' },
        },
      });

      await expect(
        caller().draftExpiryMarkdown({
          branchId: 'branch_a',
          inventoryLotId: 'lot_1',
          stockLocationId: 'location_1',
          markdownPercent: 20,
          reason: 'Near expiry',
        })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Mark-down suggestions are limited to OTC and non-drug stock.',
      });
      expect(db.pharmacyStockSignalEvent.create).not.toHaveBeenCalled();
    }
  );
});

describe('pharmacy inventory entitlement and tenant boundaries', () => {
  it('maps the public router prefix to the pharmacy-inventory entitlement', () => {
    expect(moduleForProcedure('pharmacyInventory.allocateForSale')).toBe('pharmacy-inventory');
    // Not the mandatory Core module the medicine identity lane maps to.
    expect(moduleForProcedure('pharmacyMedicine.createIngredient')).toBe('pharmacy-core');
  });

  it('rejects a cross-tenant medicine ID substitution when registering a batch', async () => {
    await expect(
      caller().registerBatch({
        medicineId: 'medicine_from_org_b',
        batchNumber: 'B-1',
        printedExpiry: new Date('2027-06-15T00:00:00.000Z'),
        expiryPrecision: 'DAY',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyManufacturingBatch.create).not.toHaveBeenCalled();
  });

  it('rejects a cross-tenant pack level ID substitution when receiving a lot', async () => {
    grant([allow('pharmacy:inventory')]);
    await expect(
      caller().receiveLot({
        branchId: 'branch_a',
        manufacturingBatchId: 'batch_1',
        packLevelId: 'pack_level_from_org_b',
        stockLocationId: 'location_1',
        unitsPerPack: 10,
        supplierName: 'Distributor Ltd',
        supplierInvoiceRef: 'INV-1',
        unitCostMinor: 1200,
        printedMrpMinor: 2000,
        printedExpiry: new Date('2027-06-15T00:00:00.000Z'),
        expiryPrecision: 'DAY',
        quantityUnits: 100,
        idempotencyKey: 'receipt-1',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyInventoryLot.create).not.toHaveBeenCalled();
  });

  it('takes the organization from the session, never from the payload', async () => {
    grant([allow('pharmacy:inventory')]);
    db.medicine.findFirst.mockResolvedValue({ id: 'medicine_1' });
    await caller().registerBatch({
      medicineId: 'medicine_1',
      batchNumber: 'B-1',
      printedExpiry: new Date('2027-06-15T00:00:00.000Z'),
      expiryPrecision: 'DAY',
    });
    expect(db.pharmacyManufacturingBatch.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ organizationId: 'org_a' }) })
    );
  });

  it('normalises a MONTH-precision expiry to Karachi midnight after the month', async () => {
    grant([allow('pharmacy:inventory')]);
    db.medicine.findFirst.mockResolvedValue({ id: 'medicine_1' });
    await caller().registerBatch({
      medicineId: 'medicine_1',
      batchNumber: 'B-1',
      // Printed "06/2027": good through the whole of June.
      printedExpiry: new Date('2027-06-15T00:00:00.000Z'),
      expiryPrecision: 'MONTH',
    });
    expect(db.pharmacyManufacturingBatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ expiresAt: new Date('2027-06-30T19:00:00.000Z') }),
      })
    );
  });

  it('refuses to block a batch without a reason (INV-03 evidence)', async () => {
    db.user.findUnique.mockResolvedValue({
      organizationRole: {
        permissions: [{ capability: 'pharmacy:safety', effect: 'ALLOW' }],
      },
      permissionOverrides: [],
    });
    db.pharmacyManufacturingBatch.findFirst.mockResolvedValue({ id: 'batch_1' });
    await expect(
      caller().setBatchState({ manufacturingBatchId: 'batch_1', state: 'RECALLED' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacyManufacturingBatch.update).not.toHaveBeenCalled();
  });

  it('rejects a write-off witness who is not an active member assigned to the branch', async () => {
    grant([allow('pharmacy:inventory')]);

    await expect(
      caller().writeOff({
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_1',
        units: 1,
        witnessId: 'untrusted_string',
        witnessPin: '2468',
        reason: 'Damaged package',
        evidenceRef: 'PHOTO-1',
        idempotencyKey: 'write-off-1',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'COAUTH_REQUIRED' });

    expect(db.user.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'untrusted_string',
        organizationId: 'org_a',
        status: 'ACTIVE',
        pharmacyBranchAssignments: {
          some: { organizationId: 'org_a', branchId: 'branch_a', active: true },
        },
      },
      select: { id: true },
    });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacyCustodyRecord.create).not.toHaveBeenCalled();
  });

  it('accepts an active same-tenant witness assigned to the write-off branch', async () => {
    grant([allow('pharmacy:inventory')]);
    witnessPinOnFile();
    db.user.findFirst.mockResolvedValue({ id: 'witness_a' });
    db.pharmacyInventoryLot.findFirst.mockResolvedValue({ id: 'lot_1', unitsPerPack: 1 });
    db.pharmacyStockBalance.findFirst.mockResolvedValue({
      onHandUnits: 5,
      sealedPacks: 5,
      looseUnits: 0,
    });

    await caller().writeOff({
      branchId: 'branch_a',
      inventoryLotId: 'lot_1',
      stockLocationId: 'location_1',
      units: 1,
      witnessId: 'witness_a',
      witnessPin: '2468',
      reason: 'Damaged package',
      evidenceRef: 'PHOTO-1',
      idempotencyKey: 'write-off-1',
    });

    expect(db.pharmacyCustodyRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org_a',
        branchId: 'branch_a',
        actorId: 'user_a',
        witnessId: 'witness_a',
      }),
    });
  });

  describe('DEV-628 the write-off witness confirms with their own PIN', () => {
    const writeOffInput = {
      branchId: 'branch_a',
      inventoryLotId: 'lot_1',
      stockLocationId: 'location_1',
      units: 1,
      witnessId: 'witness_a',
      witnessPin: '2468',
      reason: 'Damaged package',
      evidenceRef: 'PHOTO-1',
      idempotencyKey: 'write-off-1',
    };
    function stockOnHand() {
      db.pharmacyInventoryLot.findFirst.mockResolvedValue({ id: 'lot_1', unitsPerPack: 1 });
      db.pharmacyStockBalance.findFirst.mockResolvedValue({
        onHandUnits: 5,
        sealedPacks: 5,
        looseUnits: 0,
      });
    }

    it('refuses a write-off that names a witness without their PIN', async () => {
      grant([allow('pharmacy:inventory')]);
      db.user.findFirst.mockResolvedValue({ id: 'witness_a' });
      const withoutPin: Partial<typeof writeOffInput> = { ...writeOffInput };
      delete withoutPin.witnessPin;

      await expect(caller().writeOff(withoutPin as never)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
      expect(db.pharmacyCustodyRecord.create).not.toHaveBeenCalled();
    });

    it('refuses a wrong witness PIN, keeps the strike and posts no stock', async () => {
      grant([allow('pharmacy:inventory')]);
      db.user.findFirst.mockResolvedValue({ id: 'witness_a' });
      witnessPinOnFile('2468');
      stockOnHand();

      await expect(
        caller().writeOff({ ...writeOffInput, witnessPin: '1357' })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'COAUTH_REQUIRED' });
      expect(db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
        where: { id: 'credential_witness' },
        data: { failedAttempts: 1, lockedUntil: null },
      });
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
      expect(db.pharmacyCustodyRecord.create).not.toHaveBeenCalled();
    });

    it('refuses naming yourself while a colleague is assigned to the branch', async () => {
      grant([allow('pharmacy:inventory')]);
      Object.assign(db.user, { count: vi.fn().mockResolvedValue(1) });
      witnessPinOnFile();
      stockOnHand();

      await expect(
        caller().writeOff({ ...writeOffInput, witnessId: 'user_a' })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'COAUTH_REQUIRED' });
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    });

    it('records that the witness entered their PIN, in the write-off transaction', async () => {
      grant([allow('pharmacy:inventory')]);
      db.user.findFirst.mockResolvedValue({ id: 'witness_a' });
      witnessPinOnFile();
      stockOnHand();
      db.pharmacyStockMovement.create.mockResolvedValue({
        id: 'movement_1',
        occurredAt: new Date(),
      });

      await caller().writeOff(writeOffInput);

      expect(db.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'pharmacy.writeOffWitnessConfirmed',
          targetType: 'PharmacyStockMovement',
          targetId: 'movement_1',
          metadata: expect.objectContaining({ witnessId: 'witness_a', pinVerified: true }),
        }),
      });
    });

    function shortTransfer() {
      db.$queryRaw
        .mockResolvedValueOnce([{ id: 'transfer_1' }] as never)
        // DEV-825: the witness credential is locked before any stock row, then the
        // IN_TRANSIT balances are locked before they are read.
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { onHandUnits: 20, sealedPacks: 2, looseUnits: 0, unitsPerPack: 10 },
        ] as never);
      db.pharmacyInterbranchTransfer.findFirst.mockResolvedValue({
        id: 'transfer_1',
        status: 'DISPATCHED',
        fromBranchId: 'branch_src',
        toBranchId: 'branch_a',
        lines: [
          {
            id: 'line_1',
            sourceLotId: 'lot_src',
            sourceStockLocationId: 'location_src',
            destinationStockLocationId: 'location_1',
            quantityUnits: 20,
            receivedUnits: 0,
          },
        ],
      });
    }
    const shortReceipt = (variance: { witnessId: string; witnessPin: string }) => ({
      branchId: 'branch_a',
      transferId: 'transfer_1',
      lines: [{ lineId: 'line_1', receivedUnits: 0 }],
      variance: { reason: 'Lost in transit', evidenceRef: 'COURIER-1', ...variance },
      idempotencyKeyPrefix: 'receive-1',
    });

    it('refuses a transfer shortfall witness who is not assigned to the receiving branch', async () => {
      grant([allow('pharmacy:inventory')]);
      shortTransfer();
      witnessPinOnFile();

      await expect(
        caller().receiveTransferWithVariance(
          shortReceipt({ witnessId: 'unassigned_member', witnessPin: '2468' })
        )
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'COAUTH_REQUIRED' });
      expect(db.user.findFirst).toHaveBeenCalledWith({
        where: {
          organizationId: 'org_a',
          status: 'ACTIVE',
          pharmacyBranchAssignments: {
            some: { organizationId: 'org_a', branchId: 'branch_a', active: true },
          },
          id: 'unassigned_member',
        },
        select: { id: true },
      });
      expect(mocks.withTenantDb).not.toHaveBeenCalled();
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    });

    it('refuses a transfer shortfall when the witness PIN is wrong', async () => {
      grant([allow('pharmacy:inventory')]);
      shortTransfer();
      db.user.findFirst.mockResolvedValue({ id: 'user_b' });
      witnessPinOnFile('2468');

      await expect(
        caller().receiveTransferWithVariance(
          shortReceipt({ witnessId: 'user_b', witnessPin: '0000' })
        )
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'COAUTH_REQUIRED' });
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
      expect(db.pharmacyCustodyRecord.create).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['setBatchState', { manufacturingBatchId: 'batch_1', state: 'ACTIVE' }],
    ['acknowledgeRecall', { branchId: 'branch_a', recallNoticeId: 'recall_1' }],
    ['closeRecall', { recallNoticeId: 'recall_1' }],
  ] as const)('requires pharmacy:safety for %s', async (procedure, input) => {
    await expect(caller()[procedure](input as never)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses quarantine for an inventory-only caller before any stock access', async () => {
    grant([allow('pharmacy:inventory')]);

    await expect(
      caller().quarantinePart({
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_1',
        units: 10,
        reason: 'Suspected contamination',
        idempotencyKeyPrefix: 'quarantine-1',
      })
    ).rejects.toMatchObject(CAPABILITY_REFUSAL);

    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
    expect(db.pharmacyInventoryLot.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyStockBalance.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('runs quarantine through the real router with exact pharmacy:safety authority', async () => {
    // The explicit inventory DENY makes this a regression test for the procedure
    // declaration itself: changing quarantinePart back to inventoryControl must
    // stop the call before its transaction and movement writes.
    grant([allow('pharmacy:safety'), deny('pharmacy:inventory')]);
    db.pharmacyInventoryLot.findFirst.mockResolvedValue({
      id: 'lot_1',
      unitsPerPack: 10,
    });
    db.pharmacyStockBalance.findFirst.mockResolvedValue({
      onHandUnits: 20,
      sealedPacks: 2,
      looseUnits: 0,
    });

    await caller().quarantinePart({
      branchId: 'branch_a',
      inventoryLotId: 'lot_1',
      stockLocationId: 'location_1',
      units: 10,
      reason: 'Suspected contamination',
      idempotencyKeyPrefix: 'quarantine-1',
    });

    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(db.pharmacyStockMovement.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 'org_a',
          branchId: 'branch_a',
          disposition: 'AVAILABLE',
          quantityUnits: -10,
          idempotencyKey: 'quarantine-1:out',
        }),
      })
    );
    expect(db.pharmacyStockMovement.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 'org_a',
          branchId: 'branch_a',
          disposition: 'QUARANTINE',
          quantityUnits: 10,
          idempotencyKey: 'quarantine-1:in',
        }),
      })
    );
  });

  it.each(['RECALLED', 'QUARANTINED'] as const)(
    'does not let an ordinary member reactivate a %s batch',
    async (state) => {
      db.pharmacyManufacturingBatch.findFirst.mockResolvedValue({
        id: 'batch_1',
        medicineId: 'medicine_1',
        state,
      });

      await expect(
        caller().setBatchState({ manufacturingBatchId: 'batch_1', state: 'ACTIVE' })
      ).rejects.toMatchObject(CAPABILITY_REFUSAL);

      expect(db.pharmacyManufacturingBatch.findFirst).not.toHaveBeenCalled();
      expect(db.pharmacyManufacturingBatch.update).not.toHaveBeenCalled();
    }
  );

  it('does not let a safety user reactivate a batch covered by an open recall', async () => {
    grant([allow('pharmacy:safety')]);
    db.pharmacyManufacturingBatch.findFirst.mockResolvedValue({
      id: 'batch_1',
      medicineId: 'medicine_1',
      state: 'RECALLED',
    });
    db.pharmacyRecallNotice.count.mockResolvedValue(1);

    await expect(
      caller().setBatchState({ manufacturingBatchId: 'batch_1', state: 'ACTIVE' })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Close the open recall before reactivating this batch.',
    });

    expect(db.pharmacyRecallNotice.count).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_a',
        status: 'OPEN',
        OR: [{ batchId: 'batch_1' }, { medicineId: 'medicine_1' }],
      },
    });
    expect(db.pharmacyManufacturingBatch.update).not.toHaveBeenCalled();
  });

  it('allows a safety user to reactivate a batch when no recall remains open', async () => {
    grant([allow('pharmacy:safety')]);
    db.pharmacyManufacturingBatch.findFirst.mockResolvedValue({
      id: 'batch_1',
      medicineId: 'medicine_1',
      state: 'QUARANTINED',
    });
    db.pharmacyRecallNotice.count.mockResolvedValue(0);

    await caller().setBatchState({ manufacturingBatchId: 'batch_1', state: 'ACTIVE' });

    expect(db.pharmacyManufacturingBatch.update).toHaveBeenCalledWith({
      where: { id: 'batch_1' },
      data: { state: 'ACTIVE', stateReason: null, stateChangedAt: null },
    });
  });

  it('allows an exact pharmacy:safety grant to acknowledge a recall', async () => {
    db.user.findUnique.mockResolvedValue({
      organizationRole: {
        permissions: [{ capability: 'pharmacy:safety', effect: 'ALLOW' }],
      },
      permissionOverrides: [],
    });
    db.$queryRaw.mockResolvedValueOnce([{ id: 'recall_1' }] as never);
    db.pharmacyRecallNotice.findFirst.mockResolvedValue({
      id: 'recall_1',
      batchId: 'batch_1',
      medicineId: null,
    });
    db.pharmacyInventoryLot.findFirst.mockResolvedValue({ id: 'lot_1' });

    await caller().acknowledgeRecall({ branchId: 'branch_a', recallNoticeId: 'recall_1' });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.pharmacyRecallAcknowledgement.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org_a',
        recallNoticeId: 'recall_1',
        branchId: 'branch_a',
        actorId: 'user_a',
      },
    });
  });

  it('refuses a transfer whose source and destination are the same location', async () => {
    grant([allow('pharmacy:inventory')]);
    await expect(
      caller().transfer({
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        fromStockLocationId: 'location_1',
        toStockLocationId: 'location_1',
        units: 10,
        idempotencyKeyPrefix: 'transfer-1',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('refuses a branch that is not an active branch in the session organization', async () => {
    grant([allow('pharmacy:inventory')]);
    db.pharmacyBranch.findMany.mockResolvedValueOnce([]);
    await expect(
      caller().createLocation({
        branchId: 'branch_other',
        code: 'MAIN',
        name: 'Main store',
        kind: 'STORE',
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That record is not in this workspace.',
    });
    expect(db.pharmacyStockLocation.create).not.toHaveBeenCalled();
  });

  it('refuses every mutation when there is no tenant actor to attribute it to', async () => {
    await expect(
      caller({ userId: null }).createLocation({
        branchId: 'branch_a',
        code: 'MAIN',
        name: 'Main store',
        kind: 'STORE',
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(db.pharmacyStockLocation.create).not.toHaveBeenCalled();
  });
});

// ── DEV-211 — an active assignment to the branch, not only tenant membership ──

const OUTSIDE_SCOPE = { code: 'FORBIDDEN', message: 'Branch is outside your scope.' };

/** The one assignment the session actor must hold for the requested branch. */
const ASSIGNMENT_QUERY = {
  where: {
    organizationId: 'org_a',
    branchId: 'branch_a',
    userId: 'user_a',
    active: true,
    branch: { organizationId: 'org_a', active: true },
  },
  select: { id: true },
};

/** Every delegate call except the authorization lookups themselves. */
function dataAccess(): string[] {
  // Authorization lookups and the exception's own audit row are not stock access.
  const authorization = new Set(['user', 'pharmacyBranch', 'pharmacyBranchAssignment', 'auditLog']);
  const touched: string[] = [];
  for (const [name, delegate] of Object.entries(db)) {
    if (authorization.has(name) || name === '$transaction') continue;
    if (vi.isMockFunction(delegate)) {
      if (delegate.mock.calls.length > 0) touched.push(name);
      continue;
    }
    for (const [method, fn] of Object.entries(delegate as Record<string, unknown>)) {
      if (vi.isMockFunction(fn) && fn.mock.calls.length > 0) touched.push(`${name}.${method}`);
    }
  }
  return touched;
}

const ASSIGNMENT_GATED: ReadonlyArray<{
  name: string;
  capability: string;
  invoke: () => Promise<unknown>;
}> = [
  {
    name: 'createLocation',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().createLocation({
        branchId: 'branch_a',
        code: 'MAIN',
        name: 'Main store',
        kind: 'STORE',
      }),
  },
  {
    name: 'receiveLot',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().receiveLot({
        branchId: 'branch_a',
        manufacturingBatchId: 'batch_1',
        packLevelId: 'pack_1',
        stockLocationId: 'location_1',
        unitsPerPack: 10,
        supplierName: 'Distributor Ltd',
        supplierInvoiceRef: 'INV-1',
        unitCostMinor: 1200,
        printedMrpMinor: 2000,
        printedExpiry: new Date('2027-06-15T00:00:00.000Z'),
        expiryPrecision: 'DAY',
        quantityUnits: 100,
        idempotencyKey: 'receipt-1',
      }),
  },
  {
    name: 'createCount',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().createCount({
        branchId: 'branch_a',
        varianceThreshold: 0,
        readings: [
          {
            inventoryLotId: 'lot_1',
            stockLocationId: 'location_1',
            countedSealedPacks: 1,
            countedLooseUnits: 0,
          },
        ],
      }),
  },
  {
    name: 'writeOff',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().writeOff({
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_1',
        units: 1,
        witnessId: 'witness_1',
        witnessPin: '2468',
        reason: 'Damaged',
        evidenceRef: 'photo-1',
        idempotencyKey: 'write-off-1',
      }),
  },
  // DEV-682 — the daily cycle-count list names branch stock positions.
  {
    name: 'dailyCycleCountList',
    capability: 'pharmacy:inventory',
    invoke: () => caller().dailyCycleCountList({ branchId: 'branch_a' }),
  },
  // DEV-660 — the branch stock reads.
  {
    name: 'nearExpiryBoard',
    capability: 'pharmacy:inventory',
    invoke: () => caller().nearExpiryBoard({ branchId: 'branch_a' }),
  },
  {
    name: 'onHand',
    capability: 'pharmacy:inventory',
    invoke: () => caller().onHand({ branchId: 'branch_a', medicineId: 'medicine_1' }),
  },
  {
    name: 'temperatureZoneStatuses',
    capability: 'pharmacy:inventory',
    invoke: () => caller().temperatureZoneStatuses({ branchId: 'branch_a' }),
  },
  {
    name: 'expiryBoardLots',
    capability: 'pharmacy:inventory',
    invoke: () => caller().expiryBoardLots({ branchId: 'branch_a', withinDays: 90 }),
  },
  {
    name: 'stockSignalDashboard',
    capability: 'pharmacy:inventory',
    invoke: () => caller().stockSignalDashboard({ branchId: 'branch_a' }),
  },
  {
    name: 'stockSignalDigest',
    capability: 'pharmacy:inventory',
    invoke: () => caller().stockSignalDigest({ branchId: 'branch_a', ownerUserId: 'user_a' }),
  },
  {
    name: 'transferBoard',
    capability: 'pharmacy:inventory',
    invoke: () => caller().transferBoard({ branchId: 'branch_a' }),
  },
  // DEV-660 — allocating stock for a sale.
  {
    name: 'allocateForSale',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().allocateForSale({
        branchId: 'branch_a',
        medicineId: 'medicine_1',
        requiredUnits: 1,
        idempotencyKeyPrefix: 'sale-1',
      }),
  },
  // DEV-660 — every transfer step, at the branch the step acts for.
  {
    name: 'transfer',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().transfer({
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        fromStockLocationId: 'location_1',
        toStockLocationId: 'location_2',
        units: 1,
        idempotencyKeyPrefix: 'move-1',
      }),
  },
  {
    name: 'allocateTransfer',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().allocateTransfer({
        branchId: 'branch_a',
        toBranchId: 'branch_b',
        lines: [
          {
            sourceLotId: 'lot_1',
            sourceStockLocationId: 'location_1',
            destinationStockLocationId: 'location_b',
            quantityUnits: 1,
          },
        ],
      }),
  },
  {
    name: 'approveTransfer',
    capability: 'pharmacy:inventory',
    invoke: () => caller().approveTransfer({ branchId: 'branch_a', transferId: 'transfer_1' }),
  },
  {
    name: 'dispatchTransfer',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().dispatchTransfer({
        branchId: 'branch_a',
        transferId: 'transfer_1',
        idempotencyKeyPrefix: 'dispatch-1',
      }),
  },
  {
    name: 'receiveTransferLine',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().receiveTransferLine({
        branchId: 'branch_a',
        transferId: 'transfer_1',
        lineId: 'line_1',
        receivedUnits: 1,
        idempotencyKeyPrefix: 'receive-1',
      }),
  },
  {
    name: 'receiveTransferWithVariance',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().receiveTransferWithVariance({
        branchId: 'branch_a',
        transferId: 'transfer_1',
        lines: [{ lineId: 'line_1', receivedUnits: 1 }],
        idempotencyKeyPrefix: 'receive-1',
      }),
  },
  {
    name: 'coldChainSensors',
    capability: 'pharmacy:inventory',
    invoke: () => caller().coldChainSensors({ branchId: 'branch_a' }),
  },
  {
    name: 'enrollColdChainSensor',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().enrollColdChainSensor({
        branchId: 'branch_a',
        stockLocationId: 'fridge_1',
        name: 'Vaccine fridge probe',
        deviceIdentifier: 'SN-001',
      }),
  },
  {
    name: 'rotateColdChainSensorSecret',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().rotateColdChainSensorSecret({ branchId: 'branch_a', sensorId: 'sensor_1' }),
  },
  {
    name: 'revokeColdChainSensor',
    capability: 'pharmacy:inventory',
    invoke: () => caller().revokeColdChainSensor({ branchId: 'branch_a', sensorId: 'sensor_1' }),
  },
  {
    name: 'draftExpiryReturnClaim',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().draftExpiryReturnClaim({
        branchId: 'branch_a',
        supplierId: 'supplier_1',
        positions: [{ inventoryLotId: 'lot_1', stockLocationId: 'location_1' }],
        reason: 'Near-expiry return claim',
      }),
  },
  // DEV-505 — every other branch-scoped `pharmacy:inventory` procedure, so a
  // Manager granted inventory is refused every branch they are not assigned to.
  {
    name: 'recordTemperature',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().recordTemperature({
        branchId: 'branch_a',
        stockLocationId: 'location_1',
        temperatureC: 5,
        recordedAt: new Date('2026-10-22T08:00:00.000Z'),
      }),
  },
  {
    name: 'importTemperatureCsv',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().importTemperatureCsv({
        branchId: 'branch_a',
        stockLocationId: 'location_1',
        csv: 'recordedAt,temperatureC\n2026-10-22T08:00:00.000Z,5\n',
      }),
  },
  {
    name: 'configureTemperatureMonitoring',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().configureTemperatureMonitoring({
        branchId: 'branch_a',
        stockLocationId: 'location_1',
        expectedTemperatureReadingIntervalMinutes: 30,
        temperatureExcursionDurationMinutes: 60,
      }),
  },
  {
    name: 'breakPack',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().breakPack({
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_1',
        requiredLooseUnits: 1,
        idempotencyKey: 'break-1',
      }),
  },
  {
    name: 'approveCount',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().approveCount({
        branchId: 'branch_a',
        countId: 'count_1',
        idempotencyKeyPrefix: 'count-1',
      }),
  },
  {
    name: 'releaseQuarantinedPart',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().releaseQuarantinedPart({
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_1',
        units: 1,
        reason: 'Inspection passed',
        idempotencyKeyPrefix: 'release-1',
      }),
  },
  {
    name: 'reserveSupplierClaim',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().reserveSupplierClaim({
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        reservedUnits: 1,
        returnBy: new Date('2026-12-01T00:00:00.000Z'),
      }),
  },
  {
    name: 'approveSafetyStock',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().approveSafetyStock({
        branchId: 'branch_a',
        medicineId: 'medicine_1',
        safetyStockUnits: 10,
        coverageDays: 30,
      }),
  },
  {
    name: 'refreshStockSignals',
    capability: 'pharmacy:inventory',
    invoke: () => caller().refreshStockSignals({ branchId: 'branch_a' }),
  },
  {
    name: 'markStaleSignals',
    capability: 'pharmacy:inventory',
    invoke: () => caller().markStaleSignals({ branchId: 'branch_a' }),
  },
  {
    name: 'acknowledgeSignal',
    capability: 'pharmacy:inventory',
    invoke: () => caller().acknowledgeSignal({ branchId: 'branch_a', signalId: 'signal_1' }),
  },
  {
    name: 'snoozeSignal',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().snoozeSignal({
        branchId: 'branch_a',
        signalId: 'signal_1',
        until: new Date('2026-12-01T00:00:00.000Z'),
        reason: 'Supplier delivery booked',
      }),
  },
  {
    name: 'dismissSignal',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().dismissSignal({
        branchId: 'branch_a',
        signalId: 'signal_1',
        reason: 'Discontinued line',
      }),
  },
  {
    name: 'createDraftAction',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().createDraftAction({
        kind: 'DRAFT_REQUISITION',
        branchId: 'branch_a',
        signalId: 'signal_1',
        reference: 'REQ-1',
        medicineId: 'medicine_1',
        packLevelId: 'pack_1',
        canonicalUnitsPerPack: 10,
        quantityPacks: 1,
      }),
  },
  {
    name: 'draftExpiryMarkdown',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().draftExpiryMarkdown({
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_1',
        markdownPercent: 20,
        reason: 'Near expiry',
      }),
  },
  {
    name: 'draftExpiryReturn',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().draftExpiryReturn({
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_1',
        supplierId: 'supplier_1',
        units: 1,
        reason: 'Near-expiry return',
      }),
  },
  {
    name: 'quarantineExpiring',
    capability: 'pharmacy:inventory',
    invoke: () =>
      caller().quarantineExpiring({
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_1',
        units: 1,
        reason: 'Expires this week',
        requestKey: 'quarantine-1',
      }),
  },
];

/** The user-record lookup that confirms a session ADMIN is a live ADMIN of this tenant. */
const ADMIN_RECORD_QUERY = {
  where: { id: 'user_a', organizationId: 'org_a', role: 'ADMIN', status: 'ACTIVE' },
  select: { id: true },
};

/** The dedicated, awaited audit row each use of the ADMIN exception writes. */
const ADMIN_EXCEPTION_AUDIT = expect.objectContaining({
  id: expect.any(String),
  createdAt: expect.any(Date),
  operation: 'OTHER',
  outcome: 'SUCCESS',
  organizationId: 'org_a',
  actorType: 'USER',
  actorId: 'user_a',
  source: 'TRPC',
  action: 'pharmacy.inventory.admin_branch_exception',
  targetType: 'PharmacyBranch',
  targetId: 'branch_a',
  metadata: {
    branchId: 'branch_a',
    reason: 'tenant-admin-inventory-access-without-branch-assignment',
  },
});

/**
 * The user record the database holds for user_a. `confirmAdmin()` makes it an
 * ACTIVE ADMIN of `tenant`; any lookup asking for something else finds nothing.
 */
function confirmAdmin(tenant = 'org_a') {
  db.user.findFirst.mockImplementation(
    async ({
      where,
    }: {
      where: { id?: string; organizationId?: string; role?: string; status?: string };
    }) =>
      where.id === 'user_a' &&
      where.organizationId === tenant &&
      where.role === 'ADMIN' &&
      where.status === 'ACTIVE'
        ? { id: 'user_a' }
        : null
  );
}

const asksForAdminRecord = () =>
  db.user.findFirst.mock.calls.some(
    (call) => (call[0] as { where?: { role?: string } } | undefined)?.where?.role === 'ADMIN'
  );

/** The branch stock reads carry no capability of their own on develop. */
/**
 * The exception schedules one after-transaction work item that re-writes the
 * same row (same id) with skipDuplicates on its own connection.
 */
async function expectIdempotentReinsert() {
  expect(mocks.afterTenantTransaction).toHaveBeenCalledTimes(1);
  const reinsert = { auditLog: { createMany: vi.fn().mockResolvedValue({ count: 0 }) } };
  mocks.withTenantDb.mockImplementation(async (_org: string, run: (tx: unknown) => unknown) =>
    run(reinsert)
  );
  mocks.afterTenantTransaction.mock.calls[0]![0]();
  await mocks.withTenantDb.mock.results[0]!.value;
  expect(mocks.withTenantDb).toHaveBeenCalledWith('org_a', expect.any(Function), {
    maxWait: 1_000,
    timeout: 5_000,
    skipDrain: true,
  });
  const written = (db.auditLog.create.mock.calls[0]![0] as { data: unknown }).data;
  expect(reinsert.auditLog.createMany).toHaveBeenCalledWith({
    data: [written],
    skipDuplicates: true,
  });
}

/**
 * A reads procedure refuses at the branch rule today; PR #994 puts transferBoard
 * behind pharmacy:inventory, after which it refuses at the capability check.
 * Either is a refusal, so the read-side assertions accept both.
 */
const READ_REFUSAL = {
  code: 'FORBIDDEN',
  message: expect.stringMatching(
    /^(Branch is outside your scope\.|You do not have permission for this action\.)$/
  ),
};

const READS = new Set([
  'nearExpiryBoard',
  'onHand',
  'temperatureZoneStatuses',
  'expiryBoardLots',
  'stockSignalDashboard',
  'stockSignalDigest',
  'transferBoard',
]);

describe('DEV-211 / DEV-660 — branch assignment, or a verified tenant ADMIN', () => {
  it.each(ASSIGNMENT_GATED)(
    'refuses $name for an unassigned non-admin before any stock access',
    async ({ capability, invoke }) => {
      // The capability is held, so the refusal can only be the branch rule.
      sessionRole = 'EMPLOYEE';
      grant([allow(capability)]);
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);

      await expect(invoke()).rejects.toMatchObject(OUTSIDE_SCOPE);
      expect(db.pharmacyBranchAssignment.findFirst).toHaveBeenCalledWith(ASSIGNMENT_QUERY);
      expect(asksForAdminRecord()).toBe(false);
      expect(db.auditLog.create).not.toHaveBeenCalled();
      expect(dataAccess()).toEqual([]);
    }
  );

  it.each(ASSIGNMENT_GATED)(
    'admits a verified active tenant ADMIN to $name without an assignment, and audits it',
    async ({ capability, invoke }) => {
      grant([allow(capability)]);
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
      confirmAdmin();

      const outcome = await invoke().then(
        () => null,
        (error: { message?: string }) => error
      );

      // Past the branch rule; whatever the mocked ledger answers next is not a refusal of scope.
      expect(outcome?.message).not.toBe(OUTSIDE_SCOPE.message);
      expect(db.user.findFirst).toHaveBeenCalledWith(ADMIN_RECORD_QUERY);
      // Written on the request's own client, awaited, exactly once per use ...
      expect(db.auditLog.create).toHaveBeenCalledExactlyOnceWith({ data: ADMIN_EXCEPTION_AUDIT });
      // ... and the same row is re-written idempotently after the transaction ends.
      await expectIdempotentReinsert();
    }
  );

  it.each(ASSIGNMENT_GATED)(
    'refuses $name for an ADMIN session the user record does not confirm',
    async ({ capability, invoke }) => {
      // Demoted, deactivated or deleted since the session was issued: the record
      // lookup (ADMIN + ACTIVE + this tenant) finds nothing, so no exception applies.
      grant([allow(capability)]);
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);

      await expect(invoke()).rejects.toMatchObject(OUTSIDE_SCOPE);
      expect(db.user.findFirst).toHaveBeenCalledWith(ADMIN_RECORD_QUERY);
      expect(db.auditLog.create).not.toHaveBeenCalled();
      expect(dataAccess()).toEqual([]);
    }
  );

  it.each(ASSIGNMENT_GATED)(
    'refuses $name for an ADMIN of another tenant',
    async ({ capability, invoke }) => {
      grant([allow(capability)]);
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
      confirmAdmin('org_b');

      await expect(invoke()).rejects.toMatchObject(OUTSIDE_SCOPE);
      expect(db.auditLog.create).not.toHaveBeenCalled();
      expect(dataAccess()).toEqual([]);
    }
  );

  it.each(ASSIGNMENT_GATED)(
    'refuses $name for a non-admin holding the system Owner role and a * grant',
    async ({ invoke }) => {
      // Role labels and wildcard grants are not the ADMIN role.
      sessionRole = 'EMPLOYEE';
      db.user.findUnique.mockResolvedValue({
        organizationRole: { key: 'owner', isSystem: true, permissions: [allow('*')] },
        permissionOverrides: [],
      });
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);

      await expect(invoke()).rejects.toMatchObject(OUTSIDE_SCOPE);
      expect(asksForAdminRecord()).toBe(false);
      expect(dataAccess()).toEqual([]);
    }
  );

  it.each(ASSIGNMENT_GATED)(
    'still refuses $name for a verified ADMIN whose inventory capability is explicitly denied',
    async ({ name, capability, invoke }) => {
      // Capability-gated procedures refuse at the capability check; the reads,
      // which carry no capability, refuse because the exception itself needs it.
      grant([allow(capability)], [deny(capability)]);
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
      confirmAdmin();

      await expect(invoke()).rejects.toMatchObject(
        READS.has(name) ? READ_REFUSAL : CAPABILITY_REFUSAL
      );
      expect(db.auditLog.create).not.toHaveBeenCalled();
      expect(dataAccess()).toEqual([]);
    }
  );

  it.each(ASSIGNMENT_GATED.filter((gated) => READS.has(gated.name)))(
    'gives no exception on $name to a verified ADMIN without any inventory grant',
    async ({ invoke }) => {
      grant([]);
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
      confirmAdmin();

      await expect(invoke()).rejects.toMatchObject(READ_REFUSAL);
      expect(db.auditLog.create).not.toHaveBeenCalled();
      expect(dataAccess()).toEqual([]);
    }
  );

  it.each(ASSIGNMENT_GATED)(
    'fails $name closed, before any stock access, when the exception audit cannot be written',
    async ({ capability, invoke }) => {
      grant([allow(capability)]);
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
      confirmAdmin();
      db.auditLog.create.mockRejectedValue(new Error('audit store unavailable'));

      // The refusal is the audit failure itself, not whatever the ledger answers later.
      await expect(invoke()).rejects.toMatchObject({ message: 'audit store unavailable' });
      expect(mocks.afterTenantTransaction).not.toHaveBeenCalled();
      expect(dataAccess()).toEqual([]);
    }
  );

  it.each(ASSIGNMENT_GATED)(
    'checks the tenant branch before the assignment for $name, even for an ADMIN',
    async ({ capability, invoke }) => {
      grant([allow(capability)]);
      db.pharmacyBranch.findMany.mockResolvedValue([]);
      confirmAdmin();

      await expect(invoke()).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'That record is not in this workspace.',
      });
      expect(db.pharmacyBranchAssignment.findFirst).not.toHaveBeenCalled();
      expect(asksForAdminRecord()).toBe(false);
      expect(dataAccess()).toEqual([]);
    }
  );

  it.each(ASSIGNMENT_GATED)(
    'does not let an assignment to a sibling branch admit $name',
    async ({ capability, invoke }) => {
      sessionRole = 'EMPLOYEE';
      grant([allow(capability)]);
      // The user's only assignment is to branch_b, so any lookup that is not pinned
      // to the requested branch_a finds it. A check that asked "is this user
      // assigned anywhere?" would therefore admit the request and fail here.
      db.pharmacyBranchAssignment.findFirst.mockImplementation(
        async ({ where }: { where: { branchId?: string } }) =>
          where.branchId === 'branch_a' ? null : { id: 'assignment_b' }
      );

      await expect(invoke()).rejects.toMatchObject(OUTSIDE_SCOPE);
      expect(db.pharmacyBranchAssignment.findFirst).toHaveBeenCalledWith(ASSIGNMENT_QUERY);
      expect(dataAccess()).toEqual([]);
    }
  );

  it.each(['pharmacy:*', '*'])(
    'treats a %s DENY like an inventory DENY for the exception',
    async (denied) => {
      grant([allow('pharmacy:inventory')], [deny(denied)]);
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
      confirmAdmin();

      await expect(caller().nearExpiryBoard({ branchId: 'branch_a' })).rejects.toMatchObject(
        READ_REFUSAL
      );
      await expect(
        caller().createLocation({ branchId: 'branch_a', code: 'X', name: 'X', kind: 'STORE' })
      ).rejects.toMatchObject(CAPABILITY_REFUSAL);
      expect(db.auditLog.create).not.toHaveBeenCalled();
      expect(dataAccess()).toEqual([]);
    }
  );

  it('contains a failed after-transaction re-insert instead of crashing the process', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      grant([allow('pharmacy:inventory')]);
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
      confirmAdmin();
      mocks.withTenantDb.mockRejectedValue(new Error('pool exhausted'));

      await caller().nearExpiryBoard({ branchId: 'branch_a' });
      mocks.afterTenantTransaction.mock.calls[0]![0]();
      await vi.waitFor(() =>
        expect(errors).toHaveBeenCalledWith(
          '[audit] failed to re-record',
          'pharmacy.inventory.admin_branch_exception',
          'Error'
        )
      );
    } finally {
      errors.mockRestore();
    }
  });

  it.each([
    ['flags', { id: 'placeholder_1' }, true],
    ['does not flag', null, false],
  ] as const)(
    '%s the exception row by the placeholder regulatory rule set',
    async (_label, profile, flagged) => {
      grant([allow('pharmacy:inventory')]);
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
      confirmAdmin();
      const findPlaceholder = vi.fn().mockResolvedValue(profile);
      Object.assign(db, { branchRegulatoryProfile: { findFirst: findPlaceholder } });

      await caller().nearExpiryBoard({ branchId: 'branch_a' });
      // The same lookup recordAudit makes for every tenant audit row.
      expect(findPlaceholder).toHaveBeenCalledWith({
        where: { organizationId: 'org_a', isPlaceholder: true, effectiveTo: null },
        select: { id: true },
      });
      const { metadata } = (
        db.auditLog.create.mock.calls[0]![0] as {
          data: { metadata: Record<string, unknown> };
        }
      ).data;
      expect('placeholder' in metadata).toBe(flagged);
      if (flagged) expect(metadata.placeholder).toBe(true);
    }
  );

  it('names the platform support session on the exception row', async () => {
    sessionExtras = {
      isSupportSession: true,
      supportSessionId: 'support_1',
      platformUserId: 'platform_1',
    };
    grant([allow('pharmacy:inventory')]);
    db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
    confirmAdmin();

    await caller().nearExpiryBoard({ branchId: 'branch_a' });
    expect(db.auditLog.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        actorId: 'user_a',
        metadata: {
          branchId: 'branch_a',
          reason: 'tenant-admin-inventory-access-without-branch-assignment',
          supportSessionId: 'support_1',
          platformUserId: 'platform_1',
          actingAsTenantUserId: 'user_a',
        },
      }),
    });
  });

  it('uses the assignment, not the exception, for an assigned ADMIN', async () => {
    grant([allow('pharmacy:inventory')]);
    confirmAdmin();

    await expect(
      caller().createLocation({ branchId: 'branch_a', code: 'MAIN', name: 'Main', kind: 'STORE' })
    ).resolves.toMatchObject({ organizationId: 'org_a', branchId: 'branch_a' });
    expect(asksForAdminRecord()).toBe(false);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('lists only the active, assigned branches for a non-admin', async () => {
    db.pharmacyBranchAssignment.findMany.mockResolvedValue([
      { branchId: 'branch_a' },
      { branchId: 'branch_c' },
    ]);
    const ctx = {
      db,
      entitlements: { organizationId: 'org_a' },
      session: { user: { id: 'user_a', role: 'EMPLOYEE', status: 'ACTIVE' } },
    } as unknown as TRPCContext;

    await expect(admittedInventoryBranchIds(ctx)).resolves.toEqual(
      new Set(['branch_a', 'branch_c'])
    );
    expect(db.pharmacyBranchAssignment.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_a',
        userId: 'user_a',
        active: true,
        branch: { organizationId: 'org_a', active: true },
      },
      select: { branchId: true },
    });
  });

  it('lists every active branch of the tenant for a verified ADMIN', async () => {
    grant([allow('pharmacy:inventory')]);
    confirmAdmin();
    db.pharmacyBranch.findMany.mockResolvedValue([{ id: 'branch_a' }, { id: 'branch_b' }]);
    const ctx = {
      db,
      entitlements: { organizationId: 'org_a' },
      session: { user: { id: 'user_a', role: 'ADMIN', status: 'ACTIVE' } },
    } as unknown as TRPCContext;

    await expect(admittedInventoryBranchIds(ctx)).resolves.toEqual(
      new Set(['branch_a', 'branch_b'])
    );
    expect(db.user.findFirst).toHaveBeenCalledWith(ADMIN_RECORD_QUERY);
    expect(db.pharmacyBranch.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_a', active: true },
      select: { id: true },
    });
    expect(db.pharmacyBranchAssignment.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ['without any inventory grant', [] as Rule[], [] as Rule[]],
    [
      'with an explicit inventory DENY',
      [allow('pharmacy:inventory')],
      [deny('pharmacy:inventory')],
    ],
  ])('lists only assigned branches for a verified ADMIN %s', async (_label, role, overrides) => {
    grant(role, overrides);
    confirmAdmin();
    db.pharmacyBranchAssignment.findMany.mockResolvedValue([{ branchId: 'branch_a' }]);
    const ctx = {
      db,
      entitlements: { organizationId: 'org_a' },
      session: { user: { id: 'user_a', role: 'ADMIN', status: 'ACTIVE' } },
    } as unknown as TRPCContext;

    await expect(admittedInventoryBranchIds(ctx)).resolves.toEqual(new Set(['branch_a']));
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
  });

  it('lists only assigned branches for an ADMIN session the record does not confirm', async () => {
    db.pharmacyBranchAssignment.findMany.mockResolvedValue([{ branchId: 'branch_a' }]);
    const ctx = {
      db,
      entitlements: { organizationId: 'org_a' },
      session: { user: { id: 'user_a', role: 'ADMIN', status: 'ACTIVE' } },
    } as unknown as TRPCContext;

    await expect(admittedInventoryBranchIds(ctx)).resolves.toEqual(new Set(['branch_a']));
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
  });

  it('refuses to list branches without a tenant actor', async () => {
    const ctx = {
      db,
      entitlements: { organizationId: 'org_a' },
      session: null,
    } as unknown as TRPCContext;

    await expect(admittedInventoryBranchIds(ctx)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(db.pharmacyBranchAssignment.findMany).not.toHaveBeenCalled();
  });

  it('lets an assigned user create a location at that branch', async () => {
    sessionRole = 'EMPLOYEE';
    grant([allow('pharmacy:inventory')]);

    await expect(
      caller().createLocation({
        branchId: 'branch_a',
        code: 'MAIN',
        name: 'Main store',
        kind: 'STORE',
      })
    ).resolves.toMatchObject({ organizationId: 'org_a', branchId: 'branch_a' });
    expect(db.pharmacyBranchAssignment.findFirst).toHaveBeenCalledWith(ASSIGNMENT_QUERY);
  });
});

/**
 * DEV-660 residual: branch-scoped procedures still on the tenant-only branch
 * check. DEV-505 moved every `pharmacy:inventory` procedure into
 * ASSIGNMENT_GATED; only the `pharmacy:safety` ones remain here. A new procedure
 * that takes a branchId must be placed in one of the two lists, so none skips
 * the decision.
 */
const TENANT_ONLY_BRANCH_PROCEDURES = ['quarantinePart', 'acknowledgeRecall'];

function takesBranchId(schema: unknown): boolean {
  const zod = schema as {
    shape?: Record<string, unknown>;
    def?: { type?: string; options?: unknown[] };
  };
  if (zod?.shape) return 'branchId' in zod.shape;
  if (zod?.def?.type === 'union') return (zod.def.options ?? []).some(takesBranchId);
  return false;
}

describe('DEV-660 — every branch-scoped procedure is classified', () => {
  it('places each procedure that takes a branchId in exactly one list', () => {
    const procedures = pharmacyInventoryRouter._def.procedures as unknown as Record<
      string,
      { _def: { inputs: unknown[] } }
    >;
    const branchScoped = Object.entries(procedures)
      .filter(([, procedure]) => procedure._def.inputs.some(takesBranchId))
      .map(([name]) => name)
      .sort();
    const classified = [
      ...ASSIGNMENT_GATED.map((gated) => gated.name),
      ...TENANT_ONLY_BRANCH_PROCEDURES,
    ].sort();

    expect(new Set(classified).size).toBe(classified.length);
    expect(branchScoped).toEqual(classified);
    expect(ASSIGNMENT_GATED).toHaveLength(41);
  });
});

const LOCATION_ROW = {
  id: 'location_1',
  coldChain: false,
  minimumTemperatureC: null,
  maximumTemperatureC: null,
};

/** #355: every storage-zone, cold-chain and recall write goes through `can()`. */
const GATED_MUTATIONS = [
  {
    procedure: 'createLocation',
    capability: 'pharmacy:inventory',
    input: { branchId: 'branch_a', code: 'FRIDGE-1', name: 'Vaccine fridge', kind: 'FRIDGE' },
    writes: () => [db.pharmacyStockLocation.create],
  },
  {
    procedure: 'recordTemperature',
    capability: 'pharmacy:inventory',
    input: {
      branchId: 'branch_a',
      stockLocationId: 'location_1',
      temperatureC: 5,
      recordedAt: new Date('2026-10-22T08:00:00.000Z'),
    },
    writes: () => [db.pharmacyTemperatureLog.createMany],
  },
  {
    procedure: 'importTemperatureCsv',
    capability: 'pharmacy:inventory',
    input: {
      branchId: 'branch_a',
      stockLocationId: 'location_1',
      csv: 'recordedAt,temperatureC\n2026-10-22T08:00:00.000Z,5\n',
    },
    writes: () => [db.pharmacyTemperatureLog.createMany],
  },
  {
    procedure: 'configureTemperatureMonitoring',
    capability: 'pharmacy:inventory',
    input: {
      branchId: 'branch_a',
      stockLocationId: 'location_1',
      expectedTemperatureReadingIntervalMinutes: 30,
      temperatureExcursionDurationMinutes: 60,
    },
    writes: () => [db.pharmacyStockLocation.update],
  },
  {
    procedure: 'createRecall',
    capability: 'pharmacy:safety',
    input: { batchId: 'batch_1', reference: 'DRAP-R-1', reason: 'Contaminated lot' },
    writes: () => [db.pharmacyManufacturingBatch.updateMany, db.pharmacyRecallNotice.create],
  },
] as const;

describe.each(GATED_MUTATIONS)(
  '#355 — $procedure requires $capability',
  ({ procedure, capability, input, writes }) => {
    const run = () => caller()[procedure](input as never);

    beforeEach(() => {
      // The zone exists in the branch, so only the capability check can refuse.
      db.pharmacyStockLocation.findFirst.mockResolvedValue(LOCATION_ROW);
    });

    it('refuses a member without the capability before any read or write', async () => {
      grant([allow('pharmacy:counter'), allow('pharmacy:orders')]);
      await expect(run()).rejects.toMatchObject(CAPABILITY_REFUSAL);
      expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
      expect(db.pharmacyStockLocation.findFirst).not.toHaveBeenCalled();
      for (const write of writes()) expect(write).not.toHaveBeenCalled();
    });

    it('runs for the exact grant', async () => {
      grant([allow(capability)]);
      if (procedure === 'createRecall') {
        db.$queryRaw.mockResolvedValueOnce([]);
        // DEV-825: the batch lock statement, then the read of the locked batches.
        db.$queryRaw.mockResolvedValueOnce([]);
        db.$queryRaw.mockResolvedValueOnce([{ id: 'batch_1', medicineId: 'medicine_1' }] as never);
      }
      await run();
      for (const write of writes()) expect(write).toHaveBeenCalledTimes(1);
    });

    it('lets a user DENY override beat a role ALLOW', async () => {
      grant([allow(capability)], [deny(capability)]);
      await expect(run()).rejects.toMatchObject(CAPABILITY_REFUSAL);
      for (const write of writes()) expect(write).not.toHaveBeenCalled();
    });

    it('lets a role DENY beat a user ALLOW override', async () => {
      grant([deny(capability)], [allow(capability)]);
      await expect(run()).rejects.toMatchObject(CAPABILITY_REFUSAL);
      for (const write of writes()) expect(write).not.toHaveBeenCalled();
    });
  }
);

describe('manual quarantine resolution authorization', () => {
  const input = {
    branchId: 'branch_a',
    inventoryLotId: 'lot_1',
    stockLocationId: 'location_1',
    units: 10,
    reason: 'Inspection passed',
    idempotencyKeyPrefix: 'release-1',
  };

  beforeEach(() => {
    grant([allow('pharmacy:inventory')]);
    db.pharmacyInventoryLot.findFirst.mockResolvedValue({ id: 'lot_1', unitsPerPack: 10 });
    db.pharmacyStockBalance.findFirst.mockResolvedValue({
      onHandUnits: 20,
      sealedPacks: 2,
      looseUnits: 0,
    });
  });

  it('lets an inventory-only actor release a manual hold with session attribution', async () => {
    await caller().releaseQuarantinedPart(input);
    expect(db.pharmacyStockMovement.create).toHaveBeenCalledTimes(2);
    expect(db.pharmacyStockMovement.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        organizationId: 'org_a',
        branchId: 'branch_a',
        actorId: 'user_a',
        disposition: 'AVAILABLE',
        quantityUnits: 10,
        reason: 'Inspection passed',
      }),
    });
    expect(db.pharmacyRecallQuarantineAction.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_a',
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_1',
        reversedAt: null,
      },
      select: { quantityUnits: true, heldMovementId: true },
    });
  });

  it('writes off a manual damaged hold with witnessed custody evidence', async () => {
    witnessPinOnFile();
    db.user.findFirst.mockResolvedValue({ id: 'witness' });
    await caller().writeOff({
      branchId: input.branchId,
      inventoryLotId: input.inventoryLotId,
      stockLocationId: input.stockLocationId,
      units: input.units,
      reason: 'Crushed in delivery',
      disposition: 'DAMAGED',
      witnessId: 'witness',
      witnessPin: '2468',
      evidenceRef: 'photo-damaged-1',
      idempotencyKey: 'write-off-damaged-1',
    });
    expect(db.pharmacyStockBalance.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_a',
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_1',
        disposition: 'DAMAGED',
      },
    });
    expect(db.pharmacyStockMovement.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        kind: 'WRITE_OFF',
        disposition: 'DAMAGED',
        quantityUnits: -10,
        actorId: 'user_a',
      }),
    });
    expect(db.pharmacyCustodyRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        witnessId: 'witness',
        evidenceRef: 'photo-damaged-1',
      }),
    });
  });

  it.each(['release', 'write-off'])(
    'refuses regulatory stock through inventory-only %s before posting movements',
    async (operation) => {
      // Reach the regulatory-stock guard with a valid independent witness;
      // missing/ineligible witnesses are refused by writeOff before stock reads.
      db.user.findFirst.mockResolvedValue({ id: 'witness' });
      witnessPinOnFile();
      db.pharmacyRecallQuarantineAction.findMany.mockResolvedValue([
        { quantityUnits: 20, heldMovementId: 'recall-held-1' },
      ]);
      const result =
        operation === 'release'
          ? caller().releaseQuarantinedPart(input)
          : caller().writeOff({
              branchId: input.branchId,
              inventoryLotId: input.inventoryLotId,
              stockLocationId: input.stockLocationId,
              units: input.units,
              reason: input.reason,
              disposition: 'QUARANTINE',
              witnessId: 'witness',
              witnessPin: '2468',
              evidenceRef: 'certificate',
              idempotencyKey: 'write-off-1',
            });
      await expect(result).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'INSUFFICIENT_STOCK',
      });
      if (operation === 'write-off') {
        expect(db.user.findFirst).toHaveBeenCalledWith({
          where: {
            id: 'witness',
            organizationId: 'org_a',
            status: 'ACTIVE',
            pharmacyBranchAssignments: {
              some: { organizationId: 'org_a', branchId: 'branch_a', active: true },
            },
          },
          select: { id: true },
        });
      }
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
      expect(db.pharmacyCustodyRecord.create).not.toHaveBeenCalled();
    }
  );

  it('still requires safety authority for the regulatory reversal', async () => {
    await expect(
      caller().reverseDrapRecall({ recallNoticeId: 'recall_1', reason: 'Cleared' })
    ).rejects.toMatchObject(CAPABILITY_REFUSAL);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  // DEV-832 (F08 sibling): the recall contact list names customers who bought
  // the lot, so it needs the safety grant and masks phones without patient records.
  describe('drapRecallActions patient contact', () => {
    const row = {
      branchId: 'branch_a',
      inventoryLotId: 'lot_1',
      quarantinedUnits: 4,
      patientName: 'Synthetic Patient',
      patientPhone: '+923001234567',
    };

    it('refuses a member without pharmacy:safety before reading contacts', async () => {
      sessionRole = 'EMPLOYEE';
      grant([allow('pharmacy:inventory'), allow('pharmacy:counter')]);
      await expect(
        caller().drapRecallActions({ recallNoticeId: 'recall_1' })
      ).rejects.toMatchObject(CAPABILITY_REFUSAL);
      expect(db.$queryRaw).not.toHaveBeenCalled();
    });

    it('masks the phone for a safety holder without patient records', async () => {
      sessionRole = 'EMPLOYEE';
      grant([allow('pharmacy:safety')]);
      db.$queryRaw.mockResolvedValue([row]);
      const rows = await caller().drapRecallActions({ recallNoticeId: 'recall_1' });
      expect(JSON.stringify(rows)).not.toContain('+923001234567');
      expect(rows).toEqual([{ ...row, patientPhone: '*********4567' }]);
    });

    it('returns the full phone to a safety holder who also holds patient records', async () => {
      sessionRole = 'EMPLOYEE';
      grant([allow('pharmacy:safety'), allow('pharmacy:prescriptions')]);
      db.$queryRaw.mockResolvedValue([row]);
      await expect(caller().drapRecallActions({ recallNoticeId: 'recall_1' })).resolves.toEqual([
        row,
      ]);
    });
  });

  it('requires safety authority to read, confirm or dismiss DRAP recall drafts', async () => {
    await expect(caller().drapRecallQueue()).rejects.toMatchObject(CAPABILITY_REFUSAL);
    await expect(caller().confirmDrapRecall({ ingestId: 'ingest_1' })).rejects.toMatchObject(
      CAPABILITY_REFUSAL
    );
    await expect(
      caller().dismissDrapRecall({ ingestId: 'ingest_1', reason: 'Not stocked' })
    ).rejects.toMatchObject(CAPABILITY_REFUSAL);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an out-of-tenant branch before looking up stock', async () => {
    db.pharmacyBranch.findMany.mockResolvedValue([]);
    await expect(caller().releaseQuarantinedPart(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That record is not in this workspace.',
    });
    expect(db.pharmacyInventoryLot.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });
});

describe('#355 — remaining stock mutations require pharmacy:inventory', () => {
  it.each([
    [
      'registerBatch',
      {
        medicineId: 'medicine_1',
        batchNumber: 'B-1',
        printedExpiry: new Date('2027-06-15T00:00:00.000Z'),
        expiryPrecision: 'DAY',
      },
    ],
    [
      'allocateForSale',
      {
        branchId: 'branch_a',
        medicineId: 'medicine_1',
        requiredUnits: 1,
        idempotencyKeyPrefix: 'sale-1',
      },
    ],
    ['acknowledgeSignal', { branchId: 'branch_a', signalId: 'signal_1' }],
    [
      'draftExpiryMarkdown',
      {
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_1',
        markdownPercent: 10,
        reason: 'Near expiry',
      },
    ],
    [
      'receiveTransferWithVariance',
      {
        branchId: 'branch_a',
        transferId: 'transfer_1',
        lines: [{ lineId: 'line_1', receivedUnits: 1 }],
        idempotencyKeyPrefix: 'receive-1',
      },
    ],
    [
      'quarantinePart',
      {
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_1',
        units: 1,
        reason: 'Manual safety hold',
        idempotencyKeyPrefix: 'hold-1',
      },
    ],
    [
      'releaseQuarantinedPart',
      {
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_1',
        units: 1,
        reason: 'Inspection passed',
        idempotencyKeyPrefix: 'release-1',
      },
    ],
  ] as const)('honours an explicit DENY for %s before handler access', async (procedure, input) => {
    grant([allow('pharmacy:inventory')], [deny('pharmacy:inventory')]);

    await expect(caller()[procedure](input as never)).rejects.toMatchObject(CAPABILITY_REFUSAL);
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    [
      'receiveLot',
      {
        branchId: 'branch_a',
        manufacturingBatchId: 'batch_1',
        packLevelId: 'pack_level_1',
        stockLocationId: 'location_1',
        unitsPerPack: 10,
        supplierName: 'Distributor Ltd',
        supplierInvoiceRef: 'INV-1',
        unitCostMinor: 1200,
        printedMrpMinor: 2000,
        printedExpiry: new Date('2027-06-15T00:00:00.000Z'),
        expiryPrecision: 'DAY',
        quantityUnits: 100,
        idempotencyKey: 'receipt-1',
      },
    ],
    [
      'receiveTransferLine',
      {
        branchId: 'branch_a',
        transferId: 'transfer_1',
        lineId: 'line_1',
        receivedUnits: 10,
        idempotencyKeyPrefix: 'transfer-receipt-1',
      },
    ],
    [
      'reserveSupplierClaim',
      {
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        reservedUnits: 10,
        returnBy: new Date('2026-11-22T00:00:00.000Z'),
      },
    ],
  ] as const)('refuses %s before resolving its branch', async (procedure, input) => {
    grant([allow('pharmacy:counter'), allow('pharmacy:orders')]);

    await expect(caller()[procedure](input as never)).rejects.toMatchObject(CAPABILITY_REFUSAL);
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
  });
});

describe('#355 — wildcard grants', () => {
  it.each(GATED_MUTATIONS.filter((gated) => gated.capability === 'pharmacy:inventory'))(
    'lets the Owner template (pharmacy:*) run $procedure',
    async ({ procedure, input, writes }) => {
      db.pharmacyStockLocation.findFirst.mockResolvedValue(LOCATION_ROW);
      grant([allow('pharmacy:*')]);
      await caller()[procedure](input as never);
      for (const write of writes()) expect(write).toHaveBeenCalledTimes(1);
    }
  );

  it('does not let pharmacy:* raise a recall: pharmacy:safety is an exact grant', async () => {
    grant([allow('pharmacy:*'), allow('pharmacy:inventory')]);
    await expect(
      caller().createRecall({
        batchId: 'batch_1',
        reference: 'DRAP-R-1',
        reason: 'Contaminated lot',
      })
    ).rejects.toMatchObject(CAPABILITY_REFUSAL);
    expect(db.pharmacyManufacturingBatch.updateMany).not.toHaveBeenCalled();
    expect(db.pharmacyRecallNotice.create).not.toHaveBeenCalled();
  });
});

describe('PUR-07 — the stock action centre transport', () => {
  it('gates the action centre behind the same pharmacy-inventory entitlement', () => {
    expect(moduleForProcedure('pharmacyInventory.refreshStockSignals')).toBe('pharmacy-inventory');
    expect(moduleForProcedure('pharmacyInventory.createDraftAction')).toBe('pharmacy-inventory');
  });

  it('records the SESSION actor as the safety-stock approver, never a payload field', async () => {
    grant([allow('pharmacy:inventory')]);
    db.medicine.findFirst.mockResolvedValue({ id: 'medicine_1' });
    await caller({ userId: 'user_pharmacist_in_charge' }).approveSafetyStock({
      branchId: 'branch_a',
      medicineId: 'medicine_1',
      safetyStockUnits: 120,
      coverageDays: 30,
    });
    expect(db.pharmacySafetyStock.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          organizationId: 'org_a',
          approvedByUserId: 'user_pharmacist_in_charge',
        }),
      })
    );
  });

  it('rejects a cross-tenant medicine ID when approving a safety stock', async () => {
    grant([allow('pharmacy:inventory')]);
    await expect(
      caller().approveSafetyStock({
        branchId: 'branch_a',
        medicineId: 'medicine_from_org_b',
        safetyStockUnits: 120,
        coverageDays: 30,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacySafetyStock.upsert).not.toHaveBeenCalled();
  });

  it('refuses a snooze or a dismissal with no reason (§8A invariant 29)', async () => {
    grant([allow('pharmacy:inventory')]);
    for (const call of [
      () =>
        caller().snoozeSignal({
          branchId: 'branch_a',
          signalId: 'signal_1',
          until: new Date('2026-09-10T00:00:00.000Z'),
          reason: '   ',
        }),
      () => caller().dismissSignal({ branchId: 'branch_a', signalId: 'signal_1', reason: '' }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(db.pharmacyStockSignal.update).not.toHaveBeenCalled();
  });

  it('has no draft-action shape that could name a purchase order or a movement', async () => {
    // §8A invariant 29 at the transport layer: the discriminated union admits
    // exactly three kinds, all of them drafts. A caller cannot smuggle a fourth.
    await expect(
      caller().createDraftAction({
        // @ts-expect-error — proving the schema rejects a non-draft action kind.
        kind: 'CREATE_PURCHASE_ORDER',
        branchId: 'branch_a',
        signalId: 'signal_1',
      })
    ).rejects.toBeDefined();
    expect(db.pharmacyStockSignalAction.create).not.toHaveBeenCalled();
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('refuses a draft action when there is no tenant actor to attribute it to', async () => {
    await expect(
      caller({ userId: null }).createDraftAction({
        kind: 'DRAFT_REQUISITION',
        branchId: 'branch_a',
        signalId: 'signal_1',
        reference: 'REQ-1',
        medicineId: 'medicine_1',
        packLevelId: 'pack_1',
        canonicalUnitsPerPack: 10,
        quantityPacks: 8,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(db.pharmacyRequisition.create).not.toHaveBeenCalled();
  });
});

describe('PR J (#979) — the transfer board needs pharmacy:inventory', () => {
  it('refuses the cashier before reading any transfer', async () => {
    grant([allow('pharmacy:counter'), allow('pharmacy:orders')]);
    await expect(caller().transferBoard({ branchId: 'branch_a' })).rejects.toMatchObject(
      CAPABILITY_REFUSAL
    );
    expect(db.pharmacyInterbranchTransfer.findMany).not.toHaveBeenCalled();
  });

  it('reads the board for the inventory grant', async () => {
    grant([allow('pharmacy:inventory')]);
    db.pharmacyInterbranchTransfer.findMany.mockResolvedValue([]);
    Object.assign(db.user, { findMany: vi.fn().mockResolvedValue([]) });
    await expect(caller().transferBoard({ branchId: 'branch_a' })).resolves.toEqual([]);
  });
});

describe('DEV-82 — live cold-chain sensor management', () => {
  const COLD_ZONE = {
    id: 'fridge_1',
    coldChain: true,
    minimumTemperatureC: 2,
    maximumTemperatureC: 8,
  };
  const ENROLL = {
    branchId: 'branch_a',
    stockLocationId: 'fridge_1',
    name: 'Vaccine fridge probe',
    deviceIdentifier: 'SN-001',
  };

  it('maps every sensor procedure to the pharmacy-inventory entitlement', () => {
    for (const procedure of [
      'coldChainSensors',
      'enrollColdChainSensor',
      'rotateColdChainSensorSecret',
      'revokeColdChainSensor',
    ]) {
      expect(moduleForProcedure(`pharmacyInventory.${procedure}`)).toBe('pharmacy-inventory');
    }
  });

  it('refuses credential issuance without pharmacy:inventory', async () => {
    grant([allow('pharmacy:counter')]);
    db.pharmacyStockLocation.findFirst.mockResolvedValue(COLD_ZONE);
    await expect(caller().enrollColdChainSensor(ENROLL)).rejects.toMatchObject(CAPABILITY_REFUSAL);
    await expect(
      caller().rotateColdChainSensorSecret({ branchId: 'branch_a', sensorId: 'sensor_1' })
    ).rejects.toMatchObject(CAPABILITY_REFUSAL);
    expect(db.pharmacyColdChainSensor.create).not.toHaveBeenCalled();
    expect(db.pharmacyColdChainSensor.update).not.toHaveBeenCalled();
  });

  it('issues the secret once and stores only its hash, scoped to the session', async () => {
    grant([allow('pharmacy:inventory')]);
    db.pharmacyStockLocation.findFirst.mockResolvedValue(COLD_ZONE);
    const result = await caller().enrollColdChainSensor(ENROLL);
    expect(result?.secret).toMatch(/^pcs_[A-Za-z0-9_-]{43}$/);
    const [{ data }] = db.pharmacyColdChainSensor.create.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ];
    expect(data).toMatchObject({
      organizationId: 'org_a',
      branchId: 'branch_a',
      stockLocationId: 'fridge_1',
      deviceIdentifier: 'SN-001',
      enrolledByActorId: 'user_a',
    });
    expect(data.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(data)).not.toContain(result!.secret);
    expect(db.pharmacyStockLocation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org_a', branchId: 'branch_a' }),
      })
    );
  });

  it('refuses to bind a sensor to a zone that is not a validated cold-chain zone', async () => {
    grant([allow('pharmacy:inventory')]);
    db.pharmacyStockLocation.findFirst.mockResolvedValue(LOCATION_ROW);
    await expect(caller().enrollColdChainSensor(ENROLL)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'LOCATION_NOT_COLD_CHAIN',
    });
    expect(db.pharmacyColdChainSensor.create).not.toHaveBeenCalled();
  });

  it('refuses a zone from another branch or tenant', async () => {
    grant([allow('pharmacy:inventory')]);
    db.pharmacyStockLocation.findFirst.mockResolvedValue(null);
    await expect(caller().enrollColdChainSensor(ENROLL)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.pharmacyColdChainSensor.create).not.toHaveBeenCalled();
  });

  it('refuses a serial already enrolled in the organization', async () => {
    grant([allow('pharmacy:inventory')]);
    db.pharmacyStockLocation.findFirst.mockResolvedValue(COLD_ZONE);
    db.pharmacyColdChainSensor.findFirst.mockResolvedValue({ id: 'sensor_existing' });
    await expect(caller().enrollColdChainSensor(ENROLL)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(db.pharmacyColdChainSensor.create).not.toHaveBeenCalled();
  });

  it('re-enrolls a revoked serial on its own row with a fresh secret', async () => {
    grant([allow('pharmacy:inventory')]);
    db.pharmacyStockLocation.findFirst.mockResolvedValue(COLD_ZONE);
    db.pharmacyColdChainSensor.findFirst.mockResolvedValue({
      id: 'sensor_existing',
      status: 'REVOKED',
    });
    const result = await caller().enrollColdChainSensor(ENROLL);
    expect(result?.secret).toMatch(/^pcs_[A-Za-z0-9_-]{43}$/);
    expect(db.pharmacyColdChainSensor.create).not.toHaveBeenCalled();
    const [{ where, data }] = db.pharmacyColdChainSensor.updateMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ];
    expect(where).toEqual({ organizationId: 'org_a', id: 'sensor_existing', status: 'REVOKED' });
    expect(data).toMatchObject({
      branchId: 'branch_a',
      stockLocationId: 'fridge_1',
      status: 'ACTIVE',
      revokedAt: null,
      enrolledByActorId: 'user_a',
    });
    expect(data.secretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports a lost re-enrollment race as CONFLICT', async () => {
    grant([allow('pharmacy:inventory')]);
    db.pharmacyStockLocation.findFirst.mockResolvedValue(COLD_ZONE);
    db.pharmacyColdChainSensor.findFirst.mockResolvedValue({
      id: 'sensor_existing',
      status: 'REVOKED',
    });
    db.pharmacyColdChainSensor.updateMany.mockResolvedValue({ count: 0 });
    await expect(caller().enrollColdChainSensor(ENROLL)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'DUPLICATE_DEVICE_IDENTIFIER',
    });
  });

  it('reports a concurrent enrollment of the same serial as CONFLICT, not a 500', async () => {
    grant([allow('pharmacy:inventory')]);
    db.pharmacyStockLocation.findFirst.mockResolvedValue(COLD_ZONE);
    db.pharmacyColdChainSensor.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['organizationId', 'deviceIdentifier'] },
      })
    );
    await expect(caller().enrollColdChainSensor(ENROLL)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'DUPLICATE_DEVICE_IDENTIFIER',
    });
  });

  it('re-attributes a sensor to the rotating admin', async () => {
    grant([allow('pharmacy:inventory')]);
    db.$queryRaw.mockResolvedValue([{ id: 'sensor_1', status: 'ACTIVE', revokedAt: null }]);
    await caller().rotateColdChainSensorSecret({ branchId: 'branch_a', sensorId: 'sensor_1' });
    const [{ data }] = db.pharmacyColdChainSensor.update.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ];
    expect(data).toMatchObject({ enrolledByActorId: 'user_a' });
    expect(data.secretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gates listing and revocation behind pharmacy:inventory', async () => {
    grant([allow('pharmacy:counter')]);
    await expect(caller().coldChainSensors({ branchId: 'branch_a' })).rejects.toMatchObject(
      CAPABILITY_REFUSAL
    );
    await expect(
      caller().revokeColdChainSensor({ branchId: 'branch_a', sensorId: 'sensor_1' })
    ).rejects.toMatchObject(CAPABILITY_REFUSAL);
    expect(db.pharmacyColdChainSensor.findMany).not.toHaveBeenCalled();
    expect(db.pharmacyColdChainSensor.update).not.toHaveBeenCalled();
  });

  it('lists sensors for the session branch without ever selecting the secret hash', async () => {
    grant([allow('pharmacy:inventory')]);
    await caller().coldChainSensors({ branchId: 'branch_a' });
    const [query] = db.pharmacyColdChainSensor.findMany.mock.calls[0] as unknown as [
      { where: object; select: Record<string, boolean> },
    ];
    expect(query.where).toEqual({ organizationId: 'org_a', branchId: 'branch_a' });
    expect(query.select).not.toHaveProperty('secretHash');
  });

  it('revokes with a server timestamp inside the session branch', async () => {
    grant([allow('pharmacy:inventory')]);
    db.$queryRaw.mockResolvedValue([{ id: 'sensor_1', status: 'ACTIVE', revokedAt: null }]);
    await caller().revokeColdChainSensor({ branchId: 'branch_a', sensorId: 'sensor_1' });
    expect(db.pharmacyColdChainSensor.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId_id: { organizationId: 'org_a', id: 'sensor_1' } },
        data: { status: 'REVOKED', revokedAt: expect.any(Date) },
      })
    );
  });

  it('reports an unknown sensor as NOT_FOUND on revoke', async () => {
    grant([allow('pharmacy:inventory')]);
    db.$queryRaw.mockResolvedValue([]);
    await expect(
      caller().revokeColdChainSensor({ branchId: 'branch_a', sensorId: 'sensor_other' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.pharmacyColdChainSensor.update).not.toHaveBeenCalled();
  });
});

// ── DEV-608 — who may move stock between locations in a branch ─────────────

/**
 * The pharmacy system roles whose real template grants reach `pharmacy:inventory`
 * (owner through `pharmacy:*`). Every other template, Manager included, holds no
 * inventory grant, so a location move is refused before any stock is read.
 */
// DEV-505: the Manager template now holds stock control on its assigned branches.
const TRANSFER_ROLES = ['owner', 'owner-operator', 'inventory', 'manager'];

const transferRequest = () =>
  caller().transfer({
    branchId: 'branch_a',
    inventoryLotId: 'lot_1',
    fromStockLocationId: 'location_1',
    toStockLocationId: 'location_2',
    units: 1,
    idempotencyKeyPrefix: 'move-1',
  });

describe('DEV-608 — location transfer role matrix', () => {
  it('covers every pharmacy system role template', () => {
    for (const key of TRANSFER_ROLES) {
      expect(PHARMACY_ROLE_TEMPLATES.map((role) => role.key)).toContain(key);
    }
  });

  it.each(PHARMACY_ROLE_TEMPLATES.map((role) => [role.key, role.capabilities] as const))(
    '%s, on a branch it is assigned to, is admitted or refused by its template grants',
    async (key, capabilities) => {
      sessionRole = 'EMPLOYEE';
      grant(capabilities.map(allow));

      const outcome = await transferRequest().then(
        () => null,
        (error: { code?: string; message?: string }) => error
      );

      if (TRANSFER_ROLES.includes(key)) {
        // Past the capability and branch rules: the (mocked, empty) ledger answers.
        expect(outcome).toMatchObject({ code: 'NOT_FOUND' });
        expect(db.pharmacyBranchAssignment.findFirst).toHaveBeenCalledWith(ASSIGNMENT_QUERY);
        expect(db.pharmacyStockMovement.findMany).toHaveBeenCalled();
      } else {
        expect(outcome).toMatchObject(CAPABILITY_REFUSAL);
        expect(dataAccess()).toEqual([]);
      }
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    }
  );

  it.each(TRANSFER_ROLES)(
    'refuses %s on a branch it is not assigned to, before any stock access',
    async (key) => {
      sessionRole = 'EMPLOYEE';
      grant(PHARMACY_ROLE_TEMPLATES.find((role) => role.key === key)!.capabilities.map(allow));
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);

      await expect(transferRequest()).rejects.toMatchObject(OUTSIDE_SCOPE);
      expect(dataAccess()).toEqual([]);
    }
  );

  it('refuses a cashier even on a branch the cashier is assigned to', async () => {
    sessionRole = 'EMPLOYEE';
    grant(PHARMACY_ROLE_TEMPLATES.find((role) => role.key === 'cashier')!.capabilities.map(allow));

    await expect(transferRequest()).rejects.toMatchObject(CAPABILITY_REFUSAL);
    expect(dataAccess()).toEqual([]);
  });

  it('answers a transfer retry with the first result instead of failing (CONFLICT on reuse)', async () => {
    grant([allow('pharmacy:inventory')]);
    db.pharmacyStockMovement.findMany.mockResolvedValue([
      {
        id: 'out_1',
        branchId: 'branch_a',
        idempotencyKey: 'move-1:out',
        kind: 'TRANSFER_OUT',
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_1',
        quantityUnits: -1,
      },
      {
        id: 'in_1',
        branchId: 'branch_a',
        idempotencyKey: 'move-1:in',
        kind: 'TRANSFER_IN',
        inventoryLotId: 'lot_1',
        stockLocationId: 'location_2',
        quantityUnits: 1,
      },
    ]);

    await expect(transferRequest()).resolves.toMatchObject({
      out: { id: 'out_1' },
      received: { id: 'in_1' },
    });
    await expect(
      caller().transfer({
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        fromStockLocationId: 'location_1',
        toStockLocationId: 'location_2',
        units: 2,
        idempotencyKeyPrefix: 'move-1',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'IDEMPOTENCY_CONFLICT' });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });
});
