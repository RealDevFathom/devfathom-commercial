import 'server-only';

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * DEV-751 — the legacy, secret-bound pharmacy SOP proof name.
 *
 * Pure (no database, no session): shared by the app (`sop-evidence.ts`) and the
 * manual legacy receipt backfill script. See `sop-evidence.ts` for why capture
 * receipts, not this MAC, are now the provenance authority.
 */

export const PHARMACY_SOP_EVIDENCE_FILE_PREFIX = 'pharmacy-sop-';

const VERSION = 'v1';
const KEY_PURPOSE = 'devfathom:pharmacy:sop-evidence-provenance:v1';
const MAC_HEX_LENGTH = 32;
const FILE_REF = new RegExp(
  `^/api/files/${PHARMACY_SOP_EVIDENCE_FILE_PREFIX}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9a-f]{${MAC_HEX_LENGTH}})\\.(jpg|png|webp)$`
);

export type PharmacySopEvidenceIdentity = {
  organizationId: string;
  occurrenceId: string;
  occurrenceStepId: string | null;
  contentHash: string;
  mimeType: string;
  uploaderStaffProfileId: string | null;
};

function provenanceKey(): Buffer | null {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) return null;
  return createHmac('sha256', secret).update(KEY_PURPOSE).digest();
}

function mac(key: Buffer, identity: PharmacySopEvidenceIdentity, uuid: string, extension: string) {
  return createHmac('sha256', key)
    .update(
      JSON.stringify([
        VERSION,
        identity.organizationId,
        identity.occurrenceId,
        identity.occurrenceStepId ?? null,
        identity.contentHash.trim().toLowerCase(),
        identity.mimeType,
        identity.uploaderStaffProfileId ?? null,
        uuid,
        extension,
      ])
    )
    .digest('hex')
    .slice(0, MAC_HEX_LENGTH);
}

/** The storage filename for one pharmacy proof upload. Throws without AUTH_SECRET. */
export function pharmacySopEvidenceFilename(
  identity: PharmacySopEvidenceIdentity,
  extension: 'jpg' | 'png' | 'webp'
): string {
  const key = provenanceKey();
  if (!key) throw new Error('AUTH_SECRET is required to capture pharmacy SOP proof.');
  const uuid = randomUUID();
  return `${PHARMACY_SOP_EVIDENCE_FILE_PREFIX}${uuid}-${mac(key, identity, uuid, extension)}.${extension}`;
}

/**
 * True only for an evidence row whose storageRef was minted by the pharmacy
 * evidence route for exactly this row. Fails closed (no secret, no ref, any
 * mismatch).
 */
export function isPharmacySopCapturedEvidence(
  row: Omit<PharmacySopEvidenceIdentity, 'organizationId'> & { storageRef: string | null },
  organizationId: string
): boolean {
  const match = row.storageRef ? FILE_REF.exec(row.storageRef) : null;
  const key = match ? provenanceKey() : null;
  if (!match || !key) return false;
  const [, uuid, supplied, extension] = match;
  const wanted = Buffer.from(mac(key, { ...row, organizationId }, uuid!, extension!), 'utf8');
  const actual = Buffer.from(supplied!, 'utf8');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/** Whether a storageRef has the exact shape the pharmacy route mints (MAC unchecked). */
export function hasPharmacySopEvidenceName(storageRef: string | null | undefined): boolean {
  return Boolean(storageRef && FILE_REF.test(storageRef));
}

/** How a row without a capture receipt reads by its blob name alone. */
export type PharmacySopNameProvenance = 'LEGACY_HMAC' | 'UNCONFIRMED' | 'FOREIGN';

/**
 * `LEGACY_HMAC` when the MAC verifies for this row under the current secret,
 * `UNCONFIRMED` for a pharmacy-shaped name whose MAC does not (or no secret is
 * set), `FOREIGN` for any other name.
 */
export function classifyPharmacySopEvidenceName(
  row: Omit<PharmacySopEvidenceIdentity, 'organizationId'> & { storageRef: string | null },
  organizationId: string
): PharmacySopNameProvenance {
  if (isPharmacySopCapturedEvidence(row, organizationId)) return 'LEGACY_HMAC';
  return hasPharmacySopEvidenceName(row.storageRef) ? 'UNCONFIRMED' : 'FOREIGN';
}
