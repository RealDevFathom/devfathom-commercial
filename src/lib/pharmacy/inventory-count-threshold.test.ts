import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ enforce: vi.fn() }));
vi.mock('./operating-mode', () => ({ enforceOperatingMode: mocks.enforce }));

import {
  approveCount,
  createCount,
  effectiveCountVarianceThreshold,
  PHARMACY_COUNT_MAX_VARIANCE_THRESHOLD_UNITS,
} from './inventory-operations';

const scope = { organizationId: 'org', branchId: 'branch', actorId: 'maker' };
const CAP = PHARMACY_COUNT_MAX_VARIANCE_THRESHOLD_UNITS;

/** Minimal scoped-db double: one lot of 10 units/pack with 40 units on hand. */
function createDb(organizationThreshold = 0) {
  const lines: Array<{ varianceUnits: number }> = [];
  const db = {
    organization: {
      findFirst: vi.fn(async () => ({
        pharmacyCountVarianceThresholdUnits: organizationThreshold,
      })),
    },
    pharmacyInventoryCount: {
      create: vi.fn(async ({ data }) => ({ id: 'count', ...data })),
      update: vi.fn(async ({ data }) => ({ id: 'count', ...data, lines })),
    },
    pharmacyInventoryLot: { findFirst: vi.fn(async () => ({ id: 'lot', unitsPerPack: 10 })) },
    pharmacyStockBalance: {
      findFirst: vi.fn(async () => ({ onHandUnits: 40, sealedPacks: 4, looseUnits: 0 })),
    },
    pharmacyInventoryCountLine: {
      create: vi.fn(async ({ data }) => {
        lines.push(data);
        return data;
      }),
      findMany: vi.fn(async () => lines),
    },
  };
  return db;
}

function approvalDb(count: {
  status: 'OPEN' | 'AWAITING_COAUTH';
  varianceThreshold: number;
  varianceUnits: number;
}) {
  return {
    $queryRaw: vi.fn(async () => [{ id: 'count' }]),
    pharmacyInventoryCount: {
      findFirst: vi.fn(async () => ({
        id: 'count',
        status: count.status,
        createdById: 'maker',
        varianceThreshold: count.varianceThreshold,
        lines: [
          {
            inventoryLotId: 'lot',
            stockLocationId: 'store',
            varianceUnits: count.varianceUnits,
            countedSealedPacks: 0,
            countedLooseUnits: 0,
            expectedSealedPacks: 0,
            expectedLooseUnits: 0,
          },
        ],
      })),
      update: vi.fn(async ({ data }) => data),
    },
    pharmacyStockMovement: { create: vi.fn(async ({ data }) => data) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enforce.mockRejectedValue(new Error('checker required'));
});

describe('stock count co-authorization threshold is server-owned', () => {
  it('ignores a client-supplied threshold: a large variance still needs co-authorization', async () => {
    const db = createDb(0);
    const count = await createCount(db as never, scope, {
      // Not part of the input type any more; a stale client sending it changes nothing.
      ...({ varianceThreshold: 1_000_000 } as object),
      // 1 pack + 5 loose = 15 counted against 40 expected: a 25-unit shortfall.
      readings: [
        {
          inventoryLotId: 'lot',
          stockLocationId: 'store',
          countedSealedPacks: 1,
          countedLooseUnits: 5,
        },
      ],
    });
    expect(db.organization.findFirst).toHaveBeenCalledWith({
      where: { id: 'org' },
      select: { pharmacyCountVarianceThresholdUnits: true },
    });
    expect(db.pharmacyInventoryCount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ varianceThreshold: 0 }),
    });
    expect(count.status).toBe('AWAITING_COAUTH');
  });

  it('caps a stored organization setting above server policy', async () => {
    expect(effectiveCountVarianceThreshold(2)).toBe(2);
    expect(effectiveCountVarianceThreshold(CAP + 1)).toBe(CAP);
    const db = createDb(1_000_000);
    const count = await createCount(db as never, scope, {
      readings: [
        {
          inventoryLotId: 'lot',
          stockLocationId: 'store',
          countedSealedPacks: 1,
          countedLooseUnits: 5,
        },
      ],
    });
    expect(db.pharmacyInventoryCount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ varianceThreshold: CAP }),
    });
    expect(count.status).toBe('AWAITING_COAUTH');
  });

  it("leaves a count within the owner's threshold OPEN", async () => {
    const db = createDb(5);
    const count = await createCount(db as never, scope, {
      // 3 packs + 5 loose = 35 counted: a 5-unit shortfall, at the threshold.
      readings: [
        {
          inventoryLotId: 'lot',
          stockLocationId: 'store',
          countedSealedPacks: 3,
          countedLooseUnits: 5,
        },
      ],
    });
    expect(db.pharmacyInventoryCount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ varianceThreshold: 5 }),
    });
    expect(count.status).toBe('OPEN');
  });

  it('derives status from the persisted snapshot when the setting changes mid-create', async () => {
    // The read returns 0, but the trigger snapshots a concurrent owner change to 5.
    const db = createDb(0);
    db.pharmacyInventoryCount.create.mockImplementationOnce(async ({ data }) => ({
      id: 'count',
      ...data,
      varianceThreshold: 5,
    }));
    const count = await createCount(db as never, scope, {
      // 3 packs + 5 loose = 35 counted: a 5-unit shortfall, within the stored 5.
      readings: [
        {
          inventoryLotId: 'lot',
          stockLocationId: 'store',
          countedSealedPacks: 3,
          countedLooseUnits: 5,
        },
      ],
    });
    expect(count.status).toBe('OPEN');
  });

  it('refuses a self-approved OPEN count whose stored threshold exceeds server policy', async () => {
    // A row written with a loose client threshold (e.g. before the cap) must not
    // let its creator post an above-policy adjustment without a checker.
    const db = approvalDb({ status: 'OPEN', varianceThreshold: 1_000_000, varianceUnits: -25 });
    await expect(approveCount(db as never, scope, 'count', 'key')).rejects.toMatchObject({
      reason: 'COAUTH_REQUIRED',
    });
    expect(mocks.enforce).toHaveBeenCalledWith(
      db,
      scope,
      expect.objectContaining({ kind: 'ADJUSTMENT', makerIds: ['maker'], targetId: 'count' })
    );
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacyInventoryCount.update).not.toHaveBeenCalled();
  });

  it('still approves a within-policy OPEN count without a checker', async () => {
    const db = approvalDb({ status: 'OPEN', varianceThreshold: 5, varianceUnits: -3 });
    await expect(approveCount(db as never, scope, 'count', 'key')).resolves.toMatchObject({
      status: 'APPROVED',
      approvedById: 'maker',
    });
    expect(mocks.enforce).not.toHaveBeenCalled();
    expect(db.pharmacyStockMovement.create).toHaveBeenCalledOnce();
  });
});
