import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./regulatory', () => ({ assertStoredPharmacyMayOperate: vi.fn() }));
vi.mock('./stock-ledger', async (original) => ({
  ...(await original<typeof import('./stock-ledger')>()),
  allocateForSale: vi.fn(),
}));

import { addSaleLine } from './sales';
import { allocateForSale } from './stock-ledger';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };
const input = {
  saleId: 'sale-a',
  medicineId: 'brufen',
  presentationId: 'presentation-a',
  packLevelId: 'strip-a',
  saleUnit: 'STRIP' as const,
  quantity: 1,
  canonicalUnitsPerSaleUnit: 10,
  idempotencyKey: 'double-press',
};

function fixture() {
  const lines: Array<Record<string, unknown>> = [];
  const allocations: Array<Record<string, unknown>> = [];
  const db = {
    $queryRaw: vi.fn(async () => []),
    pharmacySale: {
      findFirst: vi.fn(async () => ({ id: input.saleId, status: 'OPEN', lines })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    medicine: { findFirst: vi.fn(async () => ({ id: 'brufen', rx: false, controlled: false })) },
    packLevel: {
      findMany: vi.fn(async () => [
        {
          id: 'strip-a',
          level: 'STRIP',
          parentPackLevelId: null,
          unitsPerParent: 10,
        },
      ]),
    },
    pharmacyInventoryLot: {
      findMany: vi.fn(async () => [
        {
          id: 'lot-a',
          packLevelId: 'strip-a',
          unitsPerPack: 10,
          printedMrpMinor: 1000,
          unitCostMinor: 50,
          batch: { batchNumber: 'B1' },
        },
      ]),
    },
    medicinePackMrp: { findMany: vi.fn(async () => []) },
    pharmacySaleLine: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const line = lines.find((row) =>
          Object.entries(where).every(([key, value]) => row[key] === value)
        );
        return line ? { ...line, allocations } : null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (lines.some((line) => line.idempotencyKey === data.idempotencyKey))
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        const line = { id: `line-${lines.length}`, ...data };
        lines.push(line);
        return line;
      }),
    },
    pharmacySaleLineAllocation: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        allocations.push(data);
        return data;
      }),
    },
    pharmacySaleEvent: { create: vi.fn(async () => ({})) },
  };
  return { db, lines, allocations };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(allocateForSale).mockResolvedValue({
    allocations: [{ inventoryLotId: 'lot-a', stockLocationId: 'shelf-a', units: 10 }],
    movementIds: ['movement-a'],
    recommendedLotId: 'lot-a',
    blocked: [],
    overrideId: null,
    discrepancyId: null,
  });
});

describe('DEV-874 add-line idempotency', () => {
  it('[DEF-10] replays Brufen, one strip, without allocating or inserting twice', async () => {
    const { db, lines, allocations } = fixture();
    const first = await addSaleLine(db as never, scope, input);
    const replay = await addSaleLine(db as never, scope, input);
    expect(first).toMatchObject({ replayed: false });
    expect(replay).toMatchObject({ line: first.line, replayed: true });
    expect(replay.allocation.movementIds).toEqual(['movement-a']);
    expect(lines).toHaveLength(1);
    expect(allocations).toHaveLength(1);
    expect(allocateForSale).toHaveBeenCalledTimes(1);
    expect(db.pharmacySaleEvent.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    { quantity: 2 },
    { medicineId: 'other' },
    { presentationId: 'other' },
    { packLevelId: 'other' },
    { saleUnit: 'UNIT' as const },
    { canonicalUnitsPerSaleUnit: 1 },
    { voucherId: 'other' },
  ])('refuses reuse with a changed line: %j', async (change) => {
    const { db } = fixture();
    await addSaleLine(db as never, scope, input);
    await expect(addSaleLine(db as never, scope, { ...input, ...change })).rejects.toMatchObject({
      reason: 'IDEMPOTENCY_CONFLICT',
    });
    expect(allocateForSale).toHaveBeenCalledTimes(1);
  });

  it.each([{ branchId: 'other-branch' }, { organizationId: 'other-org' }])(
    'never replays another scope: %j',
    async (change) => {
      const { db } = fixture();
      await addSaleLine(db as never, scope, input);
      // A miss must continue normal sale validation; never return the foreign line.
      db.pharmacySale.findFirst.mockResolvedValueOnce(null as never);
      await expect(addSaleLine(db as never, { ...scope, ...change }, input)).rejects.toThrow();
    }
  );
});
