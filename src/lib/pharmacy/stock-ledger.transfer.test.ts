import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { transferStock } from './stock-ledger';

const AT = new Date('2027-01-15T10:00:00.000Z');
const SCOPE = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'user_owner' };

type Destination = { id: string; kind: string; coldChain: boolean } | null;
type Leg = Record<string, unknown>;

function fakeDb(
  destination: Destination = { id: 'loc_back', kind: 'RACK_BIN', coldChain: false },
  medicineColdChain = false
) {
  const source = {
    inventoryLotId: 'lot_1',
    stockLocationId: 'loc_store',
    organizationId: 'org_a',
    branchId: 'branch_a',
    batchState: 'ACTIVE',
    disposition: 'AVAILABLE',
    expiresAt: new Date('2028-01-01T00:00:00.000Z'),
    receivedAt: new Date('2026-12-01T00:00:00.000Z'),
    availableUnits: 100,
    unitsPerPack: 10,
    sealedPacks: 10,
    looseUnits: 0,
  };
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([source]),
    pharmacyStockLocation: { findFirst: vi.fn().mockResolvedValue(destination) },
    pharmacyInventoryLot: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ batch: { medicine: { coldChain: medicineColdChain } } }),
    },
    pharmacyStockMovement: {
      findMany: vi.fn<() => Promise<Leg[]>>().mockResolvedValue([]),
      create: vi.fn(async ({ data }: { data: Leg }) => ({ id: 'm', ...data })),
    },
  };
  return db;
}

const INPUT = {
  inventoryLotId: 'lot_1',
  fromStockLocationId: 'loc_store',
  toStockLocationId: 'loc_back',
  units: 20,
  at: AT,
  idempotencyKeyPrefix: 'move-1',
};

/** The two legs an earlier call with prefix `move-1` committed. */
const POSTED_LEGS: Leg[] = [
  {
    id: 'out_1',
    branchId: 'branch_a',
    idempotencyKey: 'move-1:out',
    kind: 'TRANSFER_OUT',
    inventoryLotId: 'lot_1',
    stockLocationId: 'loc_store',
    quantityUnits: -20,
  },
  {
    id: 'in_1',
    branchId: 'branch_a',
    idempotencyKey: 'move-1:in',
    kind: 'TRANSFER_IN',
    inventoryLotId: 'lot_1',
    stockLocationId: 'loc_back',
    quantityUnits: 20,
  },
];

const run = (db: ReturnType<typeof fakeDb>, input = INPUT) =>
  transferStock(db as unknown as ScopedDb, SCOPE, input);

describe('same-branch location transfer (DEV-608)', () => {
  it('lands the moved units AVAILABLE at the destination, not stranded IN_TRANSIT', async () => {
    const db = fakeDb();
    const { out, received } = await run(db);

    expect(out).toMatchObject({
      kind: 'TRANSFER_OUT',
      disposition: 'AVAILABLE',
      stockLocationId: 'loc_store',
      quantityUnits: -20,
    });
    expect(received).toMatchObject({
      kind: 'TRANSFER_IN',
      disposition: 'AVAILABLE',
      stockLocationId: 'loc_back',
      quantityUnits: 20,
    });
    // No leg of a same-branch move is left in a bucket nothing can receive.
    for (const [{ data }] of db.pharmacyStockMovement.create.mock.calls) {
      expect(data.disposition).not.toBe('IN_TRANSIT');
    }
  });

  it.each(['STORE', 'RACK_BIN', 'FRIDGE', 'SAFE'])(
    'moves stock onto a saleable %s location',
    async (kind) => {
      const db = fakeDb({ id: 'loc_back', kind, coldChain: kind === 'FRIDGE' });
      await expect(run(db)).resolves.toMatchObject({ received: { disposition: 'AVAILABLE' } });
    }
  );

  it.each(['QUARANTINE', 'RETURNS', 'TRANSIT'])(
    'refuses to land AVAILABLE units in a %s location, before moving anything',
    async (kind) => {
      const db = fakeDb({ id: 'loc_back', kind, coldChain: false });
      await expect(run(db)).rejects.toMatchObject({ reason: 'UNSALEABLE_DESTINATION' });
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    }
  );

  it('refuses a destination outside the acting branch or retired, before moving anything', async () => {
    const db = fakeDb(null);
    await expect(run(db)).rejects.toMatchObject({ reason: 'NOT_FOUND' });

    expect(db.pharmacyStockLocation.findFirst).toHaveBeenCalledWith({
      where: { id: 'loc_back', organizationId: 'org_a', branchId: 'branch_a', active: true },
      select: { id: true, kind: true, coldChain: true },
    });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('refuses to move cold-chain stock AVAILABLE into an unvalidated zone, before moving anything', async () => {
    const db = fakeDb({ id: 'loc_back', kind: 'STORE', coldChain: false }, true);
    await expect(run(db)).rejects.toMatchObject({ reason: 'COLD_CHAIN_STORAGE_REQUIRED' });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('moves cold-chain stock between validated cold-chain zones', async () => {
    const db = fakeDb({ id: 'loc_back', kind: 'FRIDGE', coldChain: true }, true);
    const { received } = await run(db);
    expect(received).toMatchObject({ kind: 'TRANSFER_IN', disposition: 'AVAILABLE' });
  });
});

describe('same-branch location transfer retries (DEV-608)', () => {
  it('answers a retry with the legs already posted, without locking or moving again', async () => {
    const db = fakeDb();
    db.pharmacyStockMovement.findMany.mockResolvedValue(POSTED_LEGS);

    await expect(run(db)).resolves.toEqual({ out: POSTED_LEGS[0], received: POSTED_LEGS[1] });
    expect(db.pharmacyStockMovement.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_a', idempotencyKey: { in: ['move-1:out', 'move-1:in'] } },
    });
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('replays a concurrent call that committed while this one waited on the source lock', async () => {
    const db = fakeDb();
    db.pharmacyStockMovement.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(POSTED_LEGS);

    await expect(run(db)).resolves.toEqual({ out: POSTED_LEGS[0], received: POSTED_LEGS[1] });
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it.each([
    ['a different lot', { inventoryLotId: 'lot_2' }],
    ['a different source', { fromStockLocationId: 'loc_other' }],
    ['a different destination', { toStockLocationId: 'loc_other' }],
    ['a different quantity', { units: 5 }],
  ])('refuses a prefix reused for %s as a conflict', async (_label, change) => {
    const db = fakeDb();
    db.pharmacyStockMovement.findMany.mockResolvedValue(POSTED_LEGS);

    await expect(run(db, { ...INPUT, ...change })).rejects.toMatchObject({
      reason: 'IDEMPOTENCY_CONFLICT',
    });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('refuses a prefix whose earlier legs are incomplete or belong to another branch', async () => {
    const half = fakeDb();
    half.pharmacyStockMovement.findMany.mockResolvedValue([POSTED_LEGS[0]!]);
    await expect(run(half)).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });

    const sibling = fakeDb();
    sibling.pharmacyStockMovement.findMany.mockResolvedValue(
      POSTED_LEGS.map((leg) => ({ ...leg, branchId: 'branch_b' }))
    );
    await expect(run(sibling)).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
  });
});
