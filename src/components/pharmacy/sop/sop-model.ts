import type { inferRouterOutputs } from '@trpc/server';

import type { StatusTone } from '@/components/ui/status-pill';
import { PHARMACY_SOP_NO_STAFF_PROFILE_MESSAGE } from '@/lib/pharmacy/sop-shared';
import { workspaceTimezone } from '@/lib/timezone';
import type { AppRouter } from '@/server/routers/_app';

/**
 * DEV-751 — the view model the pharmacy Procedures workspace renders. Every
 * shape is inferred from `pharmacySop` router outputs, so a change on the
 * server surfaces here as a type error instead of a silent runtime gap.
 */
type Outputs = inferRouterOutputs<AppRouter>['pharmacySop'];

export type SopAccess = Outputs['access'];
export type SopBranch = Outputs['branches'][number];
export type SopTemplate = Outputs['templates'][number];
export type SopAssignment = Outputs['assignments'][number];
export type SopRoleHolder = Outputs['roleHoldings'][number];
export type SopBoard = Outputs['board'];
export type SopBoardItem = SopBoard['mine'][number];
export type SopOccurrence = Outputs['occurrence'];
export type SopOccurrenceStep = SopOccurrence['steps'][number];
export type SopLinkableRecord = Outputs['linkableRecords'][number];
export type SopRecordLink = SopOccurrence['recordLinks'][number];
/** What a linked (or linkable) record says, in plain words, for the reviewer. */
export type SopRecordDetail = SopRecordLink['detail'];
export type SopRework = SopOccurrence['rework'];
export type SopReworkNote = SopRework['notes'][number];
export type SopRejection = NonNullable<SopRework['latestRejection']>;
export type SopReport = Outputs['report'];

export type SopRoleKey = 'pharmacy-manager' | 'pharmacy-qualified-person' | 'pharmacy-assistant';
export type SopRecordType =
  | 'TEMPERATURE_LOG'
  | 'CONTROLLED_REGISTER_ENTRY'
  | 'GOODS_RECEIPT'
  | 'MANUFACTURING_BATCH'
  | 'RECALL_NOTICE';
export type SopTrigger = 'SHIFT' | 'INTERVAL' | 'EVENT' | 'ASSIGNED';
export type SopFrequency = 'ONCE' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'INTERVAL';
export type SopStatus =
  | 'SCHEDULED'
  | 'IN_PROGRESS'
  | 'SUBMITTED'
  | 'VERIFIED'
  | 'REJECTED'
  | 'LATE'
  | 'MISSED'
  | 'WAIVED';
export type EvidencePurpose = 'photo' | 'signature';

type When = Date | string;

/** Unsaved text a person has typed into one step, kept while they move around. */
export type StepDraft = { note: string; recordId: string };
export const EMPTY_DRAFT: StepDraft = { note: '', recordId: '' };

// ── Plain-language labels ────────────────────────────────────────────────────

export const ROLE_LABEL: Record<SopRoleKey, string> = {
  'pharmacy-manager': 'Pharmacy manager',
  'pharmacy-qualified-person': 'Qualified person (pharmacist)',
  'pharmacy-assistant': 'Pharmacy assistant',
};
export const ROLE_KEYS = Object.keys(ROLE_LABEL) as SopRoleKey[];

export const RECORD_LABEL: Record<SopRecordType, string> = {
  TEMPERATURE_LOG: 'temperature log',
  CONTROLLED_REGISTER_ENTRY: 'controlled register entry',
  GOODS_RECEIPT: 'goods receipt',
  MANUFACTURING_BATCH: 'batch record',
  RECALL_NOTICE: 'recall notice',
};

export const TRIGGER_COPY: Record<SopTrigger, { label: string; detail: string }> = {
  SHIFT: {
    label: 'Every shift',
    detail: 'Comes due at a set time each day, such as after opening or after closing.',
  },
  INTERVAL: {
    label: 'Repeats during the day',
    detail: 'Comes back at a regular gap between a start and end time.',
  },
  EVENT: {
    label: 'On demand',
    detail: 'Start it when it happens, such as a delivery or an incident.',
  },
  ASSIGNED: { label: 'Assigned to a person', detail: 'Given to one named person to complete.' },
};

const STATUS_COPY: Record<SopStatus, { label: string; tone: StatusTone }> = {
  SCHEDULED: { label: 'To do', tone: 'info' },
  IN_PROGRESS: { label: 'In progress', tone: 'info' },
  SUBMITTED: { label: 'Awaiting review', tone: 'warning' },
  VERIFIED: { label: 'Checked', tone: 'success' },
  REJECTED: { label: 'Sent back', tone: 'danger' },
  // The engine marks a submission that arrived after its window as LATE; it
  // still waits for review like any other submission.
  LATE: { label: 'Submitted late', tone: 'warning' },
  MISSED: { label: 'Missed', tone: 'danger' },
  WAIVED: { label: 'Excused', tone: 'neutral' },
};

export function statusCopy(status: string): { label: string; tone: StatusTone } {
  return STATUS_COPY[status as SopStatus] ?? { label: 'Unknown', tone: 'neutral' };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function minutesToTime(value: number) {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function timeToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes < 1440 ? minutes : null;
}

/** A repeat gap in words: "Every hour", "Every 4 hours", "Every 90 minutes". */
function everyLabel(minutes: number) {
  if (minutes > 0 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? 'Every hour' : `Every ${hours} hours`;
  }
  return `Every ${minutes} minutes`;
}

/**
 * A schedule in words. A pack suggestion has no time of day (`dueTimeMinutes`
 * null): the manager chooses it, so only the frequency is described. A
 * repeating check names its first and last time ("Every 4 hours from 09:00 to
 * 21:00").
 */
export function recurrenceLabel(value: {
  frequency: SopFrequency;
  interval: number;
  daysOfWeek: number[];
  dueTimeMinutes: number | null;
  intervalEndTimeMinutes?: number | null;
}) {
  const at = value.dueTimeMinutes == null ? '' : ` at ${minutesToTime(value.dueTimeMinutes)}`;
  const range =
    value.dueTimeMinutes == null
      ? ''
      : value.intervalEndTimeMinutes == null
        ? ` from ${minutesToTime(value.dueTimeMinutes)}`
        : ` from ${minutesToTime(value.dueTimeMinutes)} to ${minutesToTime(value.intervalEndTimeMinutes)}`;
  // Every day of the week is just "every day": listing all seven says nothing.
  const everyDay = new Set(value.daysOfWeek).size >= 7;
  const days =
    value.daysOfWeek.length && !everyDay
      ? ` on ${value.daysOfWeek.map((day) => WEEKDAYS[day] ?? '').join(', ')}`
      : '';
  switch (value.frequency) {
    case 'ONCE':
      return `Once${at}`;
    case 'DAILY':
      return value.interval > 1 ? `Every ${value.interval} days${at}` : `Every day${at}`;
    case 'WEEKLY':
      return `Weekly${days}${at}`;
    case 'MONTHLY':
      return `Monthly${at}`;
    case 'INTERVAL':
      return `${everyLabel(value.interval)}${range}${days}`;
  }
}

export function formatWhen(value: When | null | undefined, timeZone: string | null) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: workspaceTimezone(timeZone),
  }).format(date);
}

// ── Where proof came from ────────────────────────────────────────────────────

export type SopEvidenceRow = SopOccurrence['evidence'][number];
export type SopProvenance = SopEvidenceRow['provenance'];

/**
 * Plain words for proof provenance. Every label describes proof that EXISTS:
 * none of them may ever read as "missing".
 */
export const PROVENANCE_LABEL: Record<SopProvenance, string> = {
  RECEIPT: 'Captured here',
  LEGACY_HMAC: 'Captured here (older proof)',
  UNCONFIRMED: 'Proof present, capture not confirmed',
  FOREIGN: 'Added outside the pharmacy workspace',
};

export function provenanceTone(provenance: SopProvenance): StatusTone {
  return provenance === 'RECEIPT' || provenance === 'LEGACY_HMAC'
    ? 'success'
    : provenance === 'UNCONFIRMED'
      ? 'warning'
      : 'danger';
}

/** Proof a verifier cannot accept yet, with what to do about it (null when all is fine). */
export function provenanceReviewNote(evidence: readonly Pick<SopEvidenceRow, 'provenance'>[]) {
  const foreign = evidence.filter((row) => row.provenance === 'FOREIGN').length;
  const unconfirmed = evidence.filter((row) => row.provenance === 'UNCONFIRMED').length;
  if (foreign) {
    return `${foreign === 1 ? 'One proof was' : `${foreign} proofs were`} added outside the pharmacy workspace, so this procedure cannot be marked as checked. Ask a manager to review it, or send it back.`;
  }
  if (unconfirmed) {
    return unconfirmed === 1
      ? "This older proof can't be confirmed as captured here. Ask your manager to confirm it, or send it back so it can be captured again."
      : `These ${unconfirmed} older proofs can't be confirmed as captured here. Ask your manager to confirm them, or send it back so they can be captured again.`;
  }
  return null;
}

// ── What stops a step or a submission ───────────────────────────────────────

/** Proof the engine counts as a signature; every other image counts as a photo. */
export function evidencePurposeOf(mimeType: string): EvidencePurpose {
  return mimeType.includes('evidence=signature') ||
    mimeType === 'application/vnd.devfathom.signature+json'
    ? 'signature'
    : 'photo';
}

export function stepEvidence(
  occurrence: Pick<SopOccurrence, 'evidence'>,
  step: Pick<SopOccurrenceStep, 'id'>,
  purpose: EvidencePurpose
) {
  return occurrence.evidence.filter(
    (row) => row.occurrenceStepId === step.id && evidencePurposeOf(row.mimeType) === purpose
  );
}

export function stepLinks(
  occurrence: Pick<SopOccurrence, 'recordLinks'>,
  step: Pick<SopOccurrenceStep, 'id'>
) {
  return occurrence.recordLinks.filter((row) => row.occurrenceStepId === step.id);
}

/**
 * Every linked record, as a reviewer reads them: by step order, then by when
 * each was linked. Links not tied to a step come last.
 */
export function linksInStepOrder(occurrence: Pick<SopOccurrence, 'recordLinks' | 'steps'>) {
  const order = new Map(occurrence.steps.map((step) => [step.id, step.stepOrder]));
  const stepOrder = (link: SopRecordLink) =>
    (link.occurrenceStepId ? order.get(link.occurrenceStepId) : undefined) ??
    Number.POSITIVE_INFINITY;
  return [...occurrence.recordLinks].sort(
    (left, right) =>
      stepOrder(left) - stepOrder(right) ||
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  );
}

/**
 * Without a separate excursion step (opening, closing), an out-of-range
 * reading is documented on this step's own note. A done step can't be edited
 * later, so the note is needed before marking it done (the server enforces the
 * same rule). A note on the record link also counts.
 */
export function outOfRangeNoteNeeded(occurrence: SopOccurrence, step: SopOccurrenceStep) {
  return (
    !step.completed &&
    !excursionStep(occurrence) &&
    stepLinks(occurrence, step).some(
      (link) =>
        link.recordType === 'TEMPERATURE_LOG' &&
        link.detail.outOfRange === true &&
        !link.note?.trim()
    )
  );
}

/** Why one step cannot be marked done yet, in the order a person would fix them. */
export function stepBlockers(
  occurrence: SopOccurrence,
  step: SopOccurrenceStep,
  draft: StepDraft
): string[] {
  if (step.completed) return [];
  const reasons: string[] = [];
  if (
    step.requiredRecordType &&
    !stepLinks(occurrence, step).some((link) => link.recordType === step.requiredRecordType)
  ) {
    reasons.push(`Link the ${RECORD_LABEL[step.requiredRecordType]} this step checked.`);
  }
  if (step.requiresPhoto && stepEvidence(occurrence, step, 'photo').length === 0) {
    reasons.push('Add a photo.');
  }
  if (step.requiresSignature && stepEvidence(occurrence, step, 'signature').length === 0) {
    reasons.push('Add your signature.');
  }
  if (step.requiresNote && !draft.note.trim()) reasons.push('Write a note.');
  else if (!draft.note.trim() && outOfRangeNoteNeeded(occurrence, step)) {
    reasons.push('A linked reading is out of range. Write what happened and what you did.');
  }
  return reasons;
}

// ── Sent back and reworked ──────────────────────────────────────────────────

/**
 * The latest send-back: who sent it back, when, and why. Read from the
 * server's rework summary, falling back to the review trail so the reason is
 * never hidden behind History.
 */
export function latestRejection(
  occurrence: Pick<SopOccurrence, 'verifications'> & { rework?: SopRework | null }
): SopRejection | null {
  const fromServer = occurrence.rework?.latestRejection;
  if (fromServer) return fromServer;
  const row = [...occurrence.verifications]
    .reverse()
    .find((candidate) => candidate.action === 'REJECT');
  return row ? { reason: row.reason, createdAt: row.createdAt, reviewerName: row.actorName } : null;
}

export function reworkNotes(occurrence: { rework?: SopRework | null }): SopReworkNote[] {
  return occurrence.rework?.notes ?? [];
}

/**
 * Reworking: the owner started again after a send-back. Steps stay done (the
 * engine keeps them), so the person adds new proof, links and notes instead.
 */
export function isReworking(occurrence: SopOccurrence) {
  return occurrence.status === 'IN_PROGRESS' && latestRejection(occurrence) !== null;
}

/** After a send-back, at least one note must say what changed before it goes back for review. */
export function needsReworkNote(occurrence: SopOccurrence) {
  return (
    isReworking(occurrence) && !reworkNotes(occurrence).some((note) => note.afterLatestRejection)
  );
}

export const REWORK_NOTE_BLOCKER = 'Say what you changed after it was sent back.';

/** The step that records an out-of-range reading and what was done about it, if the procedure has one. */
const EXCURSION_STEP = /excursion|corrective/i;
export function excursionStep(occurrence: Pick<SopOccurrence, 'steps'>) {
  return occurrence.steps.find((step) => EXCURSION_STEP.test(step.title)) ?? null;
}

/** Why the whole procedure cannot be sent for review yet. */
export function submitBlockers(occurrence: SopOccurrence): string[] {
  switch (occurrence.status) {
    case 'SCHEDULED':
      return ['Start the procedure first.'];
    case 'REJECTED':
      return ['Start the procedure again to fix what was sent back.'];
    case 'SUBMITTED':
    case 'LATE':
      return ['This procedure is already waiting for review.'];
    case 'IN_PROGRESS':
      break;
    default:
      return ['This procedure is closed.'];
  }
  const reasons = occurrence.steps
    .filter((step) => !step.completed)
    .map((step) => `Step ${step.stepOrder}, “${step.title}”, is not done yet.`);
  if (needsReworkNote(occurrence)) reasons.push(REWORK_NOTE_BLOCKER);
  return reasons;
}

/**
 * Engine wording that must never reach a person: a bare code, a state name
 * ("status SUBMITTED", "IN_PROGRESS") or an assertion ("Expected IN_PROGRESS").
 * The server sends plain fixed text; this is the defensive net behind it.
 */
const ENGINE_TEXT = [
  /^[A-Z_]+$/,
  /\bstatus [A-Z_]{2,}\b/,
  /\bExpected [A-Z]/,
  /\b[A-Z]{2,}_[A-Z_]+\b/,
];

/** Shown when a refusal says the procedure changed underneath this person. */
export const CONFLICT_MESSAGE =
  'This procedure was changed by someone else while you had it open. It now shows the latest version.';

/** A readable reason from a failed request, without internal codes. */
export function errorMessage(error: unknown, fallback: string) {
  const message =
    error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  if (!message || message.length > 300 || ENGINE_TEXT.some((pattern) => pattern.test(message))) {
    return fallback;
  }
  return message;
}

export function errorCode(error: unknown) {
  return (error as { data?: { code?: string } | null } | null)?.data?.code ?? '';
}

export function isDenied(error: unknown) {
  const code = errorCode(error);
  return code === 'FORBIDDEN' || code === 'UNAUTHORIZED';
}

/**
 * The board or a procedure refused because this person has no procedures
 * profile at the branch yet; the workspace offers to set one up (joinSite).
 */
export function isNoStaffProfile(error: unknown) {
  if (errorCode(error) !== 'PRECONDITION_FAILED') return false;
  const message =
    error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  return message === PHARMACY_SOP_NO_STAFF_PROFILE_MESSAGE;
}

/** Field-level validation messages from a tRPC input refusal (`data.validation`). */
export function validationFields(error: unknown): Record<string, string[] | undefined> {
  const validation = (error as { data?: { validation?: unknown } } | null)?.data?.validation;
  return validation && typeof validation === 'object'
    ? (validation as Record<string, string[] | undefined>)
    : {};
}

/** Whether a tRPC error is an input-validation refusal (never shown raw). */
export function isValidationError(error: unknown) {
  return errorCode(error) === 'BAD_REQUEST' && Object.keys(validationFields(error)).length > 0;
}

/** Calendar date (YYYY-MM-DD) of a business-date value, as the server stores it (UTC midnight). */
export function businessDay(value: When) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}
