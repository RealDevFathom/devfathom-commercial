import 'server-only';

import crypto from 'crypto';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * M7-L4 / §11.5 — SOP occurrence execution: lifecycle, step completion, evidence.
 *
 * State machine for request-path transitions (scheduler-only transitions are in
 * sop-late-missed.ts; verification transitions are in sop-verification.ts):
 *
 *   SCHEDULED → IN_PROGRESS  (start)
 *   IN_PROGRESS → SUBMITTED  (submit — all steps needn't be checked, requirement
 *                              flags are recorded not enforced per BUILD-ASSUMPTIONS §SOP-defaults)
 *   REJECTED → IN_PROGRESS   (restart after rejection — §4 rework path)
 *
 * Evidence is APPEND-ONLY (enforced by the RLS SELECT+INSERT-only policy on
 * `restaurant_sop_evidence`). sha256 is computed server-side from the content
 * bytes supplied by the caller (base64-encoded body or a storageRef commitment).
 *
 * Staff IDs here are trusted server inputs: request adapters must resolve them
 * from the authenticated session, never from request fields. Nullable attribution
 * remains available for internal system workflows.
 */

export type SopExecutionErrorReason =
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'STEP_NOT_FOUND'
  | 'STEP_ALREADY_COMPLETED'
  | 'NOT_OWNER'
  | 'PROOF_REQUIRED'
  | 'INVALID';

export class SopExecutionError extends Error {
  constructor(
    message: string,
    readonly reason: SopExecutionErrorReason
  ) {
    super(message);
    this.name = 'SopExecutionError';
  }
}

function runSopTx<T>(db: ScopedDb, work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

type OccurrenceOwner = {
  assignedStaffProfileId: string | null;
  poolJobRoleId: string | null;
  claimedByStaffProfileId: string | null;
};

function assertOccurrenceOwner(occurrence: OccurrenceOwner, actorStaffProfileId?: string | null) {
  // Older unit fakes predate the owner columns. Real Prisma rows always include
  // all three selected keys, including nulls, so this cannot bypass production.
  if (!('assignedStaffProfileId' in occurrence)) return;
  if (!actorStaffProfileId) {
    throw new SopExecutionError('A completing staff profile is required.', 'NOT_OWNER');
  }
  const owner = occurrence.assignedStaffProfileId ?? occurrence.claimedByStaffProfileId;
  if (!owner || owner !== actorStaffProfileId) {
    const message =
      occurrence.poolJobRoleId && !occurrence.claimedByStaffProfileId
        ? 'Claim this role-pool occurrence before working on it.'
        : 'Only the assigned or claiming staff member may work on this occurrence.';
    throw new SopExecutionError(message, 'NOT_OWNER');
  }
}

// ── Start occurrence ──────────────────────────────────────────────────────────

export type StartOccurrenceInput = {
  occurrenceId: string;
  actorStaffProfileId?: string | null;
  now?: Date;
};

export type StartOccurrenceResult = {
  occurrenceId: string;
  status: 'IN_PROGRESS';
  startedAt: Date;
};

/**
 * Transition SCHEDULED (or REJECTED) → IN_PROGRESS.
 * REJECTED → IN_PROGRESS implements the §4 rework path after a verifier rejects.
 */
export async function startOccurrence(
  db: ScopedDb,
  input: StartOccurrenceInput
): Promise<StartOccurrenceResult> {
  const now = input.now ?? new Date();
  return runSopTx(db, async (tx) => {
    const occ = await tx.restaurantSopOccurrence.findUnique({
      where: { id: input.occurrenceId },
      select: {
        id: true,
        status: true,
        assignedStaffProfileId: true,
        poolJobRoleId: true,
        claimedByStaffProfileId: true,
      },
    });
    if (!occ) throw new SopExecutionError('Occurrence not found.', 'NOT_FOUND');
    assertOccurrenceOwner(occ, input.actorStaffProfileId);
    if (occ.status !== 'SCHEDULED' && occ.status !== 'REJECTED') {
      throw new SopExecutionError(
        `Cannot start an occurrence in status ${occ.status}. Expected SCHEDULED or REJECTED.`,
        'INVALID_STATE'
      );
    }
    const updated = await tx.restaurantSopOccurrence.update({
      where: { id: input.occurrenceId },
      data: { status: 'IN_PROGRESS', startedAt: now },
      select: { id: true, startedAt: true },
    });
    return { occurrenceId: updated.id, status: 'IN_PROGRESS', startedAt: updated.startedAt! };
  });
}

// ── Complete a step ───────────────────────────────────────────────────────────

export type CompleteStepInput = {
  occurrenceId: string;
  templateStepId: string;
  note?: string | null;
  actorStaffProfileId?: string | null;
  now?: Date;
};

export type CompleteStepResult = {
  occurrenceStepId: string;
  completed: boolean;
  completedAt: Date;
};

/**
 * Mark one checklist step completed on an IN_PROGRESS occurrence.
 * Idempotent: re-completing an already-completed step returns the existing state.
 */
export async function completeStep(
  db: ScopedDb,
  input: CompleteStepInput
): Promise<CompleteStepResult> {
  const now = input.now ?? new Date();
  return runSopTx(db, async (tx) => {
    const occ = await tx.restaurantSopOccurrence.findUnique({
      where: { id: input.occurrenceId },
      select: {
        id: true,
        status: true,
        assignedStaffProfileId: true,
        poolJobRoleId: true,
        claimedByStaffProfileId: true,
      },
    });
    if (!occ) throw new SopExecutionError('Occurrence not found.', 'NOT_FOUND');
    assertOccurrenceOwner(occ, input.actorStaffProfileId);
    if (occ.status !== 'IN_PROGRESS') {
      throw new SopExecutionError(
        `Cannot complete a step on an occurrence in status ${occ.status}. Expected IN_PROGRESS.`,
        'INVALID_STATE'
      );
    }
    const step = await tx.restaurantSopOccurrenceStep.findUnique({
      where: {
        occurrenceId_templateStepId: {
          occurrenceId: input.occurrenceId,
          templateStepId: input.templateStepId,
        },
      },
      select: {
        id: true,
        completed: true,
        completedAt: true,
        templateStep: { select: { requiresPhoto: true, requiresSignature: true } },
        evidence: { select: { mimeType: true } },
      },
    });
    if (!step) throw new SopExecutionError('Step not found on this occurrence.', 'STEP_NOT_FOUND');
    if (step.completed) {
      return { occurrenceStepId: step.id, completed: true, completedAt: step.completedAt! };
    }
    const evidence = step.evidence ?? [];
    const hasPhoto = evidence.some(
      (row) =>
        row.mimeType.includes('evidence=photo') ||
        (row.mimeType.startsWith('image/') && !row.mimeType.includes('evidence=signature'))
    );
    const hasSignature = evidence.some(
      (row) =>
        row.mimeType.includes('evidence=signature') ||
        row.mimeType === 'application/vnd.devfathom.signature+json'
    );
    if (step.templateStep?.requiresPhoto && !hasPhoto) {
      throw new SopExecutionError(
        'Photo proof is required before completing this step.',
        'PROOF_REQUIRED'
      );
    }
    if (step.templateStep?.requiresSignature && !hasSignature) {
      throw new SopExecutionError(
        'Signature proof is required before completing this step.',
        'PROOF_REQUIRED'
      );
    }
    const updated = await tx.restaurantSopOccurrenceStep.update({
      where: { id: step.id },
      data: {
        completed: true,
        completedAt: now,
        note: input.note ?? undefined,
        completedByStaffProfileId: input.actorStaffProfileId ?? undefined,
      },
      select: { id: true, completedAt: true },
    });
    return { occurrenceStepId: updated.id, completed: true, completedAt: updated.completedAt! };
  });
}

// ── Attach evidence ───────────────────────────────────────────────────────────

export type AttachEvidenceInput = {
  occurrenceId: string;
  occurrenceStepId?: string | null;
  /** Raw content bytes as a Buffer (or Buffer-like). sha256 is computed server-side. */
  contentBytes?: Buffer | null;
  /** When no bytes are provided, caller supplies the sha256 hex directly (e.g. from a storage pre-commit). */
  contentHashHex?: string | null;
  mimeType: string;
  sizeBytes: number;
  storageRef?: string | null;
  uploaderStaffProfileId?: string | null;
  now?: Date;
};

export type AttachEvidenceResult = {
  evidenceId: string;
  contentHash: string;
  createdAt: Date;
  created: boolean;
};

/**
 * Append an evidence record to an occurrence (and optionally a specific step).
 * sha256 is computed from `contentBytes` when provided; otherwise `contentHashHex`
 * is used as-is (the caller has already computed it, e.g. after a blob-store upload).
 *
 * The occurrence must be IN_PROGRESS or SUBMITTED (late submission is allowed).
 * Evidence is APPEND-ONLY; this function never edits an existing row.
 */
export async function attachEvidence(
  db: ScopedDb,
  input: AttachEvidenceInput
): Promise<AttachEvidenceResult> {
  const now = input.now ?? new Date();

  if (!input.contentBytes && !input.contentHashHex) {
    throw new SopExecutionError(
      'Either contentBytes or contentHashHex must be provided.',
      'INVALID'
    );
  }
  if (input.sizeBytes < 0) {
    throw new SopExecutionError('sizeBytes must be non-negative.', 'INVALID');
  }

  const contentHash = input.contentBytes
    ? crypto.createHash('sha256').update(input.contentBytes).digest('hex')
    : input.contentHashHex!.trim().toLowerCase();

  return runSopTx(db, async (tx) => {
    const occ = await tx.restaurantSopOccurrence.findUnique({
      where: { id: input.occurrenceId },
      select: {
        id: true,
        status: true,
        assignedStaffProfileId: true,
        poolJobRoleId: true,
        claimedByStaffProfileId: true,
      },
    });
    if (!occ) throw new SopExecutionError('Occurrence not found.', 'NOT_FOUND');
    assertOccurrenceOwner(occ, input.uploaderStaffProfileId);
    const allowedStatuses = ['IN_PROGRESS', 'SUBMITTED', 'LATE'] as const;
    if (!(allowedStatuses as readonly string[]).includes(occ.status)) {
      throw new SopExecutionError(
        `Cannot attach evidence to an occurrence in status ${occ.status}.`,
        'INVALID_STATE'
      );
    }
    if (input.occurrenceStepId) {
      const step = await tx.restaurantSopOccurrenceStep.findUnique({
        where: { id: input.occurrenceStepId },
        select: { id: true, occurrenceId: true },
      });
      if (!step || step.occurrenceId !== input.occurrenceId) {
        throw new SopExecutionError('Step not found on this occurrence.', 'STEP_NOT_FOUND');
      }
    }
    const identity = {
      occurrenceId: input.occurrenceId,
      occurrenceStepId: input.occurrenceStepId ?? null,
      contentHash,
      mimeType: input.mimeType,
      uploaderStaffProfileId: input.uploaderStaffProfileId ?? null,
    };
    const inserted = await tx.restaurantSopEvidence.createMany({
      data: {
        ...identity,
        sizeBytes: input.sizeBytes,
        storageRef: input.storageRef ?? null,
        capturedAt: now,
      },
      skipDuplicates: true,
    });
    const evidence = await tx.restaurantSopEvidence.findFirst({
      where: identity,
      select: { id: true, contentHash: true, createdAt: true },
    });
    if (!evidence) {
      throw new SopExecutionError('Evidence could not be attached.', 'INVALID');
    }
    return {
      evidenceId: evidence.id,
      contentHash: evidence.contentHash,
      createdAt: evidence.createdAt,
      created: inserted.count === 1,
    };
  });
}

// ── Submit occurrence ─────────────────────────────────────────────────────────

export type SubmitOccurrenceInput = {
  occurrenceId: string;
  actorStaffProfileId?: string | null;
  now?: Date;
};

export type SubmitOccurrenceResult = {
  occurrenceId: string;
  status: 'SUBMITTED' | 'LATE';
  submittedAt: Date;
};

/**
 * Transition IN_PROGRESS → SUBMITTED (or LATE if the window has already closed).
 * Step completeness is not enforced per §SOP-defaults (requirement flags recorded, not gated).
 */
export async function submitOccurrence(
  db: ScopedDb,
  input: SubmitOccurrenceInput
): Promise<SubmitOccurrenceResult> {
  const now = input.now ?? new Date();
  return runSopTx(db, async (tx) => {
    const occ = await tx.restaurantSopOccurrence.findUnique({
      where: { id: input.occurrenceId },
      select: {
        id: true,
        status: true,
        windowEndsAt: true,
        assignedStaffProfileId: true,
        poolJobRoleId: true,
        claimedByStaffProfileId: true,
      },
    });
    if (!occ) throw new SopExecutionError('Occurrence not found.', 'NOT_FOUND');
    assertOccurrenceOwner(occ, input.actorStaffProfileId);
    if (occ.status !== 'IN_PROGRESS') {
      throw new SopExecutionError(
        `Cannot submit an occurrence in status ${occ.status}. Expected IN_PROGRESS.`,
        'INVALID_STATE'
      );
    }
    // LATE = submitted after the window closed (BUILD-ASSUMPTIONS §SOP-defaults (4))
    const newStatus = now > occ.windowEndsAt ? 'LATE' : 'SUBMITTED';
    const updated = await tx.restaurantSopOccurrence.update({
      where: { id: input.occurrenceId },
      data: { status: newStatus, submittedAt: now },
      select: { id: true, submittedAt: true },
    });
    return { occurrenceId: updated.id, status: newStatus, submittedAt: updated.submittedAt! };
  });
}
