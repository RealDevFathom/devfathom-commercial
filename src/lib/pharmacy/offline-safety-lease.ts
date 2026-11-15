/** PH-OFF / OFF-04 — client-safe safety-lease primitives. */

export type OfflineSafetyLease = {
  issuedAt: string;
  expiresAt: string;
  recallVersion: number;
  licenceVersion: number;
  ruleVersion: number;
  /** #519: inventory lot ids in this branch whose batch the server had recalled
   * when it issued the lease. Signed with the envelope, so a counter blocks them
   * offline and replay can prove what the counter knew. */
  recalledBatchIds: readonly string[];
};

export type OfflineRecallBulletin = {
  issuedAt: string;
  recallVersion: number;
  recalledBatchIds: readonly string[];
};

export type SafetyLeaseEvent = {
  type: 'ISSUED' | 'RENEWED' | 'EXPIRED' | 'RECALL_APPLIED';
  occurredAt: string;
  lease: OfflineSafetyLease;
  recallVersion: number;
  recalledBatchIds: readonly string[];
};

export type SafetyLeaseState = {
  lease: OfflineSafetyLease | null;
  appliedRecallVersion: number;
  recalledBatchIds: readonly string[];
};

export type SafetyLeaseCheck =
  | { ok: true }
  | { ok: false; reason: 'MISSING' | 'MALFORMED' | 'NOT_YET_VALID' | 'EXPIRED' | 'RECALL_STALE' };

export function validSafetyLeaseShape(lease: OfflineSafetyLease): boolean {
  const issuedAt = Date.parse(lease.issuedAt);
  const expiresAt = Date.parse(lease.expiresAt);
  return (
    Number.isFinite(issuedAt) &&
    Number.isFinite(expiresAt) &&
    expiresAt > issuedAt &&
    [lease.recallVersion, lease.licenceVersion, lease.ruleVersion].every(
      (version) => Number.isSafeInteger(version) && version >= 0
    ) &&
    // Fail closed: a lease without its recall set is not a safety lease.
    Array.isArray(lease.recalledBatchIds) &&
    lease.recalledBatchIds.every((id) => typeof id === 'string' && id.length > 0) &&
    new Set(lease.recalledBatchIds).size === lease.recalledBatchIds.length
  );
}

/** Client time never extends the server-signed window: the existing snapshot
 * rule is deliberately strict at both bounds. */
export function checkSafetyLease(state: SafetyLeaseState, nowMs: number): SafetyLeaseCheck {
  const lease = state.lease;
  if (!lease) return { ok: false, reason: 'MISSING' };
  if (!validSafetyLeaseShape(lease)) return { ok: false, reason: 'MALFORMED' };
  if (nowMs < Date.parse(lease.issuedAt)) return { ok: false, reason: 'NOT_YET_VALID' };
  if (nowMs >= Date.parse(lease.expiresAt)) return { ok: false, reason: 'EXPIRED' };
  if (state.appliedRecallVersion < lease.recallVersion)
    return { ok: false, reason: 'RECALL_STALE' };
  return { ok: true };
}

export function applyRecallBulletin(
  state: SafetyLeaseState,
  bulletin: OfflineRecallBulletin
): SafetyLeaseState | null {
  const issuedAt = Date.parse(bulletin.issuedAt);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isSafeInteger(bulletin.recallVersion) ||
    bulletin.recallVersion < state.appliedRecallVersion
  ) {
    return null;
  }
  return {
    ...state,
    appliedRecallVersion: bulletin.recallVersion,
    recalledBatchIds: [...new Set([...state.recalledBatchIds, ...bulletin.recalledBatchIds])],
  };
}
