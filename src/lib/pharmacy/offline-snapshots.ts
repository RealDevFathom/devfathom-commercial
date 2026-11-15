import 'server-only';

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import type { PharmacyOfflineSnapshotKind } from './offline-action-matrix';
import { canonicalJson, envelopeSigningInput } from './offline-snapshot-envelope';
import type { OfflineSnapshotEnvelope } from './offline-snapshot-envelope';
import { validSafetyLeaseShape } from './offline-safety-lease';
import type { OfflineSafetyLease } from './offline-safety-lease';

/**
 * PH-OFF / OFF-01 — minting the signed snapshots a counter carries offline.
 *
 * SIGNATURES ARE ASYMMETRIC, on purpose. A shared MAC would force every enrolled
 * counter to hold the signing secret, which makes "the counter verified the
 * snapshot" mean nothing (a compromised counter could mint its own prices or its
 * own licence state). Ed25519 lets the server keep the private half and the
 * counter hold only the public half — which is not a secret, so it may sit in
 * the local store the storage-minimization denylist governs.
 *
 * THE KEY IS DERIVED, NOT CONFIGURED. It comes from the deployment's existing
 * `PLATFORM_ENCRYPTION_KEY` through a domain-separated SHA-256, so this lane adds
 * no new secret to provision and two processes of the same deployment always
 * agree. `SNAPSHOT_SIGNING_KEY_ID` is recorded on every row, so a future rotation
 * can add a second key without making the already-issued envelopes unverifiable.
 *
 * The signer never touches the payload: it signs the ENVELOPE, which carries the
 * payload's hash, the scope and the validity window (see
 * `offline-snapshot-envelope.ts` for why).
 */

export const SNAPSHOT_SIGNING_KEY_ID = 'ph-off-ed25519-v1';

/** Domain separation: this key must not coincide with any other use of the
 * platform key, so the derivation mixes in a label unique to this purpose. */
const SNAPSHOT_KEY_LABEL = 'devfathom:pharmacy-offline-snapshot:v1';

/** RFC 8410 PKCS#8 prefix for a raw 32-byte Ed25519 seed. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
/** RFC 8410 SPKI prefix for a raw 32-byte Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class PharmacySnapshotError extends Error {
  constructor(
    readonly reason:
      'SIGNING_KEY_UNAVAILABLE' | 'INVALID_PUBLIC_KEY' | 'INVALID_WINDOW' | 'DEVICE_NOT_USABLE'
  ) {
    super(reason);
    this.name = 'PharmacySnapshotError';
  }
}

function seed(): Buffer {
  const raw = process.env.PLATFORM_ENCRYPTION_KEY?.trim();
  if (!raw) throw new PharmacySnapshotError('SIGNING_KEY_UNAVAILABLE');
  return createHash('sha256').update(SNAPSHOT_KEY_LABEL).update(raw).digest();
}

/** The private half. Never leaves the server and is never persisted. */
function privateKey(): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed()]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** The public half as raw 32 bytes, base64url. Safe to hand to a counter. */
export function snapshotPublicKey(): string {
  const spki = createPublicKey(privateKey()).export({ format: 'der', type: 'spki' });
  return Buffer.from(spki.subarray(ED25519_SPKI_PREFIX.length)).toString('base64url');
}

/** Lowercase SHA-256 hex of the canonical payload — what the envelope binds. */
export function snapshotPayloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function signSnapshotEnvelope(envelope: OfflineSnapshotEnvelope): string {
  return sign(null, Buffer.from(envelopeSigningInput(envelope), 'utf8'), privateKey()).toString(
    'base64url'
  );
}

/**
 * Verify one envelope's signature against a raw base64url Ed25519 public key.
 * This is the Node implementation of the `SnapshotVerifier` seam; a browser
 * surface supplies a WebCrypto one. Returns false rather than throwing for a bad
 * signature — an unverifiable snapshot is an ordinary refusal, not an exception.
 */
export function verifySnapshotSignature(
  envelope: OfflineSnapshotEnvelope,
  signature: string,
  publicKeyBase64Url: string = snapshotPublicKey()
): boolean {
  let key: KeyObject;
  try {
    key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyBase64Url, 'base64url')]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    throw new PharmacySnapshotError('INVALID_PUBLIC_KEY');
  }
  try {
    return verify(
      null,
      Buffer.from(envelopeSigningInput(envelope), 'utf8'),
      key,
      Buffer.from(signature, 'base64url')
    );
  } catch {
    return false;
  }
}

// ── Issuing ──────────────────────────────────────────────────────────────────

export type SnapshotScope = {
  organizationId: string;
  branchId: string;
  actorId: string;
};

export type IssueSnapshotInput = {
  deviceId: string;
  kind: PharmacyOfflineSnapshotKind;
  payload: unknown;
  /** SERVER instants. The window is signed, so a counter cannot widen it. */
  issuedAt: Date;
  expiresAt: Date;
  safetyLease?: OfflineSafetyLease;
};

export type IssuedSnapshot = {
  id: string;
  envelope: OfflineSnapshotEnvelope;
  signature: string;
  payload: unknown;
};

/**
 * Mint the next version of one snapshot kind for one counter and record it.
 *
 * The version is derived from the current maximum for (device, kind) and guarded
 * by the unique index behind it: two concurrent issues collide on the index and
 * the loser's transaction rolls back, so the log never gains two rows claiming
 * the same version. Snapshots are append-only — a refresh is a NEW version, so a
 * device can always say which envelope it verified.
 *
 * Refuses a revoked device: a counter that may not act must not be handed fresh
 * prices, licence state or lot balances to act on.
 */
export async function issueOfflineSnapshot(
  db: ScopedDb,
  scope: SnapshotScope,
  input: IssueSnapshotInput
): Promise<IssuedSnapshot> {
  const safetyLease = input.safetyLease ?? {
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
    recallVersion: 0,
    licenceVersion: 0,
    ruleVersion: 0,
    recalledBatchIds: [],
  };
  if (
    input.expiresAt.getTime() <= input.issuedAt.getTime() ||
    !validSafetyLeaseShape(safetyLease) ||
    safetyLease.issuedAt !== input.issuedAt.toISOString() ||
    Date.parse(safetyLease.expiresAt) > input.expiresAt.getTime()
  ) {
    throw new PharmacySnapshotError('INVALID_WINDOW');
  }

  const device = await db.pharmacyRegisteredDevice.findFirst({
    where: {
      id: input.deviceId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
    select: { id: true, status: true, revokedAt: true },
  });
  if (!device || device.status !== 'ACTIVE' || device.revokedAt !== null) {
    throw new PharmacySnapshotError('DEVICE_NOT_USABLE');
  }

  const latest = await db.pharmacyOfflineSnapshot.findFirst({
    where: {
      organizationId: scope.organizationId,
      deviceId: input.deviceId,
      kind: input.kind,
    },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const version = (latest?.version ?? 0) + 1;

  const envelope: OfflineSnapshotEnvelope = {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    deviceId: input.deviceId,
    kind: input.kind,
    version,
    payloadHash: snapshotPayloadHash(input.payload),
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
    safetyLease,
    signingKeyId: SNAPSHOT_SIGNING_KEY_ID,
  };
  const signature = signSnapshotEnvelope(envelope);

  const row = await db.pharmacyOfflineSnapshot.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      deviceId: input.deviceId,
      kind: input.kind,
      version,
      payloadHash: envelope.payloadHash,
      signature,
      signingKeyId: SNAPSHOT_SIGNING_KEY_ID,
      issuedByActorId: scope.actorId,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    },
    select: { id: true },
  });

  return { id: row.id, envelope, signature, payload: input.payload };
}

/** The newest snapshot of each kind this counter has been issued. */
export async function latestSnapshotVersions(
  db: ScopedDb,
  scope: Pick<SnapshotScope, 'organizationId'>,
  deviceId: string
): Promise<Record<string, number>> {
  const rows = await db.pharmacyOfflineSnapshot.findMany({
    where: { organizationId: scope.organizationId, deviceId },
    orderBy: [{ kind: 'asc' }, { version: 'desc' }],
    select: { kind: true, version: true },
  });
  const latest: Record<string, number> = {};
  for (const row of rows) latest[row.kind] ??= row.version;
  return latest;
}
