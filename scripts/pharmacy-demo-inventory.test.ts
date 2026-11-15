import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '../src/lib/tenancy/scoped-db';
import type { AllocationCandidate } from '../src/lib/pharmacy/inventory';
import {
  executeInventoryDemo,
  planInventoryDemo,
  previewInventoryDemoFefo,
  type InventoryDemoFacts,
  observeInventoryDemoReceipt,
  inventoryDemoReceiptHash,
  planPreparedInventoryReceipt,
  executePreparedInventoryReceipt,
  type InventoryPreparedReceipt,
  type InventoryPreparedReceiptInput,
} from './pharmacy-demo-inventory';
import type {
  PharmacyDemoContext,
  PharmacyDemoPlan,
  PharmacyDemoResult,
} from './pharmacy-demo-contract';

const createOrder = vi.hoisted(() =>
  vi.fn().mockImplementation(async (_db, _scope, input) => ({
    id: 'synthetic-po',
    reference: input.reference,
    status: 'DRAFT',
  }))
);
const access = vi.hoisted(() => vi.fn().mockResolvedValue({ organizationWide: true }));
const receiveLot = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    lot: { id: 'generated-lot' },
    movement: { id: 'generated-accepted' },
    quarantineMovement: { id: 'generated-quarantine' },
  })
);
vi.mock('../src/lib/pharmacy/stock-ledger', async (original) => ({
  ...(await original<typeof import('../src/lib/pharmacy/stock-ledger')>()),
  receiveLot,
}));
vi.mock('../src/lib/pharmacy/central-purchasing', () => ({
  createCentralPurchaseOrder: createOrder,
  purchasingAccess: access,
}));

function facts(): InventoryDemoFacts {
  return {
    organizationId: 'org',
    branchId: 'branch',
    ownerUserId: 'owner',
    actorId: 'purchaser',
    namespace: 'phdemo_0123456789abcdef01234567_',
    businessDate: '2026-09-07',
    scenarioAt: '2026-09-07T10:00:00Z',
    timezone: 'Asia/Karachi',
    currency: 'PKR',
    actors: [
      {
        actorId: 'purchaser',
        userId: 'purchaser',
        organizationId: 'org',
        branchId: 'branch',
        active: true,
        synthetic: true,
        capabilities: [
          'pharmacyPurchasing.createCentralPurchaseOrder',
          'pharmacyPurchasing.postGoodsReceipt',
        ],
      },
    ],
    references: (['medicine', 'presentation', 'pack', 'location', 'supplier'] as const).map(
      (kind) => ({
        kind,
        id: kind,
        organizationId: 'org',
        branchId: 'branch',
        approved: true,
        observedHash: 'a'.repeat(64),
      })
    ),
    modules: [{ key: 'pharmacy-procurement', enabled: true }],
    purchasingEntitled: true,
    organizationPurchaser: true,
    approvedCatalog: {
      medicineId: 'medicine',
      presentationId: 'presentation',
      packLevelId: 'pack',
      stockLocationId: 'location',
      canonicalUnitsPerPack: 10,
    },
    supplier: {
      id: 'supplier',
      authorized: true,
      licences: [{ id: 'licence', verified: true, expiresAt: '2027-01-01T00:00:00Z' }],
    },
    orderedPacks: 3,
    listPricePerPackMinor: 12500,
  };
}

function database(existing: { id: string } | null = null) {
  const findFirst = vi.fn().mockResolvedValue(existing);
  // Deliberately expose only permitted reads; unexpected writes fail the test.
  return {
    tx: {
      pharmacyPurchaseOrder: { findFirst },
      user: { findFirst: vi.fn().mockResolvedValue({ id: 'purchaser', status: 'ACTIVE' }) },
    } as unknown as ScopedDb,
    findFirst,
  };
}

describe('inventory demo plan', () => {
  it('projects supplied pack prices without claiming delivered stock', () => {
    const plan = planInventoryDemo(facts());
    expect(plan.unmet).toEqual([]);
    expect(plan.expected).toEqual({
      status: 'DRAFT',
      canonicalUnits: 30,
      grossMinor: 37500,
      deliveredStock: [],
    });
    expect(plan.gaps).toHaveLength(4);
    expect(plan.input.reference).toBe('phdemo_0123456789abcdef01234567_:inventory:po:v1');
    expect(plan.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(planInventoryDemo(facts()).hash).toBe(plan.hash);
  });
  it.each(['organizationId', 'branchId', 'actorId', 'ownerUserId', 'namespace'] as const)(
    'binds hash to %s',
    (key) => {
      const changed = facts();
      changed[key] += '-different';
      expect(planInventoryDemo(changed).hash).not.toBe(planInventoryDemo(facts()).hash);
    }
  );
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    'rejects invalid/overflowing pack quantity %s',
    (orderedPacks) => {
      expect(planInventoryDemo({ ...facts(), orderedPacks }).unmet).toContain(
        'INVALID_PACK_OR_PRICE_ARITHMETIC'
      );
    }
  );
  it('refuses missing supplier evidence and capabilities', () => {
    const input = facts();
    input.supplier.licences = [];
    input.organizationPurchaser = false;
    expect(planInventoryDemo(input).unmet).toEqual([
      'PURCHASING_CAPABILITY_REQUIRED',
      'APPROVED_SUPPLIER_LICENCE_REQUIRED',
    ]);
  });
  it('refuses unverified and expired licence evidence', () => {
    for (const licence of [
      { id: 'x', verified: false, expiresAt: '2027-01-01' },
      { id: 'x', verified: true, expiresAt: '2020-01-01' },
    ]) {
      const input = facts();
      input.supplier.licences = [licence];
      expect(planInventoryDemo(input).unmet).toContain('APPROVED_SUPPLIER_LICENCE_REQUIRED');
    }
  });
  it('rejects mismatched business date and invalid timezone', () => {
    expect(planInventoryDemo({ ...facts(), businessDate: '2026-09-06' }).unmet).toContain(
      'BUSINESS_DATE_MISMATCH'
    );
    expect(planInventoryDemo({ ...facts(), timezone: 'invalid' }).unmet).toContain(
      'INVALID_TIME_CONTEXT'
    );
  });
});

describe('inventory demo canonical namespace compatibility', () => {
  it('preserves root namespace in dependencies and business reference', () => {
    const input = facts();
    const before = JSON.stringify(input);
    const plan = planInventoryDemo(input);
    expect(plan.unmet).toEqual([]);
    expect(plan.dependencies.namespace).toBe(input.namespace);
    expect(plan.input.reference).toBe(`${input.namespace}:inventory:po:v1`);
    expect(plan.input).not.toHaveProperty('id');
    expect(plan.expected.deliveredStock).toEqual([]);
    expect(JSON.stringify(input)).toBe(before);
    expect(planInventoryDemo(input).hash).toBe(plan.hash);
  });

  it('binds a second valid root namespace to a distinct hash and reference', () => {
    const first = planInventoryDemo(facts());
    const namespace = 'phdemo_abcdef0123456789abcdef01_';
    const second = planInventoryDemo({ ...facts(), namespace });
    expect(second.unmet).toEqual([]);
    expect(second.dependencies.namespace).toBe(namespace);
    expect(second.input.reference).toBe(`${namespace}:inventory:po:v1`);
    expect(second.hash).not.toBe(first.hash);
    expect(second.input.reference).not.toBe(first.input.reference);
  });

  it.each([
    'demo:unit-test',
    'phdemo_0123456789ABCDEF01234567_',
    'phdemo_0123456789abcdef0123456_',
    'phdemo_0123456789abcdef012345678_',
    'phdemo_0123456789abcdef01234567',
    'phdemo_0123456789abcdef01234567_:inventory',
    ' phdemo_0123456789abcdef01234567_',
  ])('refuses noncanonical namespace %s without normalizing it', (namespace) => {
    const plan = planInventoryDemo({ ...facts(), namespace });
    expect(plan.unmet).toEqual(['INVALID_NAMESPACE']);
    expect(plan.dependencies.namespace).toBe(namespace);
  });
});

describe('inventory demo execution boundary', () => {
  it('calls owning domain service with exact draft and caller transaction', async () => {
    createOrder.mockClear();
    const { tx } = database();
    const input = facts();
    const plan = planInventoryDemo(input);
    const result = await executeInventoryDemo(tx, input, { state: 'new', hash: plan.hash });
    expect(createOrder).toHaveBeenCalledExactlyOnceWith(
      tx,
      { organizationId: 'org', actorId: 'purchaser' },
      plan.input
    );
    expect(result.status).toBe('applied');
    expect(result).toMatchObject({ records: [{ persistedId: 'synthetic-po' }] });
  });
  it('preserves reconciled operator changes without reading or writing domain rows', async () => {
    createOrder.mockClear();
    const { tx, findFirst } = database();
    const input = facts();
    const result = await executeInventoryDemo(tx, input, {
      state: 'preserve',
      hash: planInventoryDemo(input).hash,
      records: [
        {
          planKey: planInventoryDemo(input).records[0]!.key,
          model: 'PharmacyPurchaseOrder',
          persistedId: 'retained',
          receiptReference: planInventoryDemo(input).input.reference,
          observedHash: 'b'.repeat(64),
          observedFacts: { status: 'DRAFT' },
        },
      ],
    });
    expect(result.status).toBe('replayed');
    expect(findFirst).not.toHaveBeenCalled();
    expect(createOrder).not.toHaveBeenCalled();
  });
  it('refuses tombstones, changed target/hash, collisions and unmet facts without writes', async () => {
    createOrder.mockClear();
    const input = facts();
    const plan = planInventoryDemo(input);
    const { tx } = database({ id: 'legitimate' });
    for (const reconciliation of [
      { state: 'refuse', reason: 'TOMBSTONE' } as const,
      { state: 'new', hash: 'wrong' } as const,
      { state: 'new', hash: plan.hash } as const,
    ]) {
      expect((await executeInventoryDemo(tx, input, reconciliation)).status).toBe('refused');
    }
    expect(
      (
        await executeInventoryDemo(
          tx,
          { ...input, purchasingEntitled: false },
          { state: 'new', hash: plan.hash }
        )
      ).status
    ).toBe('refused');
    expect(createOrder).not.toHaveBeenCalled();
  });
  it('propagates service refusal so root can roll back its transaction', async () => {
    createOrder.mockRejectedValueOnce(new Error('FORBIDDEN'));
    const input = facts();
    const { tx } = database();
    await expect(
      executeInventoryDemo(tx, input, { state: 'new', hash: planInventoryDemo(input).hash })
    ).rejects.toThrow('FORBIDDEN');
  });
});

describe('observed lot preview only', () => {
  const lot = (
    id: string,
    expiresAt: string,
    changes: Partial<AllocationCandidate> = {}
  ): AllocationCandidate => ({
    inventoryLotId: id,
    stockLocationId: 'location',
    organizationId: 'org',
    branchId: 'branch',
    batchState: 'ACTIVE',
    disposition: 'AVAILABLE',
    expiresAt: new Date(expiresAt),
    receivedAt: new Date('2026-09-01'),
    availableUnits: 10,
    ...changes,
  });
  const preview = (candidates: AllocationCandidate[]) =>
    previewInventoryDemoFefo({
      organizationId: 'org',
      branchId: 'branch',
      scenarioAt: '2026-09-07T10:00:00Z',
      requiredUnits: 5,
      candidates,
    });
  it('selects FEFO, reports expired/quarantined/recalled/cross-branch lots, preserves facts', () => {
    const candidates = [
      lot('later', '2027-01-01'),
      lot('first', '2026-10-01'),
      lot('expired', '2026-09-07T10:00:00Z'),
      lot('quarantine', '2026-10-01', { disposition: 'QUARANTINE' }),
      lot('recall', '2026-10-01', { batchState: 'RECALLED' }),
      lot('other-branch', '2026-10-01', { branchId: 'other' }),
    ];
    const before = JSON.stringify(candidates);
    const result = preview(candidates);
    expect(result.recommendedLotId).toBe('first');
    expect(result.allocations).toEqual([
      { inventoryLotId: 'first', stockLocationId: 'location', units: 5 },
    ]);
    expect(result.blocked.map((item) => item.reason)).toEqual([
      'EXPIRED',
      'QUARANTINED',
      'RECALLED',
      'UNAUTHORIZED',
    ]);
    expect(JSON.stringify(candidates)).toBe(before);
  });
  it('refuses unavailable stock, invalid expiry and unbounded input', () => {
    expect(() => preview([lot('expired', '2020-01-01')])).toThrow('INSUFFICIENT_STOCK');
    expect(() => preview([lot('invalid', 'invalid')])).toThrow('INVALID_OR_UNBOUNDED_LOT_FACTS');
    expect(() => preview(Array.from({ length: 33 }, (_, i) => lot(`${i}`, '2027-01-01')))).toThrow(
      'INVALID_OR_UNBOUNDED_LOT_FACTS'
    );
  });
});

describe('shared inventory contract and prepared receiving composition', () => {
  function prepared() {
    const input = facts();
    const at = new Date(input.scenarioAt);
    const line = {
      id: 'prepared-line',
      organizationId: 'org',
      branchId: 'branch',
      goodsReceiptId: 'prepared-receipt',
      lineNumber: 1,
      purchaseOrderLineId: 'approved-order-line',
      medicineId: 'medicine',
      packLevelId: 'pack',
      batchNumber: `${input.namespace}batch1`,
      printedExpiry: new Date('2027-01-01'),
      expiryPrecision: 'DAY',
      printedMrpMinor: 20000,
      canonicalUnitsPerPack: 10,
      receivedPacks: 2,
      bonusPacks: 1,
      receivedCanonicalUnits: 20,
      bonusCanonicalUnits: 10,
      acceptedCanonicalUnits: 28,
      rejectedCanonicalUnits: 2,
      rejectionReason: 'Synthetic damaged-pack test',
      invoicedPricePerPackMinor: 15000,
      discountBps: 0,
      taxBps: 0,
      taxCreditable: false,
      unitCostMinor: 1000,
      stockLocationId: 'location',
      quarantineLocationId: 'quarantine',
      inventoryLotId: null,
      ocrFieldEvidence: null,
      ocrRegulatedConfirmedAt: null,
      ocrRegulatedConfirmedById: null,
      purchaseOrderLine: {
        id: 'approved-order-line',
        purchaseOrderId: 'approved-order',
        medicineId: 'medicine',
        packLevelId: 'pack',
        canonicalUnitsPerPack: 10,
        orderedCanonicalUnits: 40,
        bonusCanonicalUnits: 0,
        listPricePerPackMinor: 15000,
      },
    };
    // Intentionally partial DB mock, never executed SQL or real regulatory observations.
    const receipt = {
      id: 'prepared-receipt',
      organizationId: 'org',
      branchId: 'branch',
      reference: `${input.namespace}gr1`,
      status: 'DRAFT',
      directPurchase: false,
      supplierId: 'supplier',
      purchaseOrderId: 'approved-order',
      supplierInvoiceRef: `${input.namespace}test-invoice`,
      warrantyEvidenceRef: 'disposable-only-test-evidence',
      receivedAt: at,
      supplier: {
        id: 'supplier',
        name: 'Synthetic test supplier',
        authorized: true,
        licences: [{ id: 'licence', verifiedAt: at, expiresAt: new Date('2027-01-01') }],
      },
      purchaseOrder: {
        id: 'approved-order',
        organizationId: 'org',
        branchId: 'branch',
        supplierId: 'supplier',
        reference: `${input.namespace}approved-po`,
        status: 'SENT',
        freightMinor: 0,
        otherChargesMinor: 0,
        approvedAt: at,
        approvedByUserId: 'test-approver',
        createdByUserId: 'test-creator',
        requisition: null,
        approvals: [
          {
            decision: 'APPROVED',
            actorUserId: 'test-approver',
            policy: 'PUR-02:SEGREGATION_OF_DUTIES',
            toStatus: 'APPROVED',
          },
        ],
      },
      lines: [line],
    } as unknown as InventoryPreparedReceipt;
    input.references.push({
      kind: 'location',
      id: 'quarantine',
      organizationId: 'org',
      branchId: 'branch',
      approved: true,
      observedHash: 'a'.repeat(64),
    });
    const expectation = (): InventoryPreparedReceiptInput => ({
      goodsReceiptId: receipt.id,
      reference: receipt.reference,
      snapshotHash: inventoryDemoReceiptHash(receipt),
      operatorConfirmationReference: 'root-retained-disposable-operator-confirmation',
      acceptedUnits: 28,
      rejectedUnits: 2,
      unitCostMinor: 1000,
    });
    const updateReceipt = vi.fn().mockResolvedValue({});
    const updateLine = vi.fn().mockResolvedValue({});
    const batchCreate = vi
      .fn()
      .mockResolvedValue({ id: 'generated-batch', expiresAt: new Date('2027-01-02') });
    const exceptionCreate = vi
      .fn()
      .mockImplementation(async ({ data }) => ({ ...data, id: `generated-${data.kind}` }));
    const receiptRead = vi.fn().mockResolvedValue(receipt);
    const actorRead = vi.fn().mockResolvedValue({ id: 'purchaser', status: 'ACTIVE' });
    const batchRead = vi.fn().mockResolvedValue(null);
    // The order line's costing terms, as the receipt was drafted against them.
    const orderLine = {
      id: 'approved-order-line',
      medicineId: 'medicine',
      packLevelId: 'pack',
      orderedPacks: 4,
      bonusPacks: 0,
      canonicalUnitsPerPack: 10,
      listPricePerPackMinor: 15000,
      discountBps: 0,
      rebateBps: 0,
      taxBps: 0,
      taxCreditable: false,
    };
    const orderLinesRead = vi.fn().mockImplementation(async () => [orderLine]);
    const tx = {
      user: { findFirst: actorRead },
      pharmacyGoodsReceipt: { findFirst: receiptRead, update: updateReceipt },
      pharmacyGoodsReceiptLine: { update: updateLine, findMany: vi.fn().mockResolvedValue([]) },
      pharmacyManufacturingBatch: { findFirst: batchRead, create: batchCreate },
      pharmacyPurchaseOrderLine: {
        findFirst: vi.fn().mockResolvedValue(line.purchaseOrderLine),
        findMany: orderLinesRead,
      },
      pharmacyPurchaseOrder: {
        findFirst: vi.fn().mockResolvedValue(receipt.purchaseOrder),
        update: vi.fn().mockResolvedValue({}),
      },
      pharmacyReceivingException: { create: exceptionCreate },
    } as unknown as ScopedDb;
    const execute = (requested = expectation()) =>
      executePreparedInventoryReceipt(tx, input, requested, {
        state: 'new',
        hash: planPreparedInventoryReceipt(input, requested).digest,
      });
    receiveLot.mockClear();
    access.mockClear();
    access.mockResolvedValue({ organizationWide: true });
    return {
      input,
      receipt,
      orderLine,
      expectation,
      tx,
      execute,
      actorRead,
      receiptRead,
      batchRead,
      updateReceipt,
      updateLine,
      batchCreate,
      exceptionCreate,
    };
  }

  it('binds shared context/plan/result while observing a service-generated PO id', async () => {
    const input = facts();
    const context: PharmacyDemoContext = input;
    const plan: PharmacyDemoPlan = planInventoryDemo(input);
    const result: PharmacyDemoResult = await executeInventoryDemo(database().tx, input, {
      state: 'new',
      hash: plan.digest,
    });
    expect(plan.namespace).toBe(context.namespace);
    expect(plan.records[0]).not.toHaveProperty('id');
    expect(result).toMatchObject({
      status: 'applied',
      records: [
        {
          persistedId: 'synthetic-po',
          receiptReference: plan.records[0]!.reference,
          observedFacts: { status: 'DRAFT' },
        },
      ],
    });
  });

  it('binds observed reference hashes and refuses missing shared context observations', () => {
    const input = facts();
    const original = planInventoryDemo(input);
    input.references[0]!.observedHash = 'b'.repeat(64);
    expect(planInventoryDemo(input).digest).not.toBe(original.digest);
    input.actors = [];
    input.references = [];
    input.modules = [];
    expect(planInventoryDemo(input).unmet).toEqual(
      expect.arrayContaining([
        'OBSERVED_SERVICE_ACTOR_REQUIRED',
        'OBSERVED_APPROVED_REFERENCES_REQUIRED',
        'OBSERVED_PROCUREMENT_ENTITLEMENT_REQUIRED',
      ])
    );
  });

  it('uses the real receipt service for bonus/quarantine stock and OPEN match exceptions', async () => {
    const p = prepared();
    const observed = await observeInventoryDemoReceipt(p.tx, p.input, p.receipt.id);
    expect(observed).toBe(p.receipt);
    const result = await p.execute();
    expect(result).toMatchObject({
      status: 'applied',
      records: [
        {
          persistedId: 'prepared-receipt',
          observedFacts: {
            inventoryLotId: 'generated-lot',
            acceptedMovementId: 'generated-accepted',
            quarantineMovementId: 'generated-quarantine',
            acceptedUnits: 28,
            rejectedUnits: 2,
            unitCostMinor: 1000,
            inventoryValueMinor: 30000,
          },
        },
      ],
    });
    expect(receiveLot).toHaveBeenCalledExactlyOnceWith(
      p.tx,
      { organizationId: 'org', branchId: 'branch', actorId: 'purchaser' },
      expect.objectContaining({
        quantityUnits: 28,
        unitsPerPack: 10,
        unitCostMinor: 1000,
        quarantine: expect.objectContaining({ units: 2, stockLocationId: 'quarantine' }),
      })
    );
    expect(p.updateLine).toHaveBeenCalledWith({
      where: { id: 'prepared-line' },
      data: { inventoryLotId: 'generated-lot' },
    });
    expect(p.updateReceipt).toHaveBeenCalledWith({
      where: { id: 'prepared-receipt' },
      data: { status: 'POSTED', postedAt: new Date(p.input.scenarioAt) },
    });
    expect(p.exceptionCreate).toHaveBeenCalled();
    expect(result.status === 'applied' && result.records[0]!.observedFacts.exceptionIds).toContain(
      'generated-SHORT'
    );
  });

  it('re-derives the stamped landed cost from the order rebate and freight share', async () => {
    const p = prepared();
    p.receipt.purchaseOrder!.freightMinor = 1200;
    p.orderLine.rebateBps = 1000;
    // 30_000 invoiced − 10% rebate = 27_000, plus half the 1_200 freight for 20
    // of the 40 ordered paid units = 27_600 over 30 units.
    p.receipt.lines[0]!.unitCostMinor = 920;
    // The batch guard runs right after the cost check, so reaching it proves
    // the landed cost was accepted without posting anything.
    p.batchRead.mockResolvedValue({ id: 'existing-batch' });
    expect(await p.execute({ ...p.expectation(), unitCostMinor: 920 })).toMatchObject({
      status: 'refused',
      unmetPrerequisites: ['UNRECONCILED_BATCH_COLLISION'],
    });
    expect(receiveLot).not.toHaveBeenCalled();
  });

  it('refuses a prepared cost that leaves out the order rebate and freight', async () => {
    const p = prepared();
    p.receipt.purchaseOrder!.freightMinor = 1200;
    p.orderLine.rebateBps = 1000;
    // The invoice-only 1_000 is no longer the landed cost of this line.
    expect(await p.execute()).toMatchObject({
      status: 'refused',
      unmetPrerequisites: ['RECEIPT_QUANTITY_OR_COST_MISMATCH'],
    });
    expect(receiveLot).not.toHaveBeenCalled();
  });

  it.each(['status', 'approval', 'expiry', 'quantity', 'cost', 'scope', 'batch'])(
    'refuses unsafe prepared %s before any service writes',
    async (change) => {
      const p = prepared();
      if (change === 'status') p.receipt.status = 'POSTED';
      if (change === 'approval') p.receipt.purchaseOrder!.approvals = [];
      if (change === 'expiry') p.receipt.lines[0]!.printedExpiry = new Date('2020-01-01');
      if (change === 'quantity') p.receipt.lines[0]!.acceptedCanonicalUnits++;
      if (change === 'cost') p.receipt.lines[0]!.unitCostMinor++;
      if (change === 'scope') p.receipt.branchId = 'other-branch';
      if (change === 'batch') p.receipt.lines[0]!.batchNumber = 'legitimate-batch';
      expect((await p.execute()).status).toBe('refused');
      expect(p.batchCreate).not.toHaveBeenCalled();
      expect(receiveLot).not.toHaveBeenCalled();
    }
  );

  it('refuses post-confirmation changes and pre-existing batch collisions', async () => {
    const p = prepared();
    const confirmed = p.expectation();
    p.receipt.warrantyEvidenceRef = 'operator-changed';
    expect(await p.execute(confirmed)).toMatchObject({
      status: 'refused',
      unmetPrerequisites: ['PREPARED_RECEIPT_CHANGED_OR_MISSING'],
    });
    p.batchRead.mockResolvedValue({ id: 'existing-batch' });
    expect(await p.execute()).toMatchObject({
      status: 'refused',
      unmetPrerequisites: ['UNRECONCILED_BATCH_COLLISION'],
    });
    expect(receiveLot).not.toHaveBeenCalled();
  });

  it('refuses inactive actors, absent action observations and missing actual purchasing access', async () => {
    const p = prepared();
    p.actorRead.mockResolvedValue({ id: 'purchaser', status: 'INACTIVE' });
    expect((await p.execute()).status).toBe('refused');
    p.actorRead.mockResolvedValue({ id: 'purchaser', status: 'ACTIVE' });
    access.mockResolvedValue({ organizationWide: false });
    expect((await p.execute()).status).toBe('refused');
    p.input.actors[0]!.capabilities = [];
    expect((await p.execute()).status).toBe('refused');
    expect(receiveLot).not.toHaveBeenCalled();
  });

  it('preserves retained generated IDs without domain reads/writes; refuses wrong target and tombstone', async () => {
    const p = prepared();
    const input = p.expectation();
    const plan = planPreparedInventoryReceipt(p.input, input);
    const result = await p.execute(input);
    expect(result.status).toBe('applied');
    if (result.status === 'refused') throw new Error('Expected applied fixture');
    p.receiptRead.mockClear();
    receiveLot.mockClear();
    const replay = await executePreparedInventoryReceipt(p.tx, p.input, input, {
      state: 'preserve',
      hash: plan.digest,
      records: result.records,
    });
    expect(replay).toMatchObject({ status: 'replayed', records: result.records });
    for (const reconciliation of [
      { state: 'refuse', reason: 'TOMBSTONE' } as const,
      { state: 'new', hash: 'other-target' } as const,
    ])
      expect(
        (await executePreparedInventoryReceipt(p.tx, p.input, input, reconciliation)).status
      ).toBe('refused');
    expect(p.receiptRead).not.toHaveBeenCalled();
    expect(receiveLot).not.toHaveBeenCalled();
  });

  it.each(['warranty', 'licence', 'regulated-confirmation'])(
    'propagates the real receiving service %s refusal for caller rollback',
    async (missing) => {
      const p = prepared();
      if (missing === 'warranty') p.receipt.warrantyEvidenceRef = '';
      if (missing === 'licence') p.receipt.supplier.licences = [];
      if (missing === 'regulated-confirmation')
        p.receipt.lines[0]!.ocrFieldEvidence = { syntheticProposal: true };
      await expect(p.execute()).rejects.toThrow();
      expect(receiveLot).not.toHaveBeenCalled();
      expect(p.updateReceipt).not.toHaveBeenCalled();
    }
  );

  it('propagates a ledger failure for rollback and never stamps the receipt POSTED', async () => {
    const p = prepared();
    receiveLot.mockRejectedValueOnce(new Error('LEDGER_CONSTRAINT'));
    await expect(p.execute()).rejects.toThrow('LEDGER_CONSTRAINT');
    expect(p.updateReceipt).not.toHaveBeenCalled();
  });

  it('refuses absent operator confirmation and mismatched retained records without reads', async () => {
    const p = prepared();
    const input = p.expectation();
    expect((await p.execute({ ...input, operatorConfirmationReference: '' })).status).toBe(
      'refused'
    );
    const result = await executePreparedInventoryReceipt(p.tx, p.input, input, {
      state: 'preserve',
      hash: planPreparedInventoryReceipt(p.input, input).digest,
      records: [],
    });
    expect(result).toMatchObject({
      status: 'refused',
      unmetPrerequisites: ['MISSING_OR_MISMATCHED_RETAINED_RECORDS'],
    });
    expect(p.receiptRead).not.toHaveBeenCalled();
    expect(receiveLot).not.toHaveBeenCalled();
  });

  it('refuses a draft mutation by an inactive actor even with supplied capability observations', async () => {
    const input = facts();
    const tx = database().tx;
    vi.mocked(tx.user.findFirst).mockResolvedValueOnce(null);
    createOrder.mockClear();
    expect(
      await executeInventoryDemo(tx, input, { state: 'new', hash: planInventoryDemo(input).digest })
    ).toMatchObject({ status: 'refused', unmetPrerequisites: ['ACTIVE_SERVICE_ACTOR_REQUIRED'] });
    expect(createOrder).not.toHaveBeenCalled();
  });
});
