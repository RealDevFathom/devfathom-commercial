/**
 * PH-OFF / OFF-02 — "every row of the matrix has a test".
 *
 * That acceptance is taken literally: `matrixRowCoverage` below enumerates the
 * table and the final case asserts that this file named EVERY row, so adding a
 * row without a test fails here rather than shipping undecided. Each row gets
 * both directions where it has one — an allowed row proves it is allowed AND
 * proves the precondition that would deny it; a denied row proves the denial.
 */
import { describe, expect, it } from 'vitest';

import { PharmacyOfflineAction as PrismaOfflineAction } from '@/generated/prisma/enums';

import {
  OFFLINE_ACTION_MATRIX,
  decideOfflineAction,
  offlineActionRule,
} from './offline-action-matrix';
import type {
  CachedSnapshotState,
  OfflineActionContext,
  PharmacyOfflineAction,
  PharmacyOfflineSnapshotKind,
} from './offline-action-matrix';

const NOW = Date.parse('2026-09-02T09:00:00.000Z');

/** Every snapshot kind, cached, verified and in window. */
function freshSnapshots(): CachedSnapshotState[] {
  const kinds: PharmacyOfflineSnapshotKind[] = [
    'CATALOG',
    'PRICES',
    'TAX',
    'RULES',
    'LICENCE',
    'STAFF',
    'LOT_BALANCES',
    'CUSTOMER_CREDIT',
  ];
  return kinds.map((kind) => ({ kind, verified: true, expiresAtMs: NOW + 3_600_000 }));
}

/** A counter with everything it could need. Each case removes exactly one thing,
 * so a denial can only be caused by what that case took away. */
function context(overrides: Partial<OfflineActionContext> = {}): OfflineActionContext {
  return {
    nowMs: NOW,
    snapshots: freshSnapshots(),
    receiptNumbersRemaining: 50,
    quotaUnitsAvailable: 20,
    requestedUnits: 0,
    requestedCreditMinor: 0,
    cachedCreditRemainingMinor: 500_000,
    controlledMedicinesPermittedOffline: false,
    originalSaleAvailable: true,
    deviceUsable: true,
    ...overrides,
  };
}

/** Rows this file asserts on. The last case proves the list is the whole table. */
const covered = new Set<PharmacyOfflineAction>();
function decide(action: PharmacyOfflineAction, overrides: Partial<OfflineActionContext> = {}) {
  covered.add(action);
  return decideOfflineAction(action, context(overrides));
}

describe('PH-OFF OFF-02 — the offline action matrix is the database enum', () => {
  it('covers exactly the actions the command log can store', () => {
    const inCode = [...OFFLINE_ACTION_MATRIX.map((rule) => rule.action)].sort();
    const inDatabase = Object.values(PrismaOfflineAction).sort();
    // A new action reachable by the command log with no row here would be
    // undecided at the counter, so the two lists must be the same set.
    expect(inCode).toEqual(inDatabase);
  });

  it('has one rule per action and no duplicates', () => {
    const actions = OFFLINE_ACTION_MATRIX.map((rule) => rule.action);
    expect(new Set(actions).size).toBe(actions.length);
  });
});

describe('PH-OFF OFF-02 — allowed rows', () => {
  it('MANUAL_OTC_SALE: requires signed snapshots, a receipt lease, stock quota and safety lease', () => {
    expect(decide('MANUAL_OTC_SALE', { requestedUnits: 1 })).toMatchObject({ allowed: true });
    expect(decide('MANUAL_OTC_SALE', { receiptNumbersRemaining: 0 })).toMatchObject({ allowed: false, reason: 'NO_RECEIPT_NUMBER' });
    expect(decide('MANUAL_OTC_SALE', { requestedUnits: 21 })).toMatchObject({ allowed: false, reason: 'QUOTA_EXCEEDED' });
    expect(decide('MANUAL_OTC_SALE', { snapshots: [] })).toMatchObject({ allowed: false, reason: 'SNAPSHOT_MISSING' });
    expect(decide('MANUAL_OTC_SALE', { medicineSale: true, safetyLeaseOk: false })).toMatchObject({ allowed: false, reason: 'SAFETY_LEASE_EXPIRED' });
  });
  it('SEARCH_CATALOG: allowed against a cached catalogue', () => {
    expect(decide('SEARCH_CATALOG')).toMatchObject({ allowed: true });
  });

  it('SEARCH_CATALOG: denied with no catalogue cached', () => {
    expect(decide('SEARCH_CATALOG', { snapshots: [] })).toMatchObject({
      allowed: false,
      reason: 'SNAPSHOT_MISSING',
      snapshotKind: 'CATALOG',
    });
  });

  it('SCAN_BARCODE: allowed against a cached catalogue', () => {
    expect(decide('SCAN_BARCODE')).toMatchObject({ allowed: true });
  });

  it('SCAN_BARCODE: denied once the catalogue snapshot has expired', () => {
    const stale = freshSnapshots().map((snapshot) =>
      snapshot.kind === 'CATALOG' ? { ...snapshot, expiresAtMs: NOW - 1 } : snapshot
    );
    expect(decide('SCAN_BARCODE', { snapshots: stale })).toMatchObject({
      allowed: false,
      reason: 'SNAPSHOT_EXPIRED',
      snapshotKind: 'CATALOG',
    });
  });

  it('CASH_OTC_SALE: allowed with prices, tax, a receipt number and a quota', () => {
    expect(decide('CASH_OTC_SALE', { requestedUnits: 10 })).toMatchObject({ allowed: true });
  });

  it('CASH_OTC_SALE: denied when the pre-allocated receipt numbers are used up', () => {
    // §8A invariant 16: rather than inventing a number the counter refuses.
    expect(
      decide('CASH_OTC_SALE', { requestedUnits: 1, receiptNumbersRemaining: 0 })
    ).toMatchObject({ allowed: false, reason: 'NO_RECEIPT_NUMBER' });
  });

  it('CASH_OTC_SALE: denied beyond this counter’s OFF-03 quota', () => {
    expect(decide('CASH_OTC_SALE', { requestedUnits: 21, quotaUnitsAvailable: 20 })).toMatchObject({
      allowed: false,
      reason: 'QUOTA_EXCEEDED',
    });
  });

  it('CASH_OTC_SALE: denied when a required snapshot was never verified', () => {
    const unverified = freshSnapshots().map((snapshot) =>
      snapshot.kind === 'PRICES' ? { ...snapshot, verified: false } : snapshot
    );
    expect(decide('CASH_OTC_SALE', { requestedUnits: 1, snapshots: unverified })).toMatchObject({
      allowed: false,
      reason: 'SNAPSHOT_UNVERIFIED',
      snapshotKind: 'PRICES',
    });
  });

  it('KHATA_SALE_WITHIN_CACHED_LIMIT: allowed within the cached limit', () => {
    expect(
      decide('KHATA_SALE_WITHIN_CACHED_LIMIT', {
        requestedUnits: 2,
        requestedCreditMinor: 100_000,
        cachedCreditRemainingMinor: 100_000,
      })
    ).toMatchObject({ allowed: true });
  });

  it('KHATA_SALE_WITHIN_CACHED_LIMIT: denied one minor unit beyond it', () => {
    expect(
      decide('KHATA_SALE_WITHIN_CACHED_LIMIT', {
        requestedUnits: 2,
        requestedCreditMinor: 100_001,
        cachedCreditRemainingMinor: 100_000,
      })
    ).toMatchObject({ allowed: false, reason: 'CREDIT_LIMIT_EXCEEDED' });
  });

  it('KHATA_SALE_WITHIN_CACHED_LIMIT: denied with no cached customer credit', () => {
    const withoutCredit = freshSnapshots().filter(
      (snapshot) => snapshot.kind !== 'CUSTOMER_CREDIT'
    );
    expect(
      decide('KHATA_SALE_WITHIN_CACHED_LIMIT', { requestedUnits: 1, snapshots: withoutCredit })
    ).toMatchObject({
      allowed: false,
      reason: 'SNAPSHOT_MISSING',
      snapshotKind: 'CUSTOMER_CREDIT',
    });
  });

  it('PERMITTED_REFUND: allowed against an original sale the counter can see', () => {
    expect(decide('PERMITTED_REFUND')).toMatchObject({ allowed: true });
  });

  it('PERMITTED_REFUND: denied when the original sale is not available', () => {
    // §8A invariant 9: a refund always references its original.
    expect(decide('PERMITTED_REFUND', { originalSaleAvailable: false })).toMatchObject({
      allowed: false,
      reason: 'ORIGINAL_SALE_UNAVAILABLE',
    });
  });

  it('PROVISIONAL_CLOSE: allowed against cached rules', () => {
    expect(decide('PROVISIONAL_CLOSE')).toMatchObject({ allowed: true });
  });

  it('PROVISIONAL_CLOSE: denied with no rules snapshot to close against', () => {
    const withoutRules = freshSnapshots().filter((snapshot) => snapshot.kind !== 'RULES');
    expect(decide('PROVISIONAL_CLOSE', { snapshots: withoutRules })).toMatchObject({
      allowed: false,
      reason: 'SNAPSHOT_MISSING',
      snapshotKind: 'RULES',
    });
  });
});

describe('PH-OFF OFF-02 — denied rows', () => {
  it('CONTROLLED_MEDICINE_SALE: denied by default', () => {
    expect(decide('CONTROLLED_MEDICINE_SALE')).toMatchObject({
      allowed: false,
      reason: 'CONTROLLED_NOT_PERMITTED',
    });
  });

  it('CONTROLLED_MEDICINE_SALE: a signed rules permission lifts the default', () => {
    // PRD §6.9 says "by default", so the row is a default and not an absolute.
    expect(
      decide('CONTROLLED_MEDICINE_SALE', { controlledMedicinesPermittedOffline: true })
    ).toMatchObject({ allowed: true });
  });

  it('CONTROLLED_MEDICINE_SALE: the lift still needs a live licence snapshot', () => {
    const withoutLicence = freshSnapshots().filter((snapshot) => snapshot.kind !== 'LICENCE');
    expect(
      decide('CONTROLLED_MEDICINE_SALE', {
        controlledMedicinesPermittedOffline: true,
        snapshots: withoutLicence,
      })
    ).toMatchObject({ allowed: false, reason: 'SNAPSHOT_MISSING', snapshotKind: 'LICENCE' });
  });

  it('CATALOG_CHANGE: denied, and no cached state can permit it', () => {
    expect(decide('CATALOG_CHANGE')).toMatchObject({ allowed: false, reason: 'DENIED_OFFLINE' });
    expect(
      decideOfflineAction('CATALOG_CHANGE', context({ controlledMedicinesPermittedOffline: true }))
    ).toMatchObject({ allowed: false, reason: 'DENIED_OFFLINE' });
  });

  it('PRICE_CHANGE: denied — the counter is never a pricing authority', () => {
    expect(decide('PRICE_CHANGE')).toMatchObject({ allowed: false, reason: 'DENIED_OFFLINE' });
  });

  it('RULE_CHANGE: denied — rules are what the decision is made against', () => {
    expect(decide('RULE_CHANGE')).toMatchObject({ allowed: false, reason: 'DENIED_OFFLINE' });
  });

  it('UNVERIFIED_PRESCRIPTION_FILL: denied', () => {
    expect(decide('UNVERIFIED_PRESCRIPTION_FILL')).toMatchObject({
      allowed: false,
      reason: 'DENIED_OFFLINE',
    });
  });
});

describe('PH-OFF OFF-02 — the matrix fails closed', () => {
  it('refuses an action with no rule rather than assuming it is harmless', () => {
    const decision = decideOfflineAction('NOT_A_REAL_ACTION' as PharmacyOfflineAction, context());
    expect(decision).toMatchObject({ allowed: false, reason: 'UNKNOWN_ACTION' });
    expect(offlineActionRule('NOT_A_REAL_ACTION' as PharmacyOfflineAction)).toBeNull();
  });

  it('refuses every row, allowed or denied, on a revoked counter', () => {
    for (const rule of OFFLINE_ACTION_MATRIX) {
      expect(decideOfflineAction(rule.action, context({ deviceUsable: false }))).toMatchObject({
        allowed: false,
        reason: 'DEVICE_REVOKED',
      });
    }
  });

  it('has a test for EVERY row of the matrix (OFF-02 acceptance)', () => {
    const untested = OFFLINE_ACTION_MATRIX.map((rule) => rule.action).filter(
      (action) => !covered.has(action)
    );
    expect(untested).toEqual([]);
  });
});
