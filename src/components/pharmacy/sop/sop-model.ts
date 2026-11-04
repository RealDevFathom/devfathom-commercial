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

/**
 * A schedule in words. A pack suggestion has no time of day (`dueTimeMinutes`
 * null): the manager chooses it, so only the frequency is described.
 */
export function recurrenceLabel(value: {
  frequency: SopFrequency;
  interval: number;
  daysOfWeek: number[];
  dueTimeMinutes: number | null;
}) {
  const at = value.dueTimeMinutes == null ? '' : ` at ${minutesToTime(value.dueTimeMinutes)}`;
  const from = value.dueTimeMinutes == null ? '' : ` from ${minutesToTime(value.dueTimeMinutes)}`;
  const days = value.daysOfWeek.length
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
      return `Every ${value.interval} minutes${from}${days}`;
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
  return reasons;
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
  return occurrence.steps
    .filter((step) => !step.completed)
    .map((step) => `Step ${step.stepOrder}, “${step.title}”, is not done yet.`);
}

/** A readable reason from a failed request, without internal codes. */
export function errorMessage(error: unknown, fallback: string) {
  const message =
    error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  if (!message || /^[A-Z_]+$/.test(message) || message.length > 300) return fallback;
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
