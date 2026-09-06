import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '../src/lib/tenancy/scoped-db';
import type { AllocationCandidate } from '../src/lib/pharmacy/inventory';
import {
  executeInventoryDemo,
  planInventoryDemo,
  previewInventoryDemoFefo,
  type InventoryDemoFacts,
} from './pharmacy-demo-inventory';

const createOrder = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'synthetic-po' }));
vi.mock('../src/lib/pharmacy/central-purchasing', () => ({
  createCentralPurchaseOrder: createOrder,
}));

function facts(): InventoryDemoFacts {
  return {
    organizationId: 'org',
    branchId: 'branch',
    ownerUserId: 'owner',
    actorId: 'purchaser',
    namespace: 'demo:unit-test',
    businessDate: '2026-09-07',
    scenarioAt: '2026-09-07T10:00:00Z',
    timezone: 'Asia/Karachi',
    currency: 'PKR',
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
  // Deliberately only expose the permitted read; unexpected writes fail the test.
  return { tx: { pharmacyPurchaseOrder: { findFirst } } as unknown as ScopedDb, findFirst };
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
    expect(plan.input.reference).toBe('demo:unit-test:inventory:po:v1');
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
    expect(result.status).toBe('created-draft');
    expect(result).toMatchObject({ deliveredStock: [], purchaseOrderId: 'synthetic-po' });
  });
  it('preserves reconciled operator changes without reading or writing domain rows', async () => {
    createOrder.mockClear();
    const { tx, findFirst } = database();
    const input = facts();
    const result = await executeInventoryDemo(tx, input, {
      state: 'preserve',
      hash: planInventoryDemo(input).hash,
      purchaseOrderId: 'retained',
    });
    expect(result.status).toBe('preserved');
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
