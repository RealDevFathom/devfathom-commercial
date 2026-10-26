/**
 * PH-INV / INV-02, INV-03, INV-04 — the pure kernel.
 *
 * Two kinds of case:
 *   1. PROPERTY tests over the canonical-unit arrangement arithmetic. The input
 *      space is small and total, so these ENUMERATE it exhaustively rather than
 *      sampling: every (units, unitsPerPack) pair in the range, every break-pack
 *      request against every arrangement. That is stronger than a fixed seed and
 *      needs no generator dependency.
 *   2. NEGATIVE-PATH tests, one per §8A invariant this module decides —
 *      3 (exact totals), 4 (hard blocks), 5 (FEFO + override evidence),
 *      6 (never negative), 17 (arrangement reconciles).
 *
 * The database-backed halves of the same invariants live in
 * `stock-ledger.db.test.ts`; a mocked client cannot prove a trigger.
 */
import { describe, expect, it } from 'vitest';

import {
  arrangementFor,
  assertArrangementReconciles,
  assertColdChainStorage,
  blockReasonFor,
  planAllocation,
  planBreakPack,
  planRemovalArrangement,
  unitsForArrangement,
  PharmacyInventoryError,
} from './inventory';
import type { AllocationCandidate, BatchState, StockDisposition } from './inventory';

const AT = new Date('2026-09-02T09:00:00.000Z');
const SCOPE = { organizationId: 'org_a', branchId: 'branch_a', at: AT };

describe('INV-05 cold-chain put-away', () => {
  it('rejects cold-chain stock outside validated storage with a typed reason', () => {
    expect(() => assertColdChainStorage(true, false)).toThrowError(
      expect.objectContaining({ reason: 'COLD_CHAIN_STORAGE_REQUIRED' })
    );
  });

  it('allows cold-chain stock in validated storage and ambient stock anywhere', () => {
    expect(() => assertColdChainStorage(true, true)).not.toThrow();
    expect(() => assertColdChainStorage(false, false)).not.toThrow();
  });
});

function candidate(overrides: Partial<AllocationCandidate> = {}): AllocationCandidate {
  return {
    inventoryLotId: 'lot_1',
    stockLocationId: 'loc_1',
    organizationId: 'org_a',
    branchId: 'branch_a',
    batchState: 'ACTIVE',
    disposition: 'AVAILABLE',
    expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    receivedAt: new Date('2026-01-01T00:00:00.000Z'),
    availableUnits: 100,
    ...overrides,
  };
}

// ── INV-04 / §8A invariants 1 and 17 — arrangement arithmetic ────────────────

describe('canonical-unit arrangement (INV-04)', () => {
  it('splits the PRD example: 57 tablets is 5 strips of 10 and 7 loose', () => {
    expect(arrangementFor(57, 10)).toEqual({ sealedPacks: 5, looseUnits: 7 });
    expect(unitsForArrangement(5, 7, 10)).toBe(57);
  });

  it('round-trips every arrangement in the range (property, exhaustive)', () => {
    for (let unitsPerPack = 1; unitsPerPack <= 24; unitsPerPack += 1) {
      for (let units = 0; units <= 500; units += 1) {
        const { sealedPacks, looseUnits } = arrangementFor(units, unitsPerPack);
        // Total preserved, and the arrangement is normalised: a loose count at
        // or above a full pack would be an unbroken pack counted as loose.
        expect(unitsForArrangement(sealedPacks, looseUnits, unitsPerPack)).toBe(units);
        expect(looseUnits).toBeLessThan(unitsPerPack);
        expect(Number.isSafeInteger(sealedPacks)).toBe(true);
        expect(() =>
          assertArrangementReconciles({ onHandUnits: units, sealedPacks, looseUnits, unitsPerPack })
        ).not.toThrow();
      }
    }
  });

  it('refuses a count whose arrangement does not reconcile to its total', () => {
    // 57 units cannot be 6 sealed strips of 10 and 7 loose; a physical count
    // that reports both is a variance, not a valid arrangement.
    expect(() =>
      assertArrangementReconciles({
        onHandUnits: 57,
        sealedPacks: 6,
        looseUnits: 7,
        unitsPerPack: 10,
      })
    ).toThrow(PharmacyInventoryError);
    // Same total, sealed and loose swapped: still a variance.
    expect(() =>
      assertArrangementReconciles({
        onHandUnits: 57,
        sealedPacks: 7,
        looseUnits: 5,
        unitsPerPack: 10,
      })
    ).toThrow(PharmacyInventoryError);
  });

  it('accepts an un-normalised but reconciling shelf after a pack is broken', () => {
    // 5 sealed strips plus a whole broken strip's 10 loose tablets is a real
    // physical state, not a variance.
    expect(() =>
      assertArrangementReconciles({
        onHandUnits: 60,
        sealedPacks: 5,
        looseUnits: 10,
        unitsPerPack: 10,
      })
    ).not.toThrow();
  });

  it('refuses a non-integer or negative quantity (§8A invariant 1)', () => {
    for (const bad of [1.5, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => arrangementFor(bad, 10)).toThrow(PharmacyInventoryError);
    }
    for (const bad of [0, -10, 2.5]) {
      expect(() => arrangementFor(10, bad)).toThrow(PharmacyInventoryError);
    }
  });
});

describe('break-pack planning (INV-04)', () => {
  it('breaks exactly the packs the shortfall needs, and no more (property)', () => {
    for (let unitsPerPack = 1; unitsPerPack <= 12; unitsPerPack += 1) {
      for (let sealedPacks = 0; sealedPacks <= 8; sealedPacks += 1) {
        for (let looseUnits = 0; looseUnits < unitsPerPack; looseUnits += 1) {
          const total = unitsForArrangement(sealedPacks, looseUnits, unitsPerPack);
          for (let required = 0; required <= total; required += 1) {
            const plan = planBreakPack({
              sealedPacks,
              looseUnits,
              unitsPerPack,
              requiredLooseUnits: required,
            });
            const afterSealed = sealedPacks + plan.sealedPackDelta;
            const afterLoose = looseUnits + plan.looseUnitDelta;
            // The canonical total never moves — only the arrangement does.
            expect(unitsForArrangement(afterSealed, afterLoose, unitsPerPack)).toBe(total);
            expect(afterLoose).toBeGreaterThanOrEqual(required);
            expect(afterSealed).toBeGreaterThanOrEqual(0);
            // Minimality: one fewer broken pack would not have covered it.
            if (plan.packsToBreak > 0) {
              expect(afterLoose - unitsPerPack).toBeLessThan(required);
            }
          }
        }
      }
    }
  });

  it('breaks nothing when the loose units already cover the request', () => {
    expect(
      planBreakPack({ sealedPacks: 5, looseUnits: 7, unitsPerPack: 10, requiredLooseUnits: 7 })
    ).toEqual({ packsToBreak: 0, sealedPackDelta: 0, looseUnitDelta: 0 });
  });

  it('refuses to break more packs than the shelf holds', () => {
    expect(() =>
      planBreakPack({ sealedPacks: 1, looseUnits: 0, unitsPerPack: 10, requiredLooseUnits: 25 })
    ).toThrow(PharmacyInventoryError);
  });
});

describe('removal arrangement planning (INV-04)', () => {
  it('preserves the real physical arrangement for every removable quantity', () => {
    for (let unitsPerPack = 1; unitsPerPack <= 12; unitsPerPack += 1) {
      for (let sealedPacks = 0; sealedPacks <= 5; sealedPacks += 1) {
        for (let looseUnits = 0; looseUnits <= unitsPerPack * 2; looseUnits += 1) {
          const total = unitsForArrangement(sealedPacks, looseUnits, unitsPerPack);
          for (let quantityUnits = 0; quantityUnits <= total; quantityUnits += 1) {
            const plan = planRemovalArrangement({
              sealedPacks,
              looseUnits,
              unitsPerPack,
              quantityUnits,
            });
            const sealedAfterBreak = sealedPacks + plan.breakPack.sealedPackDelta;
            const looseAfterBreak = looseUnits + plan.breakPack.looseUnitDelta;
            const remainder = quantityUnits % unitsPerPack;

            expect(plan.breakPack.packsToBreak).toBe(
              Math.ceil(Math.max(0, remainder - looseUnits) / unitsPerPack)
            );
            expect(plan.sealedPacks * unitsPerPack + plan.looseUnits).toBe(quantityUnits);
            expect(plan.sealedPacks).toBeLessThanOrEqual(sealedAfterBreak);
            expect(plan.looseUnits).toBeLessThanOrEqual(looseAfterBreak);
            expect(
              unitsForArrangement(
                sealedAfterBreak - plan.sealedPacks,
                looseAfterBreak - plan.looseUnits,
                unitsPerPack
              )
            ).toBe(total - quantityUnits);
          }
        }
      }
    }
  });

  it('rejects a removal larger than the physical balance', () => {
    expect(() =>
      planRemovalArrangement({
        sealedPacks: 1,
        looseUnits: 2,
        unitsPerPack: 10,
        quantityUnits: 13,
      })
    ).toThrowError(expect.objectContaining({ reason: 'INSUFFICIENT_STOCK' }));
  });
});

// ── INV-03 / §8A invariant 4 — hard blocks ──────────────────────────────────

describe('hard blocks (INV-03)', () => {
  const blockedStates: Array<[Partial<AllocationCandidate>, string]> = [
    [{ expiresAt: new Date('2026-09-02T09:00:00.000Z') }, 'EXPIRED'],
    [{ expiresAt: new Date('2026-08-31T00:00:00.000Z') }, 'EXPIRED'],
    [{ batchState: 'RECALLED' }, 'RECALLED'],
    [{ batchState: 'QUARANTINED' }, 'QUARANTINED'],
    [{ disposition: 'QUARANTINE' }, 'QUARANTINED'],
    [{ disposition: 'DAMAGED' }, 'DAMAGED'],
    [{ disposition: 'DESTROYED' }, 'DESTROYED'],
    [{ disposition: 'IN_TRANSIT' }, 'IN_TRANSIT'],
    [{ receivedAt: null }, 'UNRECEIVED'],
    [{ receivedAt: new Date('2026-12-01T00:00:00.000Z') }, 'UNRECEIVED'],
    [{ organizationId: 'org_b' }, 'UNAUTHORIZED'],
    [{ branchId: 'branch_b' }, 'UNAUTHORIZED'],
    [{ availableUnits: 0 }, 'EMPTY'],
  ];

  it.each(blockedStates)('refuses %j with the reason %s', (overrides, reason) => {
    expect(blockReasonFor(candidate(overrides), SCOPE)).toBe(reason);
  });

  it('clears only stock that is positively safe on every axis', () => {
    expect(blockReasonFor(candidate(), SCOPE)).toBeNull();
  });

  it('fails closed on a state it does not recognise', () => {
    expect(blockReasonFor(candidate({ batchState: 'WITHDRAWN' as BatchState }), SCOPE)).toBe(
      'UNAUTHORIZED'
    );
    expect(blockReasonFor(candidate({ disposition: 'RESERVED' as StockDisposition }), SCOPE)).toBe(
      'UNAUTHORIZED'
    );
  });

  it('never allocates blocked stock, and reports why it could not', () => {
    expect(() =>
      planAllocation({
        candidates: [
          candidate({ inventoryLotId: 'lot_recalled', batchState: 'RECALLED' }),
          candidate({ inventoryLotId: 'lot_expired', expiresAt: new Date('2020-01-01') }),
        ],
        requiredUnits: 1,
        scope: SCOPE,
      })
    ).toThrow(new PharmacyInventoryError('INSUFFICIENT_STOCK'));
  });

  it('refuses a cross-branch lot even when the tenant matches', () => {
    expect(() =>
      planAllocation({
        candidates: [candidate({ inventoryLotId: 'lot_other_branch', branchId: 'branch_b' })],
        requiredUnits: 1,
        scope: SCOPE,
      })
    ).toThrow(new PharmacyInventoryError('INSUFFICIENT_STOCK'));
  });
});

// ── INV-02 / §8A invariants 3 and 5 — FEFO and override evidence ─────────────

describe('FEFO allocation (INV-02)', () => {
  const near = candidate({
    inventoryLotId: 'lot_near',
    expiresAt: new Date('2026-10-01T00:00:00.000Z'),
    availableUnits: 4,
  });
  const far = candidate({
    inventoryLotId: 'lot_far',
    expiresAt: new Date('2027-10-01T00:00:00.000Z'),
    availableUnits: 40,
  });

  it('draws the earliest safe expiry first and totals the quantity exactly', () => {
    const plan = planAllocation({ candidates: [far, near], requiredUnits: 10, scope: SCOPE });
    expect(plan.recommendedLotId).toBe('lot_near');
    expect(plan.allocations).toEqual([
      { inventoryLotId: 'lot_near', stockLocationId: 'loc_1', units: 4 },
      { inventoryLotId: 'lot_far', stockLocationId: 'loc_1', units: 6 },
    ]);
    expect(plan.allocations.reduce((total, one) => total + one.units, 0)).toBe(10);
  });

  it('skips a nearer expiry that is blocked and recommends the next safe one', () => {
    const recalled = candidate({
      inventoryLotId: 'lot_recalled',
      expiresAt: new Date('2026-09-10T00:00:00.000Z'),
      batchState: 'RECALLED',
    });
    const plan = planAllocation({
      candidates: [recalled, near, far],
      requiredUnits: 2,
      scope: SCOPE,
    });
    expect(plan.recommendedLotId).toBe('lot_near');
    expect(plan.blocked).toEqual([
      { inventoryLotId: 'lot_recalled', stockLocationId: 'loc_1', reason: 'RECALLED' },
    ]);
  });

  it('orders two lots sharing an expiry deterministically', () => {
    const a = candidate({ inventoryLotId: 'lot_b', availableUnits: 1 });
    const b = candidate({ inventoryLotId: 'lot_a', availableUnits: 1 });
    // Identical expiry and receipt: the lot id breaks the tie, so the
    // "recommended batch" an override records is reproducible.
    expect(
      planAllocation({ candidates: [a, b], requiredUnits: 1, scope: SCOPE }).recommendedLotId
    ).toBe('lot_a');
    expect(
      planAllocation({ candidates: [b, a], requiredUnits: 1, scope: SCOPE }).recommendedLotId
    ).toBe('lot_a');
  });

  it('allocates nothing at all when the total cannot be met (§8A invariant 3)', () => {
    expect(() => planAllocation({ candidates: [near], requiredUnits: 5, scope: SCOPE })).toThrow(
      new PharmacyInventoryError('INSUFFICIENT_STOCK')
    );
  });

  it('refuses a zero or fractional quantity', () => {
    for (const bad of [0, -3, 2.5]) {
      expect(() => planAllocation({ candidates: [far], requiredUnits: bad, scope: SCOPE })).toThrow(
        new PharmacyInventoryError('INVALID_QUANTITY')
      );
    }
  });

  describe('override (§8A invariant 5)', () => {
    const evidence = {
      actorId: 'user_pharmacist',
      reason: 'Customer requires the longer-dated pack for travel.',
      approvalPolicy: 'PHARMACIST_ON_DUTY',
    };

    it('records actor, reason, policy, recommended and selected batch', () => {
      const plan = planAllocation({
        candidates: [near, far],
        requiredUnits: 5,
        scope: SCOPE,
        select: { inventoryLotId: 'lot_far', ...evidence },
      });
      expect(plan.override).toEqual({
        ...evidence,
        recommendedLotId: 'lot_near',
        selectedLotId: 'lot_far',
      });
      expect(plan.allocations[0]).toEqual({
        inventoryLotId: 'lot_far',
        stockLocationId: 'loc_1',
        units: 5,
      });
    });

    it('is not an override when the selection IS the recommendation', () => {
      const plan = planAllocation({
        candidates: [near, far],
        requiredUnits: 2,
        scope: SCOPE,
        select: { inventoryLotId: 'lot_near', ...evidence },
      });
      expect(plan.override).toBeNull();
    });

    it('falls back to FEFO for the remainder the selected lot cannot cover', () => {
      const plan = planAllocation({
        candidates: [near, far],
        requiredUnits: 6,
        scope: SCOPE,
        select: { inventoryLotId: 'lot_near', ...evidence },
      });
      expect(plan.allocations).toEqual([
        { inventoryLotId: 'lot_near', stockLocationId: 'loc_1', units: 4 },
        { inventoryLotId: 'lot_far', stockLocationId: 'loc_1', units: 2 },
      ]);
    });

    it('refuses an override with missing evidence', () => {
      for (const gap of [{ actorId: '  ' }, { reason: '' }, { approvalPolicy: '   ' }]) {
        expect(() =>
          planAllocation({
            candidates: [near, far],
            requiredUnits: 1,
            scope: SCOPE,
            select: { inventoryLotId: 'lot_far', ...evidence, ...gap },
          })
        ).toThrow(new PharmacyInventoryError('OVERRIDE_EVIDENCE_MISSING'));
      }
    });

    it('cannot unblock hard-blocked stock (INV-03 is not overridable)', () => {
      const recalled = candidate({ inventoryLotId: 'lot_recalled', batchState: 'RECALLED' });
      expect(() =>
        planAllocation({
          candidates: [near, recalled],
          requiredUnits: 1,
          scope: SCOPE,
          select: { inventoryLotId: 'lot_recalled', ...evidence },
        })
      ).toThrow(new PharmacyInventoryError('BLOCKED_STOCK'));
    });

    it('refuses a selected lot that is not a candidate at all', () => {
      expect(() =>
        planAllocation({
          candidates: [near],
          requiredUnits: 1,
          scope: SCOPE,
          select: { inventoryLotId: 'lot_from_another_tenant', ...evidence },
        })
      ).toThrow(new PharmacyInventoryError('NOT_FOUND'));
    });
  });
});
