/**
 * PUR-07 — the deterministic evaluator.
 *
 * The whole point of PUR-07 being deterministic is that these cases can be
 * enumerated: given exact facts, an approved threshold and open inbound
 * quantities, exactly one set of signals follows. No case here depends on a wall
 * clock, on ordering luck, or on anything a forecast would supply.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SIGNAL_POLICY,
  dedupKeyFor,
  evaluateStockSignals,
  isSnoozeExpired,
  isStale,
  PharmacyStockSignalError,
} from './stock-signals';
import type { LotFact, SignalFacts, SignalPolicy } from './stock-signals';

const AT = new Date('2026-09-02T09:00:00.000Z');
const DAY = 86_400_000;
const MEDICINE = 'med_paracetamol';
const LOCATION = 'loc_main';

function lot(overrides: Partial<LotFact> = {}): LotFact {
  return {
    inventoryLotId: 'lot_1',
    medicineId: MEDICINE,
    stockLocationId: LOCATION,
    expiresAt: new Date(AT.getTime() + 400 * DAY),
    receivedAt: new Date(AT.getTime() - 30 * DAY),
    disposition: 'AVAILABLE',
    batchState: 'ACTIVE',
    onHandUnits: 100,
    reservedUnits: 0,
    returnWindowEndsAt: null,
    medicineColdChain: false,
    locationColdChain: false,
    recallReference: null,
    unsettled: false,
    ...overrides,
  };
}

function facts(overrides: Partial<SignalFacts> = {}): SignalFacts {
  return {
    organizationId: 'org_a',
    branchId: 'branch_a',
    at: AT,
    sourceObservedAt: new Date(AT.getTime() - 3_600_000),
    lots: [],
    safetyStocks: [],
    inbound: [],
    countVariances: [],
    ...overrides,
  };
}

const SAFETY = { medicineId: MEDICINE, safetyStockUnits: 120, coverageDays: 30, approvedAt: AT };

function kinds(signals: ReadonlyArray<{ kind: string }>): string[] {
  return signals.map((signal) => signal.kind);
}

describe('PUR-07 — no approved threshold, no stock-level signal', () => {
  it('raises nothing for a product with no approved safety stock, however low it is', () => {
    const result = evaluateStockSignals(facts({ lots: [lot({ onHandUnits: 1 })] }));
    expect(kinds(result)).toEqual([]);
  });

  it('raises nothing when a safety stock of zero has been approved', () => {
    const result = evaluateStockSignals(
      facts({
        lots: [lot({ onHandUnits: 0 })],
        safetyStocks: [{ ...SAFETY, safetyStockUnits: 0 }],
      })
    );
    expect(kinds(result)).toEqual([]);
  });
});

describe('PUR-07 — shortfall, stockout and inbound coverage', () => {
  it('raises LOW_STOCK when on-hand is below the approved threshold and nothing is inbound', () => {
    const result = evaluateStockSignals(
      facts({ lots: [lot({ onHandUnits: 40 })], safetyStocks: [SAFETY] })
    );
    expect(kinds(result)).toEqual(['LOW_STOCK']);
    expect(result[0]).toMatchObject({
      neededUnits: 120,
      onHandUnits: 40,
      inboundUnits: 0,
      confidence: 'EXACT',
      cause: 'BELOW_SAFETY_STOCK',
      ownerUserId: 'role:purchasing',
    });
    expect(result[0]!.explanation).toContain('40 units are on hand');
    expect(result[0]!.explanation).toContain('safety stock of 120');
  });

  it('raises STOCKOUT rather than LOW_STOCK when nothing saleable is left', () => {
    const result = evaluateStockSignals(
      facts({ lots: [lot({ onHandUnits: 0 })], safetyStocks: [SAFETY] })
    );
    expect(kinds(result)).toEqual(['STOCKOUT']);
    expect(result[0]!.dueAt).toEqual(new Date(AT.getTime() + 4 * 3_600_000));
  });

  it('counts reserved, expired, recalled, quarantined and unreceived units as unsaleable', () => {
    const unsaleable = [
      lot({ inventoryLotId: 'lot_reserved', onHandUnits: 50, reservedUnits: 50 }),
      lot({
        inventoryLotId: 'lot_expired',
        onHandUnits: 50,
        expiresAt: new Date(AT.getTime() - DAY),
      }),
      lot({ inventoryLotId: 'lot_recalled', onHandUnits: 50, recallReference: 'REC-1' }),
      lot({ inventoryLotId: 'lot_quarantined', onHandUnits: 50, disposition: 'QUARANTINE' }),
      lot({ inventoryLotId: 'lot_unreceived', onHandUnits: 50, receivedAt: null }),
    ];
    const result = evaluateStockSignals(facts({ lots: unsaleable, safetyStocks: [SAFETY] }));
    const shortfall = result.find((signal) => signal.kind === 'STOCKOUT');
    expect(shortfall).toBeDefined();
    expect(shortfall!.onHandUnits).toBe(0);
  });

  it('reports INBOUND_COVERAGE instead of a shortfall once approved inbound covers the need', () => {
    // PUR-07 acceptance: "closes when on-hand plus approved inbound covers the
    // need". The shortfall signal is not produced, which is what closes the
    // persisted one on the next refresh.
    const result = evaluateStockSignals(
      facts({
        lots: [lot({ onHandUnits: 40 })],
        safetyStocks: [SAFETY],
        inbound: [{ medicineId: MEDICINE, units: 80, source: 'PURCHASE_ORDER', reference: 'PO-1' }],
      })
    );
    expect(kinds(result)).toEqual(['INBOUND_COVERAGE']);
    expect(result[0]).toMatchObject({ onHandUnits: 40, inboundUnits: 80, neededUnits: 120 });
    expect(result[0]!.explanation).toContain('covers the shortfall of 80');
  });

  it('keeps the shortfall signal when inbound is one unit short of covering it', () => {
    const result = evaluateStockSignals(
      facts({
        lots: [lot({ onHandUnits: 40 })],
        safetyStocks: [SAFETY],
        inbound: [{ medicineId: MEDICINE, units: 79, source: 'PURCHASE_ORDER', reference: 'PO-1' }],
      })
    );
    expect(kinds(result)).toEqual(['LOW_STOCK']);
  });
});

describe('PUR-07 — projected stockout is expiry depletion, not a forecast', () => {
  it('raises PROJECTED_STOCKOUT when stock expiring inside the horizon drops cover below the threshold', () => {
    const result = evaluateStockSignals(
      facts({
        lots: [
          lot({
            inventoryLotId: 'lot_soon',
            onHandUnits: 100,
            expiresAt: new Date(AT.getTime() + 10 * DAY),
          }),
          lot({ inventoryLotId: 'lot_later', onHandUnits: 50 }),
        ],
        safetyStocks: [SAFETY],
      })
    );
    expect(kinds(result)).toContain('PROJECTED_STOCKOUT');
    const projected = result.find((signal) => signal.kind === 'PROJECTED_STOCKOUT')!;
    expect(projected).toMatchObject({
      onHandUnits: 150,
      neededUnits: 120,
      cause: 'EXPIRY_DEPLETION',
    });
    expect(projected.explanation).toContain('100 of them expire within 30 days, leaving 50');
  });

  it('stays silent when nothing expires inside the horizon', () => {
    const result = evaluateStockSignals(
      facts({ lots: [lot({ onHandUnits: 150 })], safetyStocks: [SAFETY] })
    );
    expect(kinds(result)).toEqual([]);
  });

  it('stays silent when approved inbound replaces the expiring stock', () => {
    const result = evaluateStockSignals(
      facts({
        lots: [
          lot({
            inventoryLotId: 'lot_soon',
            onHandUnits: 100,
            expiresAt: new Date(AT.getTime() + 10 * DAY),
          }),
          lot({ inventoryLotId: 'lot_later', onHandUnits: 50 }),
        ],
        safetyStocks: [SAFETY],
        inbound: [{ medicineId: MEDICINE, units: 70, source: 'TRANSFER', reference: 'TR-1' }],
      })
    );
    // The near-expiry lot still deserves its own signal — that condition has not
    // gone away. What must not appear is a projected stockout, because the
    // approved inbound covers the depletion.
    expect(kinds(result)).toEqual(['NEAR_EXPIRY']);
  });
});

describe('PUR-07 — lot-level signals', () => {
  it('raises NEAR_EXPIRY inside the window and nothing outside it', () => {
    const inside = evaluateStockSignals(
      facts({ lots: [lot({ expiresAt: new Date(AT.getTime() + 45 * DAY) })] })
    );
    expect(kinds(inside)).toEqual(['NEAR_EXPIRY']);
    expect(inside[0]!.explanation).toContain('expire in 45 days');
    expect(inside[0]!.explanation).toContain('60-day near-expiry alert');

    const outside = evaluateStockSignals(
      facts({ lots: [lot({ expiresAt: new Date(AT.getTime() + 91 * DAY) })] })
    );
    expect(kinds(outside)).toEqual([]);
  });

  it('keeps the 30-day sentence and band together one millisecond past 30 elapsed days', () => {
    const result = evaluateStockSignals(
      facts({ lots: [lot({ expiresAt: new Date(AT.getTime() + 30 * DAY + 1) })] })
    );
    expect(result[0]!.explanation).toContain('expire in 30 days');
    expect(result[0]!.explanation).toContain('30-day near-expiry alert');
    expect(result[0]!.explanation).not.toContain('60-day');
  });

  it('names the 30-day and 90-day near-expiry alerts', () => {
    const soon = evaluateStockSignals(
      facts({ lots: [lot({ expiresAt: new Date(AT.getTime() + 12 * DAY) })] })
    );
    const watch = evaluateStockSignals(
      facts({ lots: [lot({ expiresAt: new Date(AT.getTime() + 75 * DAY) })] })
    );
    expect(soon[0]!.explanation).toContain('30-day near-expiry alert');
    expect(watch[0]!.explanation).toContain('90-day near-expiry alert');
  });

  it('raises RETURN_WINDOW while the supplier deadline is closing and not once it has lapsed', () => {
    const closing = evaluateStockSignals(
      facts({ lots: [lot({ returnWindowEndsAt: new Date(AT.getTime() + 10 * DAY) })] })
    );
    expect(kinds(closing)).toEqual(['RETURN_WINDOW']);
    expect(closing[0]!.explanation).toContain('closes in 10 days');

    const lapsed = evaluateStockSignals(
      facts({ lots: [lot({ returnWindowEndsAt: new Date(AT.getTime() - DAY) })] })
    );
    expect(kinds(lapsed)).toEqual([]);
  });

  it('raises RECALL for held stock under an open notice, naming the notice in the dedup key', () => {
    const result = evaluateStockSignals(facts({ lots: [lot({ recallReference: 'REC-2026-11' })] }));
    expect(kinds(result)).toEqual(['RECALL']);
    expect(result[0]!.dedupKey).toBe(
      dedupKeyFor({
        kind: 'RECALL',
        medicineId: MEDICINE,
        stockLocationId: LOCATION,
        cause: 'RECALL_REC-2026-11',
      })
    );
    expect(result[0]!.dueAt).toEqual(new Date(AT.getTime() + 2 * 3_600_000));
  });

  it('raises QUARANTINE for held and damaged stock', () => {
    for (const disposition of ['QUARANTINE', 'DAMAGED'] as const) {
      const result = evaluateStockSignals(facts({ lots: [lot({ disposition })] }));
      expect(kinds(result)).toEqual(['QUARANTINE']);
      expect(result[0]!.cause).toBe(`HELD_${disposition}`);
    }
  });

  it('raises COLD_CHAIN only when a cold-chain medicine sits outside a validated zone', () => {
    const breached = evaluateStockSignals(
      facts({ lots: [lot({ medicineColdChain: true, locationColdChain: false })] })
    );
    expect(kinds(breached)).toEqual(['COLD_CHAIN']);

    const compliant = evaluateStockSignals(
      facts({ lots: [lot({ medicineColdChain: true, locationColdChain: true })] })
    );
    expect(kinds(compliant)).toEqual([]);
  });

  it('ignores a bucket that holds nothing', () => {
    const result = evaluateStockSignals(
      facts({
        lots: [lot({ onHandUnits: 0, recallReference: 'REC-1', disposition: 'QUARANTINE' })],
      })
    );
    expect(kinds(result)).toEqual([]);
  });
});

describe('PUR-07 — count variance', () => {
  it('raises only above the threshold the count itself agreed', () => {
    const above = evaluateStockSignals(
      facts({
        countVariances: [
          {
            inventoryLotId: 'lot_1',
            medicineId: MEDICINE,
            stockLocationId: LOCATION,
            varianceUnits: -9,
            varianceThreshold: 5,
            observedAt: AT,
          },
        ],
      })
    );
    expect(kinds(above)).toEqual(['COUNT_VARIANCE']);
    expect(above[0]!.explanation).toContain('variance of -9 units exceeds the 5-unit threshold');

    const within = evaluateStockSignals(
      facts({
        countVariances: [
          {
            inventoryLotId: 'lot_1',
            medicineId: MEDICINE,
            stockLocationId: LOCATION,
            varianceUnits: 5,
            varianceThreshold: 5,
            observedAt: AT,
          },
        ],
      })
    );
    expect(kinds(within)).toEqual([]);
  });
});

describe('PUR-07 — confidence, determinism and the data window', () => {
  it('drops to PARTIAL when an unapproved count or discrepancy leaves on-hand in dispute', () => {
    const result = evaluateStockSignals(
      facts({ lots: [lot({ onHandUnits: 40, unsettled: true })], safetyStocks: [SAFETY] })
    );
    expect(result[0]).toMatchObject({ kind: 'LOW_STOCK', confidence: 'PARTIAL' });
  });

  it('stamps every signal with the data window and the freshness policy in force', () => {
    const result = evaluateStockSignals(
      facts({ lots: [lot({ onHandUnits: 40 })], safetyStocks: [SAFETY] })
    );
    expect(result[0]).toMatchObject({
      dataWindowStart: new Date(AT.getTime() - 90 * DAY),
      dataWindowEnd: AT,
      sourceObservedAt: new Date(AT.getTime() - 3_600_000),
      freshnessSeconds: DEFAULT_SIGNAL_POLICY.freshnessSeconds,
      computedAt: AT,
    });
  });

  it('produces byte-identical output for the same facts, in dedup-key order', () => {
    const input = facts({
      lots: [
        lot({
          inventoryLotId: 'lot_b',
          onHandUnits: 40,
          expiresAt: new Date(AT.getTime() + 10 * DAY),
        }),
        lot({ inventoryLotId: 'lot_a', onHandUnits: 5, disposition: 'QUARANTINE' }),
      ],
      safetyStocks: [SAFETY],
    });
    const first = evaluateStockSignals(input);
    const second = evaluateStockSignals(input);
    expect(second).toEqual(first);
    expect([...first].sort((a, b) => a.dedupKey.localeCompare(b.dedupKey))).toEqual(first);
  });

  it('rejects an impossible policy instead of silently substituting a default', () => {
    const broken = { ...DEFAULT_SIGNAL_POLICY, nearExpiryDays: 0 } as SignalPolicy;
    expect(() => evaluateStockSignals(facts(), broken)).toThrowError(PharmacyStockSignalError);
  });

  it('rejects a non-integer on-hand quantity (§8A invariant 1)', () => {
    expect(() => evaluateStockSignals(facts({ lots: [lot({ onHandUnits: 12.5 })] }))).toThrowError(
      PharmacyStockSignalError
    );
  });
});

describe('PUR-07 — freshness and snooze predicates', () => {
  it('marks a signal stale strictly after its own freshness policy elapses', () => {
    const signal = { computedAt: AT, freshnessSeconds: 3_600 };
    expect(isStale(signal, new Date(AT.getTime() + 3_600_000))).toBe(false);
    expect(isStale(signal, new Date(AT.getTime() + 3_600_001))).toBe(true);
  });

  it('reads the policy off the signal, so a later policy change cannot rewrite history', () => {
    const strict = { computedAt: AT, freshnessSeconds: 60 };
    const lenient = { computedAt: AT, freshnessSeconds: 86_400 };
    const now = new Date(AT.getTime() + 3_600_000);
    expect(isStale(strict, now)).toBe(true);
    expect(isStale(lenient, now)).toBe(false);
  });

  it('returns a snoozed signal to its owner at the instant the deferral runs out', () => {
    const snoozed = { status: 'SNOOZED' as const, snoozedUntil: AT };
    expect(isSnoozeExpired(snoozed, new Date(AT.getTime() - 1))).toBe(false);
    expect(isSnoozeExpired(snoozed, AT)).toBe(true);
    expect(isSnoozeExpired({ status: 'OPEN', snoozedUntil: AT }, AT)).toBe(false);
  });
});
