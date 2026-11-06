/**
 * PH-OFF / OFF-02 — the offline action matrix.
 *
 * PRD §6.9 OFF-02 names the matrix explicitly (allowed: search/scan, cash OTC
 * sale, khata within the cached limit, permitted refunds, provisional close;
 * denied: controlled medicines by default, catalog/price/rule changes,
 * unverified prescriptions) and its acceptance is "every row of the matrix has a
 * test". So the matrix is a TABLE, here, in one place — not a scatter of `if`
 * statements across the counter surface. `OFFLINE_ACTION_MATRIX` is that table
 * and `decideOfflineAction` is the only reader of it.
 *
 * Two properties make the table trustworthy rather than decorative:
 *
 *  - It is EXHAUSTIVE over `PharmacyOfflineAction`. The generated Prisma enum is
 *    the database half of the same list, and `offline-action-matrix.test.ts`
 *    asserts the two are the same set — a new action cannot reach the command log
 *    without a row here deciding it.
 *  - It FAILS CLOSED. An action the table does not allow is denied; an allowed
 *    action whose preconditions cannot be evaluated (a missing or expired
 *    snapshot, an unknown quota) is denied too. Nothing is permitted because a
 *    check could not be run.
 *
 * CLIENT-SAFE and PURE: no fetch, no clock, no storage. `now` and the cached
 * state are arguments, so every row is decidable in a unit test.
 *
 * Denial here is a LOCAL refusal at the counter. It is not the server's
 * authorization decision, which still runs on replay — a device that somehow
 * queued a denied command is refused again at the command log.
 */

/** The actions the matrix decides. Mirrors the `PharmacyOfflineAction` enum. */
export type PharmacyOfflineAction =
  | 'SEARCH_CATALOG'
  | 'SCAN_BARCODE'
  | 'CASH_OTC_SALE'
  | 'MANUAL_OTC_SALE'
  | 'MANUAL_PAYMENT_HOLD'
  | 'KHATA_SALE_WITHIN_CACHED_LIMIT'
  | 'PERMITTED_REFUND'
  | 'PROVISIONAL_CLOSE'
  | 'CONTROLLED_MEDICINE_SALE'
  | 'CATALOG_CHANGE'
  | 'PRICE_CHANGE'
  | 'RULE_CHANGE'
  | 'UNVERIFIED_PRESCRIPTION_FILL';

/** The snapshot kinds a row may require. Mirrors `PharmacyOfflineSnapshotKind`. */
export type PharmacyOfflineSnapshotKind =
  'CATALOG' | 'PRICES' | 'TAX' | 'RULES' | 'LICENCE' | 'STAFF' | 'LOT_BALANCES' | 'CUSTOMER_CREDIT';

/** A precondition beyond a cached snapshot that an allowed row also requires. */
export type OfflineActionRequirement =
  'RECEIPT_NUMBER' | 'STOCK_QUOTA' | 'CACHED_CREDIT_LIMIT' | 'ORIGINAL_SALE';

export type OfflineActionRule = {
  action: PharmacyOfflineAction;
  allowedOffline: boolean;
  /** Snapshots that must be cached, signature-verified and unexpired. */
  requiresSnapshots: readonly PharmacyOfflineSnapshotKind[];
  requires: readonly OfflineActionRequirement[];
  /** Why the row reads the way it does. Surfaced to the operator on a denial. */
  rationale: string;
};

/**
 * OFF-02, one row per action. Ordered allowed-then-denied to match the PRD text.
 *
 * The controlled-medicine row is denied BY DEFAULT rather than absolutely: PRD
 * §6.9 says "controlled medicines by default", so a signed RULES snapshot that
 * carries an explicit jurisdiction permission can lift it. The lift is evaluated
 * in `decideOfflineAction` and requires a verified RULES snapshot — never a local
 * toggle.
 */
export const OFFLINE_ACTION_MATRIX: readonly OfflineActionRule[] = [
  {
    action: 'SEARCH_CATALOG',
    allowedOffline: true,
    requiresSnapshots: ['CATALOG'],
    requires: [],
    rationale: 'Search reads the cached catalogue and changes nothing.',
  },
  {
    action: 'SCAN_BARCODE',
    allowedOffline: true,
    requiresSnapshots: ['CATALOG'],
    requires: [],
    rationale: 'A scan resolves a barcode in the cached catalogue and changes nothing.',
  },
  {
    action: 'CASH_OTC_SALE',
    allowedOffline: true,
    requiresSnapshots: ['CATALOG', 'PRICES', 'TAX', 'RULES', 'LOT_BALANCES'],
    requires: ['RECEIPT_NUMBER', 'STOCK_QUOTA'],
    rationale:
      'An over-the-counter cash sale prices from the signed price and tax snapshots, draws a pre-allocated receipt number, and can only move stock this counter owns a quota for.',
  },
  {
    action: 'MANUAL_OTC_SALE',
    allowedOffline: false,
    requiresSnapshots: ['CATALOG', 'PRICES', 'TAX', 'RULES', 'LOT_BALANCES'],
    requires: ['RECEIPT_NUMBER', 'STOCK_QUOTA'],
    rationale:
      'Legacy manual-wallet finalization is unavailable. Keep funds pending and recover a server sale online before confirmation.',
  },
  {
    action: 'MANUAL_PAYMENT_HOLD',
    allowedOffline: true,
    requiresSnapshots: ['CATALOG', 'PRICES', 'TAX', 'RULES', 'LOT_BALANCES'],
    requires: [],
    rationale:
      'Hold the manual-wallet draft and evidence as pending. No receipt or stock is issued offline; online recovery creates a locked server sale for authorized review.',
  },
  {
    action: 'KHATA_SALE_WITHIN_CACHED_LIMIT',
    allowedOffline: true,
    requiresSnapshots: ['CATALOG', 'PRICES', 'TAX', 'RULES', 'LOT_BALANCES', 'CUSTOMER_CREDIT'],
    requires: ['RECEIPT_NUMBER', 'STOCK_QUOTA', 'CACHED_CREDIT_LIMIT'],
    rationale:
      'Credit is extended only up to the limit the signed customer-credit snapshot cached. Beyond it the counter cannot know the current balance and must refuse.',
  },
  {
    action: 'PERMITTED_REFUND',
    allowedOffline: true,
    requiresSnapshots: ['RULES'],
    requires: ['ORIGINAL_SALE'],
    rationale:
      'A refund the cached rules permit, against an original sale this counter can see. §8A invariant 9: a refund always references its original.',
  },
  {
    action: 'PROVISIONAL_CLOSE',
    allowedOffline: true,
    requiresSnapshots: ['RULES'],
    requires: [],
    rationale:
      'A close taken during an outage is provisional and is superseded by the reconciled close after replay. It is never final.',
  },
  {
    action: 'CONTROLLED_MEDICINE_SALE',
    allowedOffline: false,
    requiresSnapshots: ['RULES', 'LICENCE'],
    requires: [],
    rationale:
      'Denied by default: the controlled register must reconcile against a live ledger (§8A invariant 10) and licence state cannot be re-checked during an outage. A signed rules snapshot carrying an explicit jurisdiction permission may lift it.',
  },
  {
    action: 'CATALOG_CHANGE',
    allowedOffline: false,
    requiresSnapshots: [],
    requires: [],
    rationale:
      'Regulated product truth has provenance (§8A invariant 13). A counter cannot author it while disconnected.',
  },
  {
    action: 'PRICE_CHANGE',
    allowedOffline: false,
    requiresSnapshots: [],
    requires: [],
    rationale:
      'Prices derive from printed MRP and the approved rounding rule (§8A invariant 7). A counter never becomes a pricing authority.',
  },
  {
    action: 'RULE_CHANGE',
    allowedOffline: false,
    requiresSnapshots: [],
    requires: [],
    rationale: 'Rules are what the offline decision is made AGAINST; they cannot be edited by it.',
  },
  {
    action: 'UNVERIFIED_PRESCRIPTION_FILL',
    allowedOffline: false,
    requiresSnapshots: [],
    requires: [],
    rationale:
      'A fill cannot exceed remaining authorized quantity (§8A invariant 11) and an unverified prescription has no authorization to measure against.',
  },
];

const RULE_BY_ACTION = new Map(OFFLINE_ACTION_MATRIX.map((rule) => [rule.action, rule]));

export function offlineActionRule(action: PharmacyOfflineAction): OfflineActionRule | null {
  return RULE_BY_ACTION.get(action) ?? null;
}

// ── The decision ─────────────────────────────────────────────────────────────

/** One cached, signature-verified snapshot as the counter holds it. */
export type CachedSnapshotState = {
  kind: PharmacyOfflineSnapshotKind;
  /** Set only once the injected verifier has accepted the envelope. */
  verified: boolean;
  expiresAtMs: number;
};

export type OfflineActionContext = {
  /** Client-origin instant. Freshness is a local judgement; the server re-checks. */
  nowMs: number;
  snapshots: readonly CachedSnapshotState[];
  /** Receipt numbers still unissued in this device's leases. */
  receiptNumbersRemaining: number;
  /** Units of the requested (lot, location) bucket this device still owns. */
  quotaUnitsAvailable: number;
  /** Canonical base units the action would move. Zero for a non-stock action. */
  requestedUnits: number;
  /** Minor units this action would add to the customer's cached khata balance. */
  requestedCreditMinor: number;
  /** From the signed customer-credit snapshot, never from local input. */
  cachedCreditRemainingMinor: number;
  /** From the signed rules snapshot. PRD §6.9: controlled is denied BY DEFAULT. */
  controlledMedicinesPermittedOffline: boolean;
  /** True when the original sale is present locally or in the cached history. */
  originalSaleAvailable: boolean;
  /** The enrolled device is still trusted (a revoked device does nothing at all). */
  deviceUsable: boolean;
  /** OFF-04 applies only to medicine-bearing sale/dispense rows. */
  medicineSale?: boolean;
  safetyLeaseOk?: boolean;
  batchRecalled?: boolean;
};

export type OfflineDenialReason =
  | 'UNKNOWN_ACTION'
  | 'DEVICE_REVOKED'
  | 'DENIED_OFFLINE'
  | 'CONTROLLED_NOT_PERMITTED'
  | 'SNAPSHOT_MISSING'
  | 'SNAPSHOT_UNVERIFIED'
  | 'SNAPSHOT_EXPIRED'
  | 'SAFETY_LEASE_EXPIRED'
  | 'BATCH_RECALLED'
  | 'NO_RECEIPT_NUMBER'
  | 'QUOTA_EXCEEDED'
  | 'CREDIT_LIMIT_EXCEEDED'
  | 'ORIGINAL_SALE_UNAVAILABLE';

export type OfflineActionDecision =
  | { allowed: true; action: PharmacyOfflineAction; rule: OfflineActionRule }
  | {
      allowed: false;
      action: PharmacyOfflineAction;
      reason: OfflineDenialReason;
      message: string;
      /** The snapshot kind at fault, when the denial was a snapshot one. */
      snapshotKind: PharmacyOfflineSnapshotKind | null;
    };

function deny(
  action: PharmacyOfflineAction,
  reason: OfflineDenialReason,
  message: string,
  snapshotKind: PharmacyOfflineSnapshotKind | null = null
): OfflineActionDecision {
  return { allowed: false, action, reason, message, snapshotKind };
}

/**
 * Decide one action at a disconnected counter. The order of the checks is the
 * order of the guarantees: an untrusted device does nothing; a denied row is
 * denied whatever the cache says; and an allowed row still has to prove every
 * precondition before it may proceed.
 */
export function decideOfflineAction(
  action: PharmacyOfflineAction,
  context: OfflineActionContext
): OfflineActionDecision {
  const rule = offlineActionRule(action);
  if (!rule) {
    // An action with no row is not "probably fine": it is undecided, so refused.
    return deny(action, 'UNKNOWN_ACTION', 'This action has no offline rule and cannot be taken.');
  }
  if (!context.deviceUsable) {
    return deny(action, 'DEVICE_REVOKED', 'This counter has been revoked and can no longer act.');
  }

  const saleOrDispense =
    action === 'CASH_OTC_SALE' ||
    action === 'MANUAL_OTC_SALE' ||
    action === 'MANUAL_PAYMENT_HOLD' ||
    action === 'KHATA_SALE_WITHIN_CACHED_LIMIT' ||
    action === 'CONTROLLED_MEDICINE_SALE';
  if (saleOrDispense && context.medicineSale === true && context.safetyLeaseOk !== true) {
    return deny(
      action,
      'SAFETY_LEASE_EXPIRED',
      'Medicine sales are paused because this counter’s safety lease expired. Reconnect to refresh recalls, licence and rules.'
    );
  }
  if (saleOrDispense && context.medicineSale === true && context.batchRecalled === true) {
    return deny(
      action,
      'BATCH_RECALLED',
      'This batch is recalled and cannot be sold or dispensed.'
    );
  }

  if (!rule.allowedOffline) {
    const liftable =
      action === 'CONTROLLED_MEDICINE_SALE' && context.controlledMedicinesPermittedOffline;
    if (!liftable) {
      return deny(
        action,
        action === 'CONTROLLED_MEDICINE_SALE' ? 'CONTROLLED_NOT_PERMITTED' : 'DENIED_OFFLINE',
        rule.rationale
      );
    }
    // The lift is only as good as the snapshot that carried it, so the
    // requirements below still run.
  }

  for (const kind of rule.requiresSnapshots) {
    const snapshot = context.snapshots.find((candidate) => candidate.kind === kind);
    if (!snapshot) {
      return deny(
        action,
        'SNAPSHOT_MISSING',
        `This counter holds no ${kind} snapshot. Reconnect to refresh before continuing.`,
        kind
      );
    }
    if (!snapshot.verified) {
      return deny(
        action,
        'SNAPSHOT_UNVERIFIED',
        `The ${kind} snapshot failed signature verification and cannot be trusted.`,
        kind
      );
    }
    if (snapshot.expiresAtMs <= context.nowMs) {
      return deny(
        action,
        'SNAPSHOT_EXPIRED',
        `The ${kind} snapshot has expired. Reconnect to refresh before continuing.`,
        kind
      );
    }
  }

  for (const requirement of rule.requires) {
    if (requirement === 'RECEIPT_NUMBER' && context.receiptNumbersRemaining <= 0) {
      return deny(
        action,
        'NO_RECEIPT_NUMBER',
        'This counter has used every pre-allocated receipt number. Reconnect before selling again.'
      );
    }
    if (requirement === 'STOCK_QUOTA' && context.requestedUnits > context.quotaUnitsAvailable) {
      return deny(
        action,
        'QUOTA_EXCEEDED',
        'This counter does not own enough of this batch to sell offline. Another counter holds the remaining units.'
      );
    }
    if (
      requirement === 'CACHED_CREDIT_LIMIT' &&
      context.requestedCreditMinor > context.cachedCreditRemainingMinor
    ) {
      return deny(
        action,
        'CREDIT_LIMIT_EXCEEDED',
        'This sale exceeds the credit limit cached for this customer. Reconnect to confirm the current balance.'
      );
    }
    if (requirement === 'ORIGINAL_SALE' && !context.originalSaleAvailable) {
      return deny(
        action,
        'ORIGINAL_SALE_UNAVAILABLE',
        'The original sale is not available at this counter, so the refund cannot reference it.'
      );
    }
  }

  return { allowed: true, action, rule };
}
