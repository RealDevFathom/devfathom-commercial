import 'server-only';

import { can, subjectFromSession } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { pharmacySopRolesAt, pharmacySopVerifierRolesFor } from './sop-adapter';
import {
  classifyPharmacySopEvidenceName,
  type PharmacySopEvidenceIdentity,
} from './sop-evidence-mac';

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
 *
 * The MAC is no longer the authority. Every upload now also writes an
 * append-only, server-issued capture receipt (`pharmacy_sop_evidence_captures`)
 * keyed by the engine's evidence id; the receipt does not depend on any secret,
 * so rotating AUTH_SECRET never makes receipted proof look foreign. The MAC
 * stays on new blob names only as a transition aid: proof captured before
 * receipts existed is still recognised by its MAC under the current secret, and
 * the one-off `scripts/pharmacy-sop-legacy-capture-backfill.ts` turns verified
 * legacy names into receipts. Run that backfill BEFORE rotating AUTH_SECRET.
 */

export {
  PHARMACY_SOP_EVIDENCE_FILE_PREFIX,
  classifyPharmacySopEvidenceName,
  hasPharmacySopEvidenceName,
  isPharmacySopCapturedEvidence,
  pharmacySopEvidenceFilename,
  type PharmacySopEvidenceIdentity,
  type PharmacySopNameProvenance,
} from './sop-evidence-mac';

/**
 * Where one engine evidence row on a pharmacy occurrence came from.
 *
 * - `RECEIPT`     a capture receipt exists for exactly this row. Authoritative
 *                 and secret-independent.
 * - `LEGACY_HMAC` no receipt, but the blob name's MAC verifies for this row
 *                 under the current AUTH_SECRET. Accepted during the transition.
 * - `UNCONFIRMED` no receipt and a pharmacy-style name whose MAC does not
 *                 verify (for example after AUTH_SECRET rotated). The proof
 *                 exists; only its pharmacy capture cannot be confirmed.
 * - `FOREIGN`     no receipt and not a pharmacy-style name: attached outside
 *                 the pharmacy workspace.
 */
export type PharmacySopProvenance = 'RECEIPT' | 'LEGACY_HMAC' | 'UNCONFIRMED' | 'FOREIGN';

export type PharmacySopProvenanceRow = Omit<PharmacySopEvidenceIdentity, 'organizationId'> & {
  /** The engine evidence id. A row without one can only be classified by its name. */
  id?: string | null;
  storageRef: string | null;
};

/** Proof that counts as captured in the pharmacy workspace. */
export function isPharmacySopProof(provenance: PharmacySopProvenance): boolean {
  return provenance === 'RECEIPT' || provenance === 'LEGACY_HMAC';
}

/**
 * Classify evidence rows, in input order. One receipt read covers every row;
 * a receipt only counts when it matches its row's occurrence and content hash
 * (the receipt trigger enforces both, this is defence in depth).
 */
export async function resolvePharmacySopProvenance(
  db: Pick<ScopedDb, 'pharmacySopEvidenceCapture'>,
  organizationId: string,
  rows: readonly PharmacySopProvenanceRow[]
): Promise<PharmacySopProvenance[]> {
  const ids = [...new Set(rows.flatMap((row) => (row.id ? [row.id] : [])))];
  const receipts = ids.length
    ? await db.pharmacySopEvidenceCapture.findMany({
        where: { organizationId, evidenceId: { in: ids } },
        select: { evidenceId: true, occurrenceId: true, contentHash: true },
      })
    : [];
  const byEvidence = new Map(receipts.map((receipt) => [receipt.evidenceId, receipt]));
  return rows.map((row) => {
    const receipt = row.id ? byEvidence.get(row.id) : undefined;
    if (
      receipt &&
      receipt.occurrenceId === row.occurrenceId &&
      receipt.contentHash === row.contentHash
    ) {
      return 'RECEIPT';
    }
    return classifyPharmacySopEvidenceName(row, organizationId);
  });
}

/**
 * Write the capture receipt for one evidence row the pharmacy route just
 * attached (or re-resolved on a retry). Idempotent: a receipt that already
 * exists is left as it is, so a retry heals a missing receipt without ever
 * creating a second one. Every field comes from the server (the engine's
 * returned evidence id and the session actor), never from the request.
 */
export async function writePharmacySopUploadReceipt(
  db: Pick<ScopedDb, 'pharmacySopEvidenceCapture'>,
  receipt: {
    organizationId: string;
    pharmacyBranchId: string;
    occurrenceId: string;
    evidenceId: string;
    contentHash: string;
    capturedByStaffProfileId: string;
    capturedByUserId: string;
  }
): Promise<void> {
  await db.pharmacySopEvidenceCapture.createMany({
    data: [{ ...receipt, source: 'UPLOAD' }],
    skipDuplicates: true,
  });
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
