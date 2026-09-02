/**
 * PH-OFF / OFF-01 — the signed-snapshot envelope.
 *
 * A snapshot is two things: a PAYLOAD (the cached catalogue, prices, tax, rules,
 * licence state, staff, lot balances or customer credit) and an ENVELOPE that
 * names the payload's hash and the scope and window it is valid for. Only the
 * envelope is signed. That is deliberate:
 *
 *  - the signature covers the SCOPE, so a snapshot minted for another counter,
 *    branch or tenant cannot be replayed into this one even if it verifies;
 *  - the signature covers the WINDOW, so a snapshot cannot be kept past the
 *    freshness the server granted it;
 *  - the signature covers the PAYLOAD HASH rather than the payload, so a large
 *    catalogue is verified by one fixed-size comparison.
 *
 * CLIENT-SAFE and PURE. Canonical serialization lives here so the signer and the
 * verifier cannot disagree about the bytes: JSON key order is not stable across
 * engines, and a signature over an unstable serialization is a signature over
 * nothing. The cryptography itself is NOT here — see `offline-snapshots.ts` for
 * the Node signer/verifier, and `SnapshotVerifier` in `counter-offline-runtime.ts`
 * for the seam a browser surface fills.
 */
import type { PharmacyOfflineSnapshotKind } from './offline-action-matrix';

export type OfflineSnapshotEnvelope = {
  organizationId: string;
  branchId: string;
  deviceId: string;
  kind: PharmacyOfflineSnapshotKind;
  /** Monotonic per (device, kind). A device never accepts a lower version. */
  version: number;
  /** Lowercase SHA-256 hex of the canonical payload. */
  payloadHash: string;
  /** SERVER instants, ISO-8601 UTC. Client time never widens this window. */
  issuedAt: string;
  expiresAt: string;
  signingKeyId: string;
};

/** The envelope fields in the order they are serialized for signing. Explicit
 * rather than derived, so adding a field to the type without deciding whether it
 * is signed is a compile error rather than a silent weakening. */
const SIGNED_FIELDS: readonly (keyof OfflineSnapshotEnvelope)[] = [
  'organizationId',
  'branchId',
  'deviceId',
  'kind',
  'version',
  'payloadHash',
  'issuedAt',
  'expiresAt',
  'signingKeyId',
];

/**
 * Deterministic JSON: object keys sorted, no whitespace, `undefined` dropped.
 * Two structurally equal values always produce the same string, on any engine.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
    return `{${entries.join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('A non-finite number cannot be canonically serialized.');
  }
  return JSON.stringify(value) ?? 'null';
}

/** The exact bytes a signature is taken over. */
export function envelopeSigningInput(envelope: OfflineSnapshotEnvelope): string {
  const projected: Record<string, unknown> = {};
  for (const field of SIGNED_FIELDS) projected[field] = envelope[field];
  return canonicalJson(projected);
}

export type EnvelopeScopeCheck = {
  organizationId: string;
  branchId: string;
  deviceId: string;
};

export type EnvelopeRejection =
  | 'SCOPE_MISMATCH'
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'STALE_VERSION'
  | 'PAYLOAD_MISMATCH'
  | 'MALFORMED';

/**
 * Everything about an envelope that can be judged WITHOUT the signing key: it is
 * addressed to this counter, its window covers `nowMs`, and it is not older than
 * the version already held. A verifier still has to accept the signature — this
 * is a precondition, never a substitute.
 *
 * `heldVersion` is the version this device already trusts for the same kind, or
 * null when it holds none. Equal is accepted (a re-delivery of the same
 * snapshot); lower is refused, so a replayed older envelope cannot roll a
 * counter back to stale prices or a stale licence state.
 */
export function checkEnvelope(input: {
  envelope: OfflineSnapshotEnvelope;
  scope: EnvelopeScopeCheck;
  nowMs: number;
  heldVersion: number | null;
  payloadHash: string;
}): { ok: true } | { ok: false; reason: EnvelopeRejection; message: string } {
  const { envelope, scope } = input;

  if (
    !Number.isSafeInteger(envelope.version) ||
    envelope.version < 1 ||
    !/^[0-9a-f]{64}$/.test(envelope.payloadHash)
  ) {
    return { ok: false, reason: 'MALFORMED', message: 'The snapshot envelope is malformed.' };
  }

  if (
    envelope.organizationId !== scope.organizationId ||
    envelope.branchId !== scope.branchId ||
    envelope.deviceId !== scope.deviceId
  ) {
    return {
      ok: false,
      reason: 'SCOPE_MISMATCH',
      message: 'This snapshot was issued to a different counter and will not be used here.',
    };
  }

  if (input.payloadHash !== envelope.payloadHash) {
    return {
      ok: false,
      reason: 'PAYLOAD_MISMATCH',
      message: 'The snapshot payload does not match the hash its signature covers.',
    };
  }

  const issuedAtMs = Date.parse(envelope.issuedAt);
  const expiresAtMs = Date.parse(envelope.expiresAt);
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= issuedAtMs) {
    return { ok: false, reason: 'MALFORMED', message: 'The snapshot validity window is invalid.' };
  }
  if (input.nowMs < issuedAtMs) {
    return {
      ok: false,
      reason: 'NOT_YET_VALID',
      message: 'This snapshot is not valid yet. Check the counter clock and reconnect.',
    };
  }
  if (input.nowMs >= expiresAtMs) {
    return {
      ok: false,
      reason: 'EXPIRED',
      message: 'This snapshot has expired. Reconnect to refresh it.',
    };
  }

  if (input.heldVersion !== null && envelope.version < input.heldVersion) {
    return {
      ok: false,
      reason: 'STALE_VERSION',
      message: 'A newer snapshot of this kind is already held; the older one is refused.',
    };
  }

  return { ok: true };
}
