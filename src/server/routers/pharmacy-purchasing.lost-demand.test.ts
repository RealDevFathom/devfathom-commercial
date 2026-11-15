import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-80 — lost-demand advice actions end to end through the real ABAC engine:
// every action creates a DRAFT only, records what the human did, takes its
// quantity from the server's own advice and never approves or sends anything.

const mocks = vi.hoisted(() => ({
  readLostDemandAdvice: vi.fn(),
  loadStockCandidatesForRead: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(() => ({})),
  withTenantDb: vi.fn(async (_org: string, run: (tx: unknown) => unknown) => run(db)),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/lost-demand-advice-reader', async (original) => ({
  ...(await original<object>()),
  readLostDemandAdvice: mocks.readLostDemandAdvice,
}));

vi.mock('@/lib/pharmacy/stock-ledger', async (original) => ({
  ...(await original<object>()),
  loadStockCandidatesForRead: mocks.loadStockCandidatesForRead,
}));

import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { DEFAULT_LOST_DEMAND_TRIGGERS } from '@/lib/pharmacy/lost-demand-advice';
import { pharmacyPurchasingRouter } from './pharmacy-purchasing';
import type { TRPCContext } from '../trpc';

const FUTURE = new Date('2030-01-01T00:00:00.000Z');
const PAST = new Date('2020-01-01T00:00:00.000Z');
const template = (key: string) =>
  PHARMACY_ROLE_TEMPLATES.find((role) => role.key === key)!.capabilities;

const PEOPLE: Record<string, readonly string[]> = {
  buyer: template('procurement'),
  manager: template('manager'),
  cashier: template('cashier'),
};

function model() {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    aggregate: vi.fn().mockResolvedValue({ _sum: {} }),
    create: vi
      .fn()
      .mockImplementation(async ({ data }: { data: object }) => ({ id: 'created', ...data })),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn().mockImplementation(async ({ create }: { create: object }) => create),
  };
}
type Model = ReturnType<typeof model>;
let models: Map<string, Model>;
let db: Record<string, unknown> & { $transaction: ReturnType<typeof vi.fn> };

function makeDb() {
  models = new Map();
  const base: Record<string, unknown> = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(0),
  };
  const proxy = new Proxy(base, {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      if (key in target) return target[key];
      if (key === 'then' || key.startsWith('$')) return undefined;
      if (!models.has(key)) models.set(key, model());
      return models.get(key);
    },
  });
  base.$transaction = vi.fn(async (work: unknown) =>
    typeof work === 'function' ? (work as (tx: unknown) => unknown)(proxy) : Promise.all(work as [])
  );
  return proxy as typeof db;
}
const m = (name: string) => (db as unknown as Record<string, Model>)[name]!;

function caller(userId: string) {
  return pharmacyPurchasingRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules: ['pharmacy-procurement'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: { id: userId, role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org_a' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

function advice(overrides: Record<string, unknown> = {}) {
  return {
    demandKey: 'sku:medicine_a',
    label: 'Brand A',
    medicineId: 'medicine_a',
    actions: ['DRAFT_PURCHASE_ORDER', 'TRANSFER_REQUEST', 'IGNORE'],
    transfer: {
      fromBranchId: 'branch_b',
      fromBranchName: 'South',
      surplusUnits: 40,
      quantityUnits: 25,
    },
    draftOnly: true,
    ...overrides,
  };
}

function withAdvice(...rows: ReturnType<typeof advice>[]) {
  mocks.readLostDemandAdvice.mockResolvedValue({
    config: DEFAULT_LOST_DEMAND_TRIGGERS,
    currency: 'PKR',
    advice: rows,
  });
}

beforeEach(() => {
  db = makeDb();
  mocks.readLostDemandAdvice.mockReset();
  mocks.loadStockCandidatesForRead.mockReset();
  m('user').findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const grants = PEOPLE[where.id];
    return grants
      ? {
          id: where.id,
          role: 'EMPLOYEE',
          status: 'ACTIVE',
          organizationId: 'org_a',
          organizationRole: {
            key: 'role',
            permissions: grants.map((capability) => ({ capability, effect: 'ALLOW' })),
          },
          permissionOverrides: [],
        }
      : null;
  });
  m('user').findMany.mockResolvedValue([]);
  m('pharmacyBranch').findFirst.mockResolvedValue({
    id: 'branch_a',
    defaultStockLocationId: 'loc_a',
  });
  m('pharmacyBranchAssignment').findFirst.mockResolvedValue({ id: 'asg' });
  m('pharmacyBranchAssignment').findMany.mockResolvedValue([{ branchId: 'branch_a' }]);
  m('pharmacySupplier').findFirst.mockResolvedValue({
    id: 'supplier_a',
    name: 'Alpha Distributors',
    authorized: true,
    active: true,
    licences: [{ expiresAt: FUTURE, verifiedAt: PAST }],
  });
  m('medicine').findFirst.mockResolvedValue({ id: 'medicine_a', coldChain: false });
  m('packLevel').findFirst.mockResolvedValue({ id: 'pack_a' });
  m('pharmacyStockLocation').findFirst.mockResolvedValue({ id: 'loc_a' });
});

const ORDER = {
  reference: 'PO-LD-1',
  supplierId: 'supplier_a',
  branchId: 'branch_a',
  lostDemandKey: 'sku:medicine_a',
  lines: [
    {
      medicineId: 'medicine_a',
      packLevelId: 'pack_a',
      orderedPacks: 9,
      bonusPacks: 0,
      canonicalUnitsPerPack: 10,
      listPricePerPackMinor: 50_000,
    },
  ],
};

describe('Draft PO from lost-demand advice', () => {
  it('creates the order as a DRAFT and records the advice it answers', async () => {
    withAdvice(advice());
    const created = await caller('buyer').createPurchaseOrder(ORDER);
    const data = m('pharmacyPurchaseOrder').create.mock.calls[0]![0].data;
    // No status, approval or send on the write: the table default is DRAFT.
    expect(data).not.toHaveProperty('status');
    expect(data).not.toHaveProperty('approvedByUserId');
    expect(data).not.toHaveProperty('sentAt');
    expect(data).not.toHaveProperty('lostDemandKey');
    expect(created).toMatchObject({ createdByUserId: 'buyer' });
    expect(m('pharmacyLostDemandAdviceDecision').create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        branchId: 'branch_a',
        demandKey: 'sku:medicine_a',
        decision: 'DRAFT_PURCHASE_ORDER',
        purchaseOrderId: 'created',
        actorUserId: 'buyer',
      }),
    });
    expect(m('pharmacyPurchaseOrder').update).not.toHaveBeenCalled();
    expect(m('pharmacyPurchaseOrderApproval').create).not.toHaveBeenCalled();
  });

  it('refuses an order for a different item than the advice', async () => {
    withAdvice(advice());
    await expect(
      caller('buyer').createPurchaseOrder({
        ...ORDER,
        lines: [{ ...ORDER.lines[0]!, medicineId: 'medicine_other' }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'LOST_DEMAND_MISMATCH' });
    expect(m('pharmacyLostDemandAdviceDecision').create).not.toHaveBeenCalled();
  });

  it('refuses when the server no longer has that advice', async () => {
    withAdvice();
    await expect(caller('buyer').createPurchaseOrder(ORDER)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('needs a branch to tie the advice to', async () => {
    withAdvice(advice());
    await expect(
      caller('buyer').createPurchaseOrder({ ...ORDER, branchId: undefined })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'LOST_DEMAND_NEEDS_BRANCH' });
  });

  it('is refused to a cashier before anything is read', async () => {
    await expect(caller('cashier').createPurchaseOrder(ORDER)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.readLostDemandAdvice).not.toHaveBeenCalled();
  });
});

describe('Transfer request from lost-demand advice', () => {
  const candidate = (lot: string, units: number, overrides: object = {}) => ({
    inventoryLotId: lot,
    stockLocationId: 'src_loc',
    organizationId: 'org_a',
    branchId: 'branch_b',
    batchState: 'ACTIVE',
    disposition: 'AVAILABLE',
    expiresAt: new Date('2029-01-01'),
    receivedAt: PAST,
    availableUnits: units,
    ...overrides,
  });
  /** The ledger returns FEFO order; lots map to batches by id. */
  const ledger = (...rows: ReturnType<typeof candidate>[]) => {
    mocks.loadStockCandidatesForRead.mockResolvedValue(rows);
    m('pharmacyInventoryLot').findMany.mockResolvedValue(
      rows.map((row) => ({
        id: row.inventoryLotId,
        manufacturingBatchId: `batch_${row.inventoryLotId}`,
      }))
    );
    m('pharmacyStockLocation').findMany.mockResolvedValue([{ id: 'src_loc' }]);
  };

  it('creates a DRAFT transfer for the server-advised quantity, first expiry first', async () => {
    withAdvice(advice());
    ledger(
      // Expired and quarantined stock is never requested.
      candidate('lot_expired', 50, { expiresAt: new Date('2020-01-01') }),
      candidate('lot_quarantine', 50, { disposition: 'QUARANTINE' }),
      // Net of reservations: only 10 of this lot are free.
      candidate('lot_early', 10, { expiresAt: new Date('2028-01-01') }),
      candidate('lot_late', 100)
    );
    const result = await caller('buyer').requestLostDemandTransfer({
      branchId: 'branch_a',
      demandKey: 'sku:medicine_a',
      fromBranchId: 'branch_b',
    });
    expect(m('pharmacyInterbranchTransfer').create.mock.calls[0]![0].data).toMatchObject({
      fromBranchId: 'branch_b',
      toBranchId: 'branch_a',
      status: 'DRAFT',
      allocatedById: 'buyer',
    });
    expect(result.lines).toEqual([
      expect.objectContaining({ sourceLotId: 'lot_early', quantityUnits: 10 }),
      expect.objectContaining({ sourceLotId: 'lot_late', quantityUnits: 15 }),
    ]);
    expect(m('pharmacyLostDemandAdviceDecision').create).toHaveBeenCalledWith({
      data: expect.objectContaining({ decision: 'TRANSFER_REQUEST', transferId: 'created' }),
    });
    // A request holds no stock: no movement, no approval, no dispatch.
    expect(m('pharmacyStockMovement').create).not.toHaveBeenCalled();
    expect(m('pharmacyInterbranchTransfer').update).not.toHaveBeenCalled();
  });

  it('skips a recalled batch and refuses a recalled item', async () => {
    withAdvice(advice());
    ledger(candidate('lot_a', 50), candidate('lot_b', 50));
    m('pharmacyRecallNotice').findMany.mockResolvedValue([
      { medicineId: null, batchId: 'batch_lot_a' },
    ]);
    const result = await caller('buyer').requestLostDemandTransfer({
      branchId: 'branch_a',
      demandKey: 'sku:medicine_a',
      fromBranchId: 'branch_b',
    });
    expect(result.lines.map((line) => line.sourceLotId)).toEqual(['lot_b']);

    m('pharmacyRecallNotice').findMany.mockResolvedValue([
      { medicineId: 'medicine_a', batchId: null },
    ]);
    await expect(
      caller('buyer').requestLostDemandTransfer({
        branchId: 'branch_a',
        demandKey: 'sku:medicine_a',
        fromBranchId: 'branch_b',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'LOST_DEMAND_RECALLED' });
  });

  it('refuses a donor branch the advice did not name', async () => {
    withAdvice(advice());
    await expect(
      caller('buyer').requestLostDemandTransfer({
        branchId: 'branch_a',
        demandKey: 'sku:medicine_a',
        fromBranchId: 'branch_c',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'LOST_DEMAND_NO_TRANSFER' });
    expect(m('pharmacyInterbranchTransfer').create).not.toHaveBeenCalled();
  });
});

describe('Ignore and per-branch settings', () => {
  it('records Ignore without touching any document', async () => {
    await caller('buyer').ignoreLostDemandAdvice({
      branchId: 'branch_a',
      demandKey: 'sku:medicine_a',
      reason: 'Discontinued locally',
    });
    expect(m('pharmacyLostDemandAdviceDecision').create).toHaveBeenCalledWith({
      data: expect.objectContaining({ decision: 'IGNORED', reason: 'Discontinued locally' }),
    });
    expect(m('pharmacyPurchaseOrder').create).not.toHaveBeenCalled();
    expect(m('pharmacyInterbranchTransfer').create).not.toHaveBeenCalled();
  });

  it('lets a manager change thresholds but not a buyer', async () => {
    const settings = { ...DEFAULT_LOST_DEMAND_TRIGGERS, requestCountThreshold: 5 };
    await caller('manager').setLostDemandTriggerSettings({ branchId: 'branch_a', settings });
    expect(m('pharmacyLostDemandTriggerSetting').upsert.mock.calls[0]![0]).toMatchObject({
      create: { branchId: 'branch_a', requestCountThreshold: 5, updatedByUserId: 'manager' },
      update: { requestCountThreshold: 5, updatedByUserId: 'manager' },
    });
    await expect(
      caller('buyer').setLostDemandTriggerSettings({ branchId: 'branch_a', settings })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses out-of-range thresholds on the server', async () => {
    await expect(
      caller('manager').setLostDemandTriggerSettings({
        branchId: 'branch_a',
        settings: { ...DEFAULT_LOST_DEMAND_TRIGGERS, requestCountThreshold: 0 },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('reads the stored settings with defaults filled in', async () => {
    m('pharmacyLostDemandTriggerSetting').findFirst.mockResolvedValue({ safetyStockDays: 2 });
    await expect(
      caller('buyer').lostDemandTriggerSettings({ branchId: 'branch_a' })
    ).resolves.toEqual({ ...DEFAULT_LOST_DEMAND_TRIGGERS, safetyStockDays: 2 });
  });
});
