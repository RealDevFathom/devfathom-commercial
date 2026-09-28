/**
 * WHA-1603 — INV-07 transfers console procedures, transport and composition.
 *
 * `transferBoard` and `receiveTransferWithVariance` against a mocked client:
 * what is posted, where, under which key, and what is refused before anything
 * is posted. The ledger triggers and the concurrency lock are proved against
 * PostgreSQL in `pharmacy-inventory-transfers.db.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const hasModule = vi.fn<(view: { enabledModules: string[] }, key: string) => boolean>();
  return { hasModule };
});
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.hasModule,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { moduleForProcedure } from '@/lib/module-catalog';

import { pharmacyInventoryRouter } from './pharmacy-inventory';
import type { TRPCContext } from '../trpc';

type Line = {
  id: string;
  transferId: string;
  sourceBranchId: string;
  sourceLotId: string;
  sourceStockLocationId: string;
  destinationStockLocationId: string;
  quantityUnits: number;
  receivedUnits: number;
};

function line(overrides: Partial<Line> = {}): Line {
  return {
    id: 'line_1',
    transferId: 'tr_1',
    sourceBranchId: 'branch_src',
    sourceLotId: 'lot_src',
    sourceStockLocationId: 'loc_src',
    destinationStockLocationId: 'loc_dst',
    quantityUnits: 30,
    receivedUnits: 0,
    ...overrides,
  };
}

function transfer(status = 'DISPATCHED', lines: Line[] = [line()]) {
  return {
    id: 'tr_1',
    organizationId: 'org_a',
    fromBranchId: 'branch_src',
    toBranchId: 'branch_dst',
    status,
    allocatedById: 'user_alloc',
    approvedById: 'user_appr',
    dispatchedById: 'user_alloc',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    dispatchedAt: new Date('2026-09-02T00:00:00Z'),
    receivedAt: null,
    lines,
  };
}

function makeDb(options: {
  transfer?: ReturnType<typeof transfer> | null;
  transit?: { onHandUnits: number; sealedPacks: number; looseUnits: number; unitsPerPack: number };
  witness?: { id: string } | null;
}) {
  const current = options.transfer === undefined ? transfer() : options.transfer;
  const transit = options.transit ?? {
    onHandUnits: 30,
    sealedPacks: 3,
    looseUnits: 0,
    unitsPerPack: 10,
  };
  const db = {
    pharmacyInterbranchTransfer: {
      findFirst: vi.fn(async () => current),
      findMany: vi.fn(async () => []),
      update: vi.fn(async ({ data }: { data: object }) => ({ ...current, ...data })),
    },
    pharmacyInterbranchTransferLine: { update: vi.fn(async () => ({})) },
    pharmacyInventoryLot: {
      findFirstOrThrow: vi.fn(async () => ({
        id: 'lot_src',
        manufacturingBatchId: 'batch_1',
        packLevelId: 'pack_1',
        unitsPerPack: transit.unitsPerPack,
        supplierName: 'Distributor',
        supplierInvoiceRef: 'INV-1',
        unitCostMinor: 100,
        printedMrpMinor: 150,
        receivedExpiresAt: new Date('2027-01-01'),
        receivedExpiryPrecision: 'DAY',
        batch: {},
      })),
      create: vi.fn(async () => ({ id: 'lot_dst' })),
    },
    pharmacyStockMovement: {
      create: vi.fn(async ({ data }: { data: object }) => ({ id: 'mv_new', ...data })),
      findMany: vi.fn(async () => []),
    },
    pharmacyCustodyRecord: {
      create: vi.fn(async ({ data }: { data: object }) => ({ id: 'custody_new', ...data })),
    },
    pharmacyStockLocation: { findMany: vi.fn(async () => []) },
    pharmacyBranch: { findMany: vi.fn(async () => []) },
    user: {
      findFirst: vi.fn(async () =>
        options.witness === undefined ? { id: 'user_witness' } : options.witness
      ),
      findMany: vi.fn(async () => []),
    },
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce(current ? [{ id: current.id }] : [])
      .mockResolvedValue([transit]),
  };
  return Object.assign(db, {
    $transaction: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)),
  });
}

let db = makeDb({});
function caller(overrides: { enabledModules?: string[]; userId?: string } = {}) {
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
    session: {
      expires: 'later',
      user: { id: overrides.userId ?? 'user_receiver', role: 'ADMIN', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

const evidence = { reason: 'Carton crushed', witnessId: 'user_witness', evidenceRef: 'SEAL-42' };
const receipt = (receivedUnits: number, extra: object = {}) => ({
  branchId: 'branch_dst',
  transferId: 'tr_1',
  lines: [{ lineId: 'line_1', receivedUnits }],
  idempotencyKeyPrefix: 'ui-receive-close:tr_1',
  ...extra,
});

function movements() {
  return db.pharmacyStockMovement.create.mock.calls.map(
    (call) => (call as unknown as [{ data: Record<string, unknown> }])[0].data
  );
}

beforeEach(() => {
  db = makeDb({});
  mocks.hasModule.mockImplementation((view, key) => view.enabledModules.includes(key));
});

describe('transfer console procedures — entitlement', () => {
  // The module gate keys on the public `pharmacyInventory.` prefix, which only
  // the app router supplies; mapping it is what makes both procedures gated.
  it('inherits the pharmacy-inventory entitlement from the router prefix', () => {
    expect(moduleForProcedure('pharmacyInventory.transferBoard')).toBe('pharmacy-inventory');
    expect(moduleForProcedure('pharmacyInventory.receiveTransferWithVariance')).toBe(
      'pharmacy-inventory'
    );
  });
});

describe('receiveTransferWithVariance', () => {
  it('receives what arrived and writes the shortfall off out of transit at the source', async () => {
    const result = await caller().receiveTransferWithVariance(receipt(20, { variance: evidence }));

    const posted = movements();
    // Receipt legs from the existing INV-07 operation, then exactly one variance.
    expect(posted.map((m) => [m.kind, m.disposition, m.branchId, m.quantityUnits])).toEqual([
      ['TRANSFER_OUT', 'IN_TRANSIT', 'branch_src', -20],
      ['TRANSFER_IN', 'AVAILABLE', 'branch_dst', 20],
      ['WRITE_OFF', 'IN_TRANSIT', 'branch_src', -10],
    ]);
    expect(posted[2]).toMatchObject({
      inventoryLotId: 'lot_src',
      stockLocationId: 'loc_src',
      sealedPackDelta: -1,
      looseUnitDelta: -0,
      actorId: 'user_receiver',
      idempotencyKey: 'transfer-variance:tr_1:line_1',
    });
    expect(db.pharmacyCustodyRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        branchId: 'branch_src',
        movementId: 'mv_new',
        actorId: 'user_receiver',
        witnessId: 'user_witness',
        reason: 'Carton crushed',
        evidenceRef: 'SEAL-42',
      }),
    });
    expect(db.pharmacyInterbranchTransfer.update).toHaveBeenLastCalledWith({
      where: { id: 'tr_1' },
      data: { status: 'RECEIVED', receivedAt: expect.any(Date) },
    });
    expect(result?.variances).toHaveLength(1);
  });

  it('closes a full receipt without a write-off or a witness', async () => {
    await caller().receiveTransferWithVariance(receipt(30));
    expect(movements().map((m) => m.kind)).toEqual(['TRANSFER_OUT', 'TRANSFER_IN']);
    expect(db.pharmacyCustodyRecord.create).not.toHaveBeenCalled();
    expect(db.user.findFirst).not.toHaveBeenCalled();
  });

  it('writes the whole line off when nothing arrived', async () => {
    await caller().receiveTransferWithVariance(receipt(0, { variance: evidence }));
    expect(movements().map((m) => [m.kind, m.quantityUnits])).toEqual([['WRITE_OFF', -30]]);
    expect(db.pharmacyInterbranchTransferLine.update).not.toHaveBeenCalled();
  });

  it.each([
    ['no evidence', undefined, 'user_receiver'],
    [
      'the receiver as their own witness',
      { ...evidence, witnessId: 'user_receiver' },
      'user_receiver',
    ],
  ])('refuses a shortfall with %s', async (_name, variance, userId) => {
    await expect(
      caller({ userId }).receiveTransferWithVariance(receipt(20, variance ? { variance } : {}))
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'COAUTH_REQUIRED' });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('refuses a witness who is not an active member of this organization', async () => {
    db = makeDb({ witness: null });
    await expect(
      caller().receiveTransferWithVariance(receipt(20, { variance: evidence }))
    ).rejects.toMatchObject({ message: 'COAUTH_REQUIRED' });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('refuses more units than are outstanding', async () => {
    await expect(caller().receiveTransferWithVariance(receipt(31))).rejects.toMatchObject({
      message: 'INVALID_UNITS',
    });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('refuses a closing receipt that leaves an open line unanswered', async () => {
    db = makeDb({
      transfer: transfer('DISPATCHED', [line(), line({ id: 'line_2', sourceLotId: 'lot_2' })]),
    });
    await expect(caller().receiveTransferWithVariance(receipt(30))).rejects.toMatchObject({
      message: 'INVALID_UNITS',
    });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('refuses a line id from another transfer', async () => {
    await expect(
      caller().receiveTransferWithVariance({
        ...receipt(30),
        lines: [{ lineId: 'line_elsewhere', receivedUnits: 30 }],
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'CROSS_BRANCH_REFERENCE' });
  });

  it('refuses a transfer not addressed to the receiving branch', async () => {
    db = makeDb({ transfer: null });
    await expect(caller().receiveTransferWithVariance(receipt(30))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'CROSS_BRANCH_REFERENCE',
    });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it.each(['ALLOCATED', 'APPROVED', 'RECEIVED', 'DRAFT'])(
    'refuses to receive a %s transfer',
    async (status) => {
      db = makeDb({ transfer: transfer(status) });
      await expect(caller().receiveTransferWithVariance(receipt(30))).rejects.toMatchObject({
        message: 'INVALID_STATE',
      });
    }
  );

  it('refuses a split transit cannot physically hold, before posting anything', async () => {
    // 3 sealed strips in transit; 25 units would need 5 loose ones.
    await expect(
      caller().receiveTransferWithVariance(receipt(25, { variance: evidence }))
    ).rejects.toMatchObject({ message: 'INVALID_ARRANGEMENT' });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('refuses when transit no longer holds the outstanding units', async () => {
    db = makeDb({ transit: { onHandUnits: 10, sealedPacks: 1, looseUnits: 0, unitsPerPack: 10 } });
    await expect(caller().receiveTransferWithVariance(receipt(10))).rejects.toMatchObject({
      message: 'INSUFFICIENT_STOCK',
    });
  });

  it('takes the payload tenant from the session, never the input', async () => {
    await expect(
      caller().receiveTransferWithVariance({
        ...receipt(30),
        organizationId: 'org_b',
      } as unknown as Parameters<ReturnType<typeof caller>['receiveTransferWithVariance']>[0])
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('transferBoard', () => {
  it('reads both directions for the branch and reports posted variance per line', async () => {
    db.pharmacyInterbranchTransfer.findMany.mockResolvedValueOnce([
      {
        ...transfer('RECEIVED', [line({ receivedUnits: 20 })]),
        lines: [
          {
            ...line({ receivedUnits: 20 }),
            sourceLot: {
              unitsPerPack: 10,
              batch: {
                batchNumber: 'B-7',
                expiresAt: new Date('2027-03-01T00:00:00Z'),
                medicine: { productName: 'Amoxicillin 500mg', brandName: null },
              },
            },
          },
        ],
      },
    ] as never);
    db.pharmacyStockMovement.findMany.mockResolvedValueOnce([
      {
        idempotencyKey: 'transfer-variance:tr_1:line_1',
        quantityUnits: -10,
        reason: 'Transfer tr_1 receipt variance: Carton crushed',
      },
    ] as never);

    const board = await caller().transferBoard({ branchId: 'branch_dst' });

    expect(db.pharmacyInterbranchTransfer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org_a',
          OR: [{ fromBranchId: 'branch_dst' }, { toBranchId: 'branch_dst' }],
        },
      })
    );
    expect(board[0]).toMatchObject({ direction: 'INBOUND', status: 'RECEIVED' });
    expect(board[0]!.lines[0]).toMatchObject({
      medicineName: 'Amoxicillin 500mg',
      batchNumber: 'B-7',
      sealedPacks: 3,
      looseUnits: 0,
      receivedUnits: 20,
      varianceUnits: 10,
    });
  });
});
