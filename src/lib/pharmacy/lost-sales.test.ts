import { describe, expect, it, vi } from 'vitest';

import {
  classifyVisitType,
  estimateLossMinor,
  groupVisits,
  LOST_SALES_DEFAULTS,
  lossProbability,
  notifyCapture,
  setDemandOutcome,
  settleLostSales,
  unknownLossProbability,
  updateLostSalesSettings,
  visitLossMinor,
} from './lost-sales';
import { captureDemand } from './sales';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'user-a' };
const t0 = new Date('2026-11-01T10:00:00.000Z');
const minutes = (n: number) => new Date(t0.getTime() + n * 60_000);
const days = (n: number) => new Date(t0.getTime() + n * 24 * 60 * 60_000);

describe('DEV-81 visit grouping', () => {
  it('groups lines from one terminal and customer within ten minutes', () => {
    const visits = groupVisits([
      { id: 'a', terminalKey: 't1', customerId: null, createdAt: minutes(0) },
      { id: 'b', terminalKey: 't1', customerId: null, createdAt: minutes(6) },
      { id: 'c', terminalKey: 't1', customerId: null, createdAt: minutes(15) },
      { id: 'd', terminalKey: 't1', customerId: null, createdAt: minutes(27) },
    ]);
    expect(visits.get('a')).toBe('a');
    expect(visits.get('b')).toBe('a');
    // Within ten minutes of the previous line keeps the same visit.
    expect(visits.get('c')).toBe('a');
    // A twelve-minute gap starts a new visit.
    expect(visits.get('d')).toBe('d');
  });

  it('separates other terminals and other customers', () => {
    const visits = groupVisits([
      { id: 'a', terminalKey: 't1', customerId: 'c1', createdAt: minutes(0) },
      { id: 'b', terminalKey: 't2', customerId: 'c1', createdAt: minutes(1) },
      { id: 'c', terminalKey: 't1', customerId: 'c2', createdAt: minutes(2) },
      { id: 'd', terminalKey: 't1', customerId: 'c1', createdAt: minutes(3) },
    ]);
    expect(new Set(visits.values())).toEqual(new Set(['a', 'b', 'c']));
    expect(visits.get('d')).toBe('a');
  });

  it('classifies a visit that sold something as partial and one that sold nothing as a walk-out', () => {
    expect(classifyVisitType({ soldLineCount: 2 })).toBe('PARTIAL');
    expect(classifyVisitType({ soldLineCount: 0 })).toBe('WALK_OUT');
  });
});

describe('DEV-81 loss probability per outcome', () => {
  const base = { createdAt: t0, now: t0, unknownProbability: 0.43 };
  it.each([
    ['SUBSTITUTE_TAKEN', 'PARTIAL', 0],
    ['ORDERED_FOR_CUSTOMER', 'PARTIAL', 0],
    ['WENT_ELSEWHERE', 'PARTIAL', 1],
    ['WILL_RETURN', 'PARTIAL', 0],
    ['UNKNOWN', 'PARTIAL', 0.43],
    ['UNKNOWN', 'WALK_OUT', 1],
  ] as const)('%s on a %s visit is %s', (outcome, visitType, expected) => {
    expect(lossProbability({ ...base, outcome, visitType })).toBe(expected);
  });

  it('flips WILL_RETURN to lost after seven days without a matching sale', () => {
    const input = { outcome: 'WILL_RETURN', visitType: 'PARTIAL', createdAt: t0 } as const;
    expect(lossProbability({ ...input, now: days(6.9), unknownProbability: 0.43 })).toBe(0);
    expect(lossProbability({ ...input, now: days(7), unknownProbability: 0.43 })).toBe(1);
    expect(
      lossProbability({ ...input, now: days(9), matchedSaleAt: days(3), unknownProbability: 0.43 })
    ).toBe(0);
    // A sale after the window does not rescue the line.
    expect(
      lossProbability({ ...input, now: days(9), matchedSaleAt: days(8), unknownProbability: 0.43 })
    ).toBe(1);
  });

  it('uses the configured default until 200 known outcomes, then the branch rate', () => {
    expect(
      unknownLossProbability({
        configured: 0.43,
        minEvents: 200,
        knownOutcomeEvents: 199,
        lostKnownOutcomeEvents: 50,
      })
    ).toEqual({ probability: 0.43, source: 'CONFIGURED_DEFAULT' });
    expect(
      unknownLossProbability({
        configured: 0.43,
        minEvents: 200,
        knownOutcomeEvents: 200,
        lostKnownOutcomeEvents: 50,
      })
    ).toEqual({ probability: 0.25, source: 'BRANCH_MEASURED' });
    expect(LOST_SALES_DEFAULTS.unknownLossProbability).toBe(0.43);
    expect(LOST_SALES_DEFAULTS.measuredRateMinEvents).toBe(200);
  });

  it('respects a branch-configured default instead of 0.43', () => {
    expect(
      unknownLossProbability({
        configured: 0.3,
        minEvents: 200,
        knownOutcomeEvents: 10,
        lostKnownOutcomeEvents: 10,
      }).probability
    ).toBe(0.3);
  });

  it('computes loss as quantity × unit price × p and adds left-behind lines on a walk-out', () => {
    expect(estimateLossMinor({ quantity: 3, unitPriceMinor: 1000, probability: 0.43 })).toBe(1290);
    expect(estimateLossMinor({ quantity: 3, unitPriceMinor: null, probability: 1 })).toBeNull();
    expect(
      visitLossMinor({
        visitType: 'WALK_OUT',
        lineLossesMinor: [3000, null],
        leftBehindInStockMinor: 500,
      })
    ).toBe(3500);
    expect(
      visitLossMinor({ visitType: 'PARTIAL', lineLossesMinor: [3000], leftBehindInStockMinor: 500 })
    ).toBe(3000);
  });

  it('keeps a notify phone only with an explicit opt-in', () => {
    expect(() => notifyCapture({ notifyPhone: '03001234567' })).toThrow('CONSENT_REQUIRED');
    expect(notifyCapture({ notifyOptIn: true, notifyPhone: '0300-123 4567' })).toEqual({
      notifyOptIn: true,
      notifyPhone: '03001234567',
    });
    expect(notifyCapture({})).toEqual({ notifyOptIn: false, notifyPhone: null });
  });
});

function captureDb(options: {
  previous?: { visitId: string; visitType: 'PARTIAL' | 'WALK_OUT'; saleId: string | null } | null;
  soldLines?: number;
  lot?: { printedMrpMinor: number; unitsPerPack: number } | null;
  counts?: number[];
}) {
  const counts = [...(options.counts ?? [0, 0, 0, 0])];
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'demand-1',
    ...args.data,
  }));
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const db = {
    $queryRaw: vi.fn(
      async (_sql: TemplateStringsArray, id: string, organizationId: string, branchId: string) =>
        id === 'sale-1' && organizationId === scope.organizationId && branchId === scope.branchId
          ? [{ id }]
          : []
    ),
    unfulfilledDemandEvent: {
      findFirst: vi.fn(async () => options.previous ?? null),
      count: vi.fn(async () => counts.shift() ?? 0),
      create,
      updateMany,
    },
    pharmacySaleLine: { count: vi.fn(async () => options.soldLines ?? 0) },
    pharmacyInventoryLot: { findFirst: vi.fn(async () => options.lot ?? null) },
    pharmacyBranch: {
      findFirst: vi.fn(async () => ({
        lostSalesUnknownLossProbability: 0.43,
        lostSalesMeasuredRateMinEvents: 200,
      })),
    },
  };
  return { db, create, updateMany };
}

const demandInput = {
  requestedMedicineId: 'med-1',
  requestedText: 'Panadol 500',
  saleUnit: 'UNIT' as const,
  quantity: 4,
  reason: 'STOCKOUT' as const,
  inventoryRuleSnapshot: {},
};

describe('DEV-81 captureDemand', () => {
  it('prices the line on the server and ignores client value estimates', async () => {
    const { db, create } = captureDb({
      soldLines: 1,
      lot: { printedMrpMinor: 10_000, unitsPerPack: 10 },
    });
    await captureDemand(
      db as never,
      scope,
      { ...demandInput, saleId: 'sale-1', terminalId: 'device-1', estimatedValueMinor: 1 },
      t0
    );
    const data = create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      unitPricePkrMinor: 1000,
      visitType: 'PARTIAL',
      outcome: 'UNKNOWN',
      requestedQty: 4,
      lossProbability: 0.43,
      estLossPkrMinor: 1720,
      terminalId: 'device-1',
      notifyOptIn: false,
      notifyPhone: null,
    });
    expect(typeof data.visitId).toBe('string');
  });

  it('refuses to record demand against a bill outside the current branch', async () => {
    const { db, create } = captureDb({});
    await expect(
      captureDemand(
        db as never,
        { ...scope, branchId: 'branch-b' },
        { ...demandInput, saleId: 'sale-1' },
        t0
      )
    ).rejects.toThrow('NOT_FOUND');
    expect(create).not.toHaveBeenCalled();
  });

  it('treats a line with no sold lines as a walk-out (p = 1)', async () => {
    const { db, create } = captureDb({ lot: { printedMrpMinor: 10_000, unitsPerPack: 10 } });
    await captureDemand(db as never, scope, demandInput, t0);
    expect(create.mock.calls[0]![0].data).toMatchObject({
      visitType: 'WALK_OUT',
      lossProbability: 1,
      estLossPkrMinor: 4000,
    });
  });

  it('joins the open visit and upgrades it to partial once a line sold', async () => {
    const { db, create, updateMany } = captureDb({
      previous: { visitId: 'visit-1', visitType: 'WALK_OUT', saleId: 'sale-1' },
      soldLines: 2,
    });
    await captureDemand(db as never, scope, { ...demandInput, terminalId: 'device-1' }, t0);
    expect(create.mock.calls[0]![0].data).toMatchObject({
      visitId: 'visit-1',
      visitType: 'PARTIAL',
      unitPricePkrMinor: null,
      estLossPkrMinor: null,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', branchId: 'branch-a', visitId: 'visit-1' },
      data: { visitType: 'PARTIAL' },
    });
  });

  it('switches UNKNOWN to the branch rate after 200 known outcomes', async () => {
    // counts: final known, settled will-return, went elsewhere, unreturned.
    const { db, create } = captureDb({
      soldLines: 1,
      lot: { printedMrpMinor: 10_000, unitsPerPack: 10 },
      counts: [180, 20, 40, 10],
    });
    await captureDemand(db as never, scope, { ...demandInput, saleId: 'sale-1' }, t0);
    expect(create.mock.calls[0]![0].data).toMatchObject({
      lossProbability: 0.25,
      estLossPkrMinor: 1000,
    });
  });

  it('refuses a notify phone without opt-in', async () => {
    const { db } = captureDb({});
    await expect(
      captureDemand(db as never, scope, { ...demandInput, notifyPhone: '03001234567' }, t0)
    ).rejects.toThrow('CONSENT_REQUIRED');
  });
});

describe('DEV-81 outcome chip and settlement', () => {
  it('records a chip tap and recomputes the loss on the server', async () => {
    const update = vi.fn(async (args: unknown) => args);
    const db = {
      unfulfilledDemandEvent: {
        findFirst: vi.fn(async () => ({
          id: 'demand-1',
          quantity: 2,
          unitPricePkrMinor: 500,
          visitType: 'PARTIAL',
          createdAt: t0,
          notifyOptIn: false,
          notifyPhone: null,
        })),
        update,
      },
    };
    await setDemandOutcome(
      db as never,
      scope,
      {
        demandId: 'demand-1',
        outcome: 'WENT_ELSEWHERE',
        notifyOptIn: true,
        notifyPhone: '03001234567',
      },
      t0
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          outcome: 'WENT_ELSEWHERE',
          lossProbability: 1,
          estLossPkrMinor: 1000,
          notifyOptIn: true,
          notifyPhone: '03001234567',
          substituteProductId: null,
        }),
      })
    );
  });

  function settleDb(event: Record<string, unknown>, matched: unknown) {
    const update = vi.fn(async (args: unknown) => args);
    const db = {
      pharmacyBranch: {
        findFirst: vi.fn(async () => ({
          lostSalesUnknownLossProbability: 0.43,
          lostSalesMeasuredRateMinEvents: 200,
        })),
      },
      unfulfilledDemandEvent: {
        count: vi.fn(async () => 0),
        findMany: vi.fn<(args: unknown) => Promise<unknown[]>>(async () => [event]),
        update,
      },
      pharmacySaleLine: { findFirst: vi.fn(async () => matched) },
    };
    return { db, update };
  }
  const willReturn = {
    id: 'demand-1',
    saleId: 'sale-1',
    visitType: 'PARTIAL',
    outcome: 'WILL_RETURN',
    quantity: 2,
    unitPricePkrMinor: 500,
    lossProbability: 0,
    estLossPkrMinor: 0,
    requestedMedicineId: 'med-1',
    customerId: null,
    createdAt: t0,
    sale: { status: 'COMPLETED', createdAt: t0 },
  };

  it('flips an unanswered WILL_RETURN to lost after seven days', async () => {
    const { db, update } = settleDb(willReturn, null);
    await settleLostSales(db as never, scope, days(8));
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lossProbability: 1, estLossPkrMinor: 1000 }),
      })
    );
  });

  it('resolves a WILL_RETURN to the sale that came back', async () => {
    const { db, update } = settleDb(
      { ...willReturn, customerId: 'patient-1' },
      { saleId: 'sale-2', sale: { completedAt: days(2) } }
    );
    await settleLostSales(db as never, scope, days(8));
    expect(db.pharmacySaleLine.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sale: expect.objectContaining({ customer: { patientId: 'patient-1' } }),
        }),
      })
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lossProbability: 0,
          estLossPkrMinor: 0,
          resolvedBySaleId: 'sale-2',
          resolvedAt: days(2),
        }),
      })
    );
  });

  it("never resolves an anonymous WILL_RETURN with someone else's purchase", async () => {
    const { db, update } = settleDb(willReturn, {
      saleId: 'sale-2',
      sale: { completedAt: days(2) },
    });
    await settleLostSales(db as never, scope, days(8));
    expect(db.pharmacySaleLine.findFirst).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ resolvedBySaleId: expect.anything() }),
      })
    );
    expect(update.mock.calls[0]![0]).toMatchObject({ data: { lossProbability: 1 } });
  });

  it('reconciles the visit type of a final outcome when its bill is voided', async () => {
    const { db, update } = settleDb(
      {
        ...willReturn,
        outcome: 'WENT_ELSEWHERE',
        lossProbability: 1,
        estLossPkrMinor: 1000,
        sale: { status: 'VOID', createdAt: t0 },
      },
      null
    );
    await settleLostSales(db as never, scope, minutes(30));
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ visitType: 'WALK_OUT', lossProbability: 1 }),
      })
    );
    const where = db.unfulfilledDemandEvent.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(where.where).not.toHaveProperty('outcome');
  });

  it('walks past the first 500 eligible rows with a stable cursor', async () => {
    const row = (i: number) => ({ ...willReturn, id: `demand-${i}`, outcome: 'UNKNOWN' });
    const first = Array.from({ length: 500 }, (_, i) => row(i));
    const second = [row(500), row(501)];
    const { db } = settleDb(willReturn, null);
    db.unfulfilledDemandEvent.findMany = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const result = await settleLostSales(db as never, scope, days(1));
    expect(result.evaluated).toBe(502);
    expect(db.unfulfilledDemandEvent.findMany).toHaveBeenCalledTimes(2);
    expect(db.unfulfilledDemandEvent.findMany.mock.calls[1]![0]).toMatchObject({
      cursor: { id: 'demand-499' },
      skip: 1,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  });

  it('reclassifies a voided visit as a walk-out', async () => {
    const { db, update } = settleDb(
      {
        ...willReturn,
        outcome: 'UNKNOWN',
        lossProbability: 0.43,
        estLossPkrMinor: 430,
        sale: { status: 'VOID', createdAt: t0 },
      },
      null
    );
    await settleLostSales(db as never, scope, minutes(30));
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          visitType: 'WALK_OUT',
          lossProbability: 1,
          estLossPkrMinor: 1000,
        }),
      })
    );
  });

  it('rejects out-of-range settings', async () => {
    const db = { pharmacyBranch: { updateMany: vi.fn(async () => ({ count: 1 })) } };
    await expect(
      updateLostSalesSettings(db as never, scope, { unknownLossProbability: 1.5 })
    ).rejects.toThrow('INVALID_SETTINGS');
    await expect(
      updateLostSalesSettings(db as never, scope, { measuredRateMinEvents: 0 })
    ).rejects.toThrow('INVALID_SETTINGS');
    await updateLostSalesSettings(db as never, scope, { unknownLossProbability: 0.3 });
    expect(db.pharmacyBranch.updateMany).toHaveBeenCalledWith({
      where: { id: 'branch-a', organizationId: 'org-a' },
      data: { lostSalesUnknownLossProbability: 0.3 },
    });
  });
});
