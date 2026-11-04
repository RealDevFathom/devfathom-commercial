import 'server-only';

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { can, subjectFromSession } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { pharmacySopRolesAt, pharmacySopVerifierRolesFor } from './sop-adapter';

/**
 * DEV-751 — provenance and read access for pharmacy SOP proof.
 *
 * The shared engine's evidence rows can be written through more than one door:
 * the pharmacy evidence route, but also the restaurant evidence route and the
 * restaurant `attachEvidence` procedure, which accept a caller-supplied
 * uploader and (for the procedure) a caller-supplied `storageRef`. Pharmacy
 * SOPs only trust proof captured through the pharmacy workspace, so the
 * pharmacy route names every blob `pharmacy-sop-<uuid>-<mac>.<ext>`, where the
 * MAC (keyed from AUTH_SECRET, purpose-bound) covers the tenant and every
 * identity field of the evidence row. A prefix alone could be copied into a
 * forged row; the MAC cannot be minted outside this server and does not verify
 * for any row other than the one it was minted for.
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

export type PharmacySopEvidenceReadDecision = 'NOT_PHARMACY' | 'ALLOW' | 'DENY';

/**
 * File-delivery authorisation for SOP evidence on a pharmacy SOP site. Mirrors
 * the router's occurrence visibility as far as a file read needs: the reader
 * must be actively assigned to the site's pharmacy branch, and then be a
 * manager (`sop:manage`), the occurrence's owner, claimer or the proof's
 * uploader (with `sop:complete` or `sop:verify`), or a holder of one of the
 * pack's verifier roles at the site with `sop:verify`.
 *
 * Returns NOT_PHARMACY when the occurrence's engine branch is not a pharmacy
 * SOP site, so the caller keeps its restaurant rule unchanged.
 */
export async function pharmacySopEvidenceReadDecision(
  db: ScopedDb,
  input: {
    organizationId: string;
    user: { id: string; role?: string | null; department?: string | null; status?: string | null };
    evidence: {
      uploaderStaffProfileId: string | null;
      occurrence: {
        branchId: string;
        templateVersionId: string;
        assignedStaffProfileId: string | null;
        claimedByStaffProfileId: string | null;
      };
    };
  }
): Promise<PharmacySopEvidenceReadDecision> {
  const { organizationId, user, evidence } = input;
  const occurrence = evidence.occurrence;
  const site = await db.pharmacySopSite.findFirst({
    where: { organizationId, sopBranchId: occurrence.branchId },
    select: { pharmacyBranchId: true },
  });
  if (!site) return 'NOT_PHARMACY';

  const assignment = await db.pharmacyBranchAssignment.findFirst({
    where: {
      organizationId,
      branchId: site.pharmacyBranchId,
      userId: user.id,
      active: true,
      user: { status: 'ACTIVE' },
    },
    select: { id: true },
  });
  if (!assignment) return 'DENY';

  const subject = subjectFromSession(user);
  const allowed = (action: 'sop:manage' | 'sop:verify' | 'sop:complete') =>
    can(subject, action, undefined, { db, source: 'TRPC' });
  if (await allowed('sop:manage')) return 'ALLOW';
  const [canVerify, canComplete] = [await allowed('sop:verify'), await allowed('sop:complete')];
  if (!canVerify && !canComplete) return 'DENY';

  const profiles = await db.restaurantStaffProfile.findMany({
    where: { organizationId, userId: user.id, status: 'ACTIVE' },
    select: { id: true },
    take: 2,
  });
  if (profiles.length !== 1) return 'DENY';
  const staffProfileId = profiles[0]!.id;
  if (
    occurrence.assignedStaffProfileId === staffProfileId ||
    occurrence.claimedByStaffProfileId === staffProfileId ||
    evidence.uploaderStaffProfileId === staffProfileId
  ) {
    return 'ALLOW';
  }
  if (!canVerify) return 'DENY';
  const [held, verifierRoles] = await Promise.all([
    pharmacySopRolesAt(db, { staffProfileId, sopBranchId: occurrence.branchId }),
    pharmacySopVerifierRolesFor(db, occurrence.templateVersionId),
  ]);
  return held.some((role) => verifierRoles.includes(role)) ? 'ALLOW' : 'DENY';
}
