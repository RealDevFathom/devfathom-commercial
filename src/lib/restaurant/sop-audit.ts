import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * WHA-226 / §11.5 — immutable SOP audit history for one occurrence.
 *
 * ## Immutable by construction, not by convention
 *
 * This module adds no table and writes nothing. The history is a deterministic
 * fold over the four sources that already record what happened to an occurrence,
 * three of which the database itself holds append-only (SELECT+INSERT RLS
 * policies, no `updatedAt`):
 *
 *   restaurant_sop_occurrence_steps   step completion (actor + instant)
 *   restaurant_sop_evidence           proof capture           [append-only]
 *   restaurant_sop_verifications      verify / reject / waive [append-only]
 *   restaurant_sop_escalation_events  fired / acked / stopped [append-only]
 *
 * Deriving the trail rather than duplicating it into a fifth table is what makes
 * it trustworthy: there is no second copy to drift from the records that drove
 * the occurrence's status, and no writer that could rewrite history after the
 * fact. Occurrence steps are the one mutable source (a step can be completed,
 * and `updatedAt` moves), so the entry carries `completedAt` — the recorded
 * instant of the act — rather than the row's mutation time.
 *
 * ## Total ordering
 *
 * Entries sort by `at` ascending. Ties are broken by a fixed rank over kinds and
 * then by entry id, so two events sharing a timestamp — routine, since a
 * verification and a status change are written in one transaction with the same
 * `now` — always come back in the same order. Without the tie-break the trail
 * would reshuffle between reads and could not be cited.
 *
 * ## Actor, action, proof, claim
 *
 * Every entry carries the acting operator (nullable — system-fired escalations
 * have none, and step completion attribution is best-effort), the action, and
 * where applicable a reference to its proof: the evidence `contentHash` and
 * `storageRef` for a capture, the co-authorization id for a waiver, the
 * escalation step for a fired event.
 *
 * `claimRef` is present on every entry and is currently always null. The claim
 * model — role-pool assignment and the claiming operator — is not on the schema
 * at this base: `RestaurantSopAssignment` has no assignee or pool column and
 * `RestaurantSopOccurrence` has no claim column. Rather than invent a reference
 * that resolves to nothing, the field is the declared seam, and attribution for
 * pool work runs through the completing operator on each step (see
 * `sop-score.ts`). When the claim model lands, populate this field; nothing else
 * in the shape has to change.
 */

export type SopAuditAction =
  | 'STEP_COMPLETED'
  | 'EVIDENCE_CAPTURED'
  | 'ESCALATION_FIRED'
  | 'ESCALATION_ACKNOWLEDGED'
  | 'ESCALATION_STOPPED'
  | 'VERIFIED'
  | 'REJECTED'
  | 'WAIVED';

/**
 * Tie-break rank for entries sharing an instant. Ordered as the acts logically
 * occur: work, then its proof, then escalation traffic, then the decision that
 * closes the occurrence.
 */
const ACTION_RANK: Record<SopAuditAction, number> = {
  STEP_COMPLETED: 0,
  EVIDENCE_CAPTURED: 1,
  ESCALATION_FIRED: 2,
  ESCALATION_ACKNOWLEDGED: 3,
  ESCALATION_STOPPED: 4,
  VERIFIED: 5,
  REJECTED: 5,
  WAIVED: 5,
};

/** A reference to the proof backing an entry, when the action produced one. */
export type SopAuditProofRef =
  | { kind: 'EVIDENCE'; evidenceId: string; contentHash: string; storageRef: string | null }
  | { kind: 'CO_AUTHORIZATION'; coAuthorizationId: string }
  | { kind: 'ESCALATION_STEP'; escalationStepId: string; stepOrder: number | null }
  | null;

export type SopAuditEntry = {
  /** Stable id of the underlying immutable row. */
  id: string;
  occurrenceId: string;
  action: SopAuditAction;
  /** The recorded instant of the act itself. */
  at: Date;
  actorStaffProfileId: string | null;
  actorName: string | null;
  /** Proof or authorization backing this entry, when there is one. */
  proofRef: SopAuditProofRef;
  /**
   * Reference to the pool claim this act was performed under. Always null at
   * this base — see the module note; the claim model is not on the schema.
   */
  claimRef: null;
  /** Human-readable one-line summary. Never contains secrets or payloads. */
  detail: string | null;
};

/** Total order: instant, then action rank, then id. */
function compareEntries(a: SopAuditEntry, b: SopAuditEntry): number {
  const at = a.at.getTime() - b.at.getTime();
  if (at !== 0) return at;
  const rank = ACTION_RANK[a.action] - ACTION_RANK[b.action];
  if (rank !== 0) return rank;
  return a.id.localeCompare(b.id);
}

/** Sort a set of entries into the canonical, reproducible order. */
export function orderAuditEntries(entries: readonly SopAuditEntry[]): SopAuditEntry[] {
  return [...entries].sort(compareEntries);
}

const VERIFICATION_ACTION: Record<string, SopAuditAction> = {
  VERIFY: 'VERIFIED',
  REJECT: 'REJECTED',
  WAIVE: 'WAIVED',
};

const ESCALATION_ACTION: Record<string, SopAuditAction> = {
  FIRED: 'ESCALATION_FIRED',
  ACKNOWLEDGED: 'ESCALATION_ACKNOWLEDGED',
  STOPPED: 'ESCALATION_STOPPED',
};

export type SopAuditSources = {
  steps: {
    id: string;
    completed: boolean;
    completedAt: Date | null;
    completedByStaffProfileId: string | null;
    completedBy: { displayName: string } | null;
    templateStep: { title: string | null } | null;
  }[];
  evidence: {
    id: string;
    contentHash: string;
    storageRef: string | null;
    mimeType: string;
    capturedAt: Date;
    uploaderStaffProfileId: string | null;
    uploader: { displayName: string } | null;
  }[];
  verifications: {
    id: string;
    action: string;
    reason: string | null;
    createdAt: Date;
    coAuthorizationId: string | null;
    actorStaffProfileId: string | null;
    actor: { displayName: string } | null;
  }[];
  escalationEvents: {
    id: string;
    kind: string;
    detail: string | null;
    createdAt: Date;
    escalationStepId: string | null;
    escalationStep: { stepOrder: number } | null;
    actorStaffProfileId: string | null;
    actor: { displayName: string } | null;
  }[];
};

/**
 * Fold the append-only sources of one occurrence into an ordered trail. Pure —
 * given the same rows it always returns the same sequence.
 *
 * Only COMPLETED steps produce an entry, and only when a completion instant was
 * recorded: an incomplete step is not an act that happened, and an entry with no
 * instant could not be placed in the order.
 */
export function buildAuditTrail(occurrenceId: string, sources: SopAuditSources): SopAuditEntry[] {
  const entries: SopAuditEntry[] = [];

  for (const step of sources.steps) {
    if (!step.completed || !step.completedAt) continue;
    entries.push({
      id: step.id,
      occurrenceId,
      action: 'STEP_COMPLETED',
      at: step.completedAt,
      actorStaffProfileId: step.completedByStaffProfileId,
      actorName: step.completedBy?.displayName ?? null,
      proofRef: null,
      claimRef: null,
      detail: step.templateStep?.title
        ? `Completed step: ${step.templateStep.title}`
        : 'Completed a step',
    });
  }

  for (const ev of sources.evidence) {
    entries.push({
      id: ev.id,
      occurrenceId,
      action: 'EVIDENCE_CAPTURED',
      at: ev.capturedAt,
      actorStaffProfileId: ev.uploaderStaffProfileId,
      actorName: ev.uploader?.displayName ?? null,
      proofRef: {
        kind: 'EVIDENCE',
        evidenceId: ev.id,
        contentHash: ev.contentHash,
        storageRef: ev.storageRef,
      },
      claimRef: null,
      // The mime type is a shape, not content — safe to surface. The blob itself
      // is never read here.
      detail: `Captured ${ev.mimeType} evidence`,
    });
  }

  for (const v of sources.verifications) {
    const action = VERIFICATION_ACTION[v.action];
    if (!action) continue;
    entries.push({
      id: v.id,
      occurrenceId,
      action,
      at: v.createdAt,
      actorStaffProfileId: v.actorStaffProfileId,
      actorName: v.actor?.displayName ?? null,
      proofRef: v.coAuthorizationId
        ? { kind: 'CO_AUTHORIZATION', coAuthorizationId: v.coAuthorizationId }
        : null,
      claimRef: null,
      detail: v.reason,
    });
  }

  for (const e of sources.escalationEvents) {
    const action = ESCALATION_ACTION[e.kind];
    if (!action) continue;
    entries.push({
      id: e.id,
      occurrenceId,
      action,
      at: e.createdAt,
      actorStaffProfileId: e.actorStaffProfileId,
      actorName: e.actor?.displayName ?? null,
      proofRef: e.escalationStepId
        ? {
            kind: 'ESCALATION_STEP',
            escalationStepId: e.escalationStepId,
            stepOrder: e.escalationStep?.stepOrder ?? null,
          }
        : null,
      claimRef: null,
      detail: e.detail,
    });
  }

  return orderAuditEntries(entries);
}

/**
 * Read the immutable audit history for one occurrence.
 *
 * `db` is tenant-bound under forced RLS, so an occurrence belonging to another
 * organization or an out-of-scope branch simply does not resolve — this returns
 * null rather than a partial trail (C1).
 */
export async function getOccurrenceAuditTrail(
  db: ScopedDb,
  occurrenceId: string
): Promise<SopAuditEntry[] | null> {
  const occ = await db.restaurantSopOccurrence.findUnique({
    where: { id: occurrenceId },
    select: {
      id: true,
      steps: {
        select: {
          id: true,
          completed: true,
          completedAt: true,
          completedByStaffProfileId: true,
          completedBy: { select: { displayName: true } },
          templateStep: { select: { title: true } },
        },
      },
      evidence: {
        select: {
          id: true,
          contentHash: true,
          storageRef: true,
          mimeType: true,
          capturedAt: true,
          uploaderStaffProfileId: true,
          uploader: { select: { displayName: true } },
        },
      },
      verifications: {
        select: {
          id: true,
          action: true,
          reason: true,
          createdAt: true,
          coAuthorizationId: true,
          actorStaffProfileId: true,
          actor: { select: { displayName: true } },
        },
      },
      escalationEvents: {
        select: {
          id: true,
          kind: true,
          detail: true,
          createdAt: true,
          escalationStepId: true,
          escalationStep: { select: { stepOrder: true } },
          actorStaffProfileId: true,
          actor: { select: { displayName: true } },
        },
      },
    },
  });
  if (!occ) return null;

  return buildAuditTrail(occ.id, occ);
}
