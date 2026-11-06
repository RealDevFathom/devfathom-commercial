'use client';

import { ArrowLeft, ImageOff } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { WorkspaceState } from '@/components/pharmacy/dispensing/field';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Textarea } from '@/components/ui/textarea';
import { trpc } from '@/lib/trpc';

import { SopEvidenceUpload } from './sop-evidence-upload';
import {
  CONFLICT_MESSAGE,
  EMPTY_DRAFT,
  errorCode,
  errorMessage,
  evidencePurposeOf,
  excursionStep,
  formatWhen,
  isDenied,
  isReworking,
  latestRejection,
  linksInStepOrder,
  PROVENANCE_LABEL,
  provenanceTone,
  RECORD_LABEL,
  reworkNotes,
  statusCopy,
  outOfRangeNoteNeeded,
  stepBlockers,
  stepEvidence,
  stepLinks,
  submitBlockers,
  type EvidencePurpose,
  type SopAccess,
  type SopEvidenceRow,
  type SopOccurrence,
  type SopOccurrenceStep,
  type SopReworkNote,
  type SopStatus,
  type StepDraft,
} from './sop-model';
import { SopRecordPicker } from './sop-record-picker';
import { NewSinceSentBack, RecordLinkList, ReworkNoteList, SentBackNotice } from './sop-rework';
import { SopReviewDecision } from './sop-review';

type Notify = (notice: { tone: 'success' | 'danger'; text: string }) => void;

export type SopRunnerProps = {
  pharmacyBranchId: string;
  timezone: string | null;
  occurrenceId: string;
  access: SopAccess;
  /** Where the person came from, so Back names the right place. */
  from: 'work' | 'review';
  draftFor: (stepKey: string) => StepDraft;
  setDraft: (stepKey: string, patch: Partial<StepDraft>) => void;
  clearDraft: (stepKey: string) => void;
  onBack: () => void;
  onNotice: Notify;
};

const HISTORY_LABEL: Record<string, string> = {
  STEP_COMPLETED: 'Step done',
  EVIDENCE_CAPTURED: 'Proof added',
  ESCALATION_FIRED: 'Reminder sent',
  ESCALATION_ACKNOWLEDGED: 'Reminder acknowledged',
  ESCALATION_STOPPED: 'Reminders stopped',
  VERIFIED: 'Checked',
  VERIFY: 'Checked',
  REJECTED: 'Sent back',
  REJECT: 'Sent back',
  WAIVED: 'Excused',
  WAIVE: 'Excused',
};

const REVIEWABLE = new Set(['SUBMITTED', 'LATE']);
const STARTABLE = new Set(['SCHEDULED', 'REJECTED']);
const SENDABLE = new Set(['SCHEDULED', 'IN_PROGRESS', 'REJECTED']);

/** Where the owner's own procedure stands once it is out of their hands. */
const OWNER_STATE: Partial<Record<SopStatus, string>> = {
  SUBMITTED: 'Sent for review. A reviewer will check it.',
  LATE: 'Sent for review after its time. A reviewer will check it.',
  VERIFIED: 'Checked by a reviewer. Nothing more to do.',
  MISSED: 'This procedure was missed and is now closed.',
  WAIVED: 'This procedure was excused and is now closed.',
};

/** What the person reworking a sent-back procedure does, said once by the reason. */
export const REWORK_GUIDANCE =
  'Steps stay done; add what you changed. On any step you can add a new photo or signature, link another record, or write a note. Then say what you changed below and send it for review again.';

/** What the overall rework note asks for: any rework note, here or on a step, meets it. */
export const REWORK_NOTE_HINT =
  'Add at least one note — here or on a step — saying what you changed before sending it for review again.';

/** Whether the person asked the browser for less motion (no smooth scrolling then). */
export function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function SopRunner({
  pharmacyBranchId,
  timezone,
  occurrenceId,
  access,
  from,
  draftFor,
  setDraft,
  clearDraft,
  onBack,
  onNotice,
}: SopRunnerProps) {
  const headingRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [error, setError] = useState<string | null>(null);
  /** Bumped after a refused change has been re-read, to bring its message into view. */
  const [conflictSeen, setConflictSeen] = useState(0);
  /** Which rework note was just saved (its draft key), for a short confirmation. */
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const query = trpc.pharmacySop.occurrence.useQuery(
    { pharmacyBranchId, occurrenceId },
    { retry: false }
  );
  const ready = Boolean(query.data);

  useEffect(() => {
    // Move focus to the procedure once it is on screen, so keyboard and screen
    // reader users land on what they opened rather than the top of the page.
    if (ready) headingRef.current?.focus();
  }, [occurrenceId, ready]);

  useEffect(() => {
    // The procedure changed underneath this person and has been re-read. The
    // message sits at the top of the procedure, which may be far above the
    // control they used, so move focus to it and scroll it into view (no
    // smooth travel under reduced motion).
    if (!conflictSeen) return;
    const alert = errorRef.current;
    if (!alert) return;
    alert.focus({ preventScroll: true });
    alert.scrollIntoView?.({
      block: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [conflictSeen]);

  async function refresh() {
    await Promise.all([
      utils.pharmacySop.occurrence.invalidate({ pharmacyBranchId, occurrenceId }),
      utils.pharmacySop.board.invalidate({ pharmacyBranchId }),
    ]);
  }

  /**
   * A refused change. When the procedure changed underneath this person
   * (CONFLICT: already checked, sent back, claimed or submitted elsewhere) the
   * server's plain words are shown and the procedure and board are re-read, so
   * the screen shows where it stands now.
   */
  const conflicted = (message: string) => {
    setError(message);
    void refresh()
      .catch(() => undefined)
      .then(() => setConflictSeen((count) => count + 1));
  };
  const fail = (fallback: string) => (cause: unknown) => {
    if (errorCode(cause) === 'CONFLICT') {
      conflicted(errorMessage(cause, CONFLICT_MESSAGE));
      return;
    }
    setError(errorMessage(cause, fallback));
  };
  const claim = trpc.pharmacySop.claim.useMutation({
    onSuccess: async () => {
      setError(null);
      await refresh();
    },
    onError: fail('This procedure could not be claimed. Retry.'),
  });
  const start = trpc.pharmacySop.start.useMutation({
    onSuccess: async () => {
      setError(null);
      await refresh();
    },
    onError: fail('This procedure could not be started. Retry.'),
  });
  const completeStep = trpc.pharmacySop.completeStep.useMutation({
    onError: fail('The step could not be saved. Your note is still here — retry.'),
  });
  const submit = trpc.pharmacySop.submit.useMutation({
    onSuccess: async () => {
      setError(null);
      onNotice({ tone: 'success', text: 'Procedure sent for review.' });
      await refresh();
      onBack();
    },
    onError: fail('The procedure could not be sent for review. Retry.'),
  });
  const addReworkNote = trpc.pharmacySop.addReworkNote.useMutation({
    onError: fail('Your note could not be saved. It is still here — retry.'),
  });

  const header = (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <Button type="button" variant="outline" size="touch" onClick={onBack}>
        <ArrowLeft aria-hidden />
        {from === 'review' ? 'Back to review' : "Back to today's work"}
      </Button>
    </div>
  );

  if (query.isLoading) {
    return (
      <div>
        {header}
        <WorkspaceState title="Opening procedure">Reading the latest steps.</WorkspaceState>
      </div>
    );
  }
  if (query.error || !query.data) {
    const denied = isDenied(query.error) || errorCode(query.error) === 'NOT_FOUND';
    return (
      <div>
        {header}
        <WorkspaceState
          title={
            denied ? 'This procedure is not available to you' : 'This procedure could not be opened'
          }
          tone="danger"
        >
          <p>
            {denied
              ? 'It may belong to another branch or role, or it is no longer open.'
              : errorMessage(query.error, 'Nothing was changed. Retry when you are ready.')}
          </p>
          {denied ? null : (
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="mt-3"
              onClick={() => void query.refetch()}
            >
              Retry
            </Button>
          )}
        </WorkspaceState>
      </div>
    );
  }

  const occurrence: SopOccurrence = query.data;
  const status = statusCopy(occurrence.status);
  const owner = occurrence.viewer.isOwner;
  const editable = owner && access.canComplete && occurrence.status === 'IN_PROGRESS';
  const startable = owner && access.canComplete && STARTABLE.has(occurrence.status);
  const reviewing = occurrence.viewer.canVerify && REVIEWABLE.has(occurrence.status);
  const rejection = latestRejection(occurrence);
  const reworking = editable && isReworking(occurrence);
  const notes = reworkNotes(occurrence);
  const blockers = submitBlockers(occurrence);
  const done = occurrence.steps.filter((step) => step.completed).length;
  const busy = claim.isPending || start.isPending || submit.isPending;
  const excursion = excursionStep(occurrence);
  const stepName = (occurrenceStepId: string | null) => {
    const step = occurrence.steps.find((candidate) => candidate.id === occurrenceStepId);
    return step ? `Step ${step.stepOrder} · ${step.title}` : null;
  };
  const overallKey = `${occurrence.id}:rework`;

  async function recount(step: SopOccurrenceStep, purpose: EvidencePurpose) {
    const result = await query.refetch();
    return result.data ? stepEvidence(result.data, step, purpose).length : 0;
  }

  function saveReworkNote(draftKey: string, text: string, occurrenceStepId?: string) {
    const note = text.trim();
    if (!note) return;
    setError(null);
    setSavedNote(null);
    addReworkNote.mutate(
      {
        pharmacyBranchId,
        occurrenceId,
        ...(occurrenceStepId ? { occurrenceStepId } : {}),
        note,
      },
      {
        onSuccess: async () => {
          clearDraft(draftKey);
          setSavedNote(draftKey);
          await refresh();
        },
      }
    );
  }

  /** Whether the rework note for this step (or, for null, the whole procedure) is being saved. */
  const savingNote = (occurrenceStepId: string | null) =>
    addReworkNote.isPending &&
    (addReworkNote.variables?.occurrenceStepId ?? null) === occurrenceStepId;

  return (
    <div className="min-w-0">
      {header}
      <SectionCard className="min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-4">
          {/* Focus lands on the whole title block (not the H2 alone), so the
              programmatic focus ring frames eyebrow, title and due line
              together instead of cutting across the eyebrow. It only shows
              for keyboard focus (focus-visible). */}
          <div
            ref={headingRef}
            tabIndex={-1}
            aria-labelledby={`${occurrence.id}-title`}
            role="group"
            className="-m-2 min-w-0 rounded-sm p-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <p className="eyebrow">{occurrence.template.category ?? 'Procedure'}</p>
            <h2
              id={`${occurrence.id}-title`}
              className="mt-1 font-display text-xl font-semibold tracking-tight break-words text-text-strong"
            >
              {occurrence.template.name}
            </h2>
            <p className="mt-1 text-sm text-text-muted">
              Due {formatWhen(occurrence.dueAt, timezone)} · window ends{' '}
              {formatWhen(occurrence.windowEndsAt, timezone)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {occurrence.overdue ? (
              <StatusPill status="overdue" tone="danger" label="Overdue" />
            ) : null}
            <StatusPill status={occurrence.status} tone={status.tone} label={status.label} />
          </div>
        </div>

        {error ? (
          <p
            ref={errorRef}
            tabIndex={-1}
            className="mt-4 rounded-xs text-sm text-destructive outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        {occurrence.viewer.canClaim && access.canComplete ? (
          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border-subtle pt-5">
            <p className="min-w-0 text-sm text-text-body">
              This is open to your role. Claim it to make it yours.
            </p>
            <Button
              type="button"
              size="touch"
              disabled={busy}
              onClick={() => claim.mutate({ pharmacyBranchId, occurrenceId })}
            >
              {claim.isPending ? 'Claiming…' : 'Claim'}
            </Button>
          </div>
        ) : null}

        {occurrence.status === 'REJECTED' && rejection ? (
          <div className="mt-5 border-t border-border-subtle pt-5">
            <SentBackNotice rejection={rejection} timezone={timezone}>
              {startable
                ? 'Start again to fix it. Steps you already did stay done; after you start, add what you changed.'
                : null}
            </SentBackNotice>
          </div>
        ) : null}

        {startable ? (
          <div
            className={`flex flex-wrap items-center gap-3 ${
              occurrence.status === 'REJECTED' && rejection
                ? 'mt-3'
                : 'mt-5 border-t border-border-subtle pt-5'
            }`}
          >
            {/* A sent-back procedure already says what starting again does,
                in the notice above; it is not said twice. */}
            {occurrence.status === 'REJECTED' ? null : (
              <p className="min-w-0 text-sm text-text-body">
                Start when you are ready to work through the steps.
              </p>
            )}
            <Button
              type="button"
              size="touch"
              disabled={busy}
              onClick={() => start.mutate({ pharmacyBranchId, occurrenceId })}
            >
              {start.isPending
                ? 'Starting…'
                : occurrence.status === 'REJECTED'
                  ? 'Start again'
                  : 'Start'}
            </Button>
          </div>
        ) : null}

        <section className="mt-6 border-t border-border-subtle pt-5" aria-label="Steps">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-semibold text-text-strong">Steps</h3>
            <span className="font-mono text-xs text-text-muted tabular-nums">
              {done} of {occurrence.steps.length} done
            </span>
          </div>
          {occurrence.status === 'IN_PROGRESS' && rejection ? (
            <div className="mt-3">
              <SentBackNotice rejection={rejection} timezone={timezone}>
                {reworking ? REWORK_GUIDANCE : 'It is being fixed after this send-back.'}
              </SentBackNotice>
            </div>
          ) : null}
          <ol className="mt-3 divide-y divide-border-subtle">
            {occurrence.steps.map((step) => {
              const key = `${occurrence.id}:${step.templateStepId}`;
              const reworkKey = `${key}:rework`;
              return (
                <StepItem
                  key={step.id}
                  step={step}
                  occurrence={occurrence}
                  pharmacyBranchId={pharmacyBranchId}
                  timezone={timezone}
                  editable={editable}
                  reworking={reworking}
                  excursion={excursion}
                  draft={draftFor(key)}
                  onDraft={(patch) => setDraft(key, patch)}
                  reworkDraft={draftFor(reworkKey)}
                  onReworkDraft={(patch) => setDraft(reworkKey, patch)}
                  savingReworkNote={savingNote(step.id)}
                  reworkNoteSaved={savedNote === reworkKey}
                  onSaveReworkNote={(text) => saveReworkNote(reworkKey, text, step.id)}
                  saving={
                    completeStep.isPending &&
                    completeStep.variables?.templateStepId === step.templateStepId
                  }
                  onComplete={(draft) => {
                    setError(null);
                    completeStep.mutate(
                      {
                        pharmacyBranchId,
                        occurrenceId,
                        templateStepId: step.templateStepId,
                        ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
                      },
                      {
                        onSuccess: async () => {
                          clearDraft(key);
                          await refresh();
                        },
                      }
                    );
                  }}
                  recount={(purpose) => recount(step, purpose)}
                  onChanged={() => void refresh()}
                  onConflict={conflicted}
                />
              );
            })}
          </ol>
        </section>

        {reworking ? (
          <OverallReworkNote
            notes={notes.filter((note) => note.occurrenceStepId === null)}
            timezone={timezone}
            draft={draftFor(overallKey).note}
            onDraft={(note) => setDraft(overallKey, { note })}
            saving={savingNote(null)}
            saved={savedNote === overallKey}
            onSave={(text) => saveReworkNote(overallKey, text)}
          />
        ) : null}

        {owner && access.canComplete ? (
          SENDABLE.has(occurrence.status) ? (
            <section
              aria-label="Send for review"
              className="mt-6 grid gap-3 border-t border-border-subtle pt-5"
            >
              <h3 className="font-semibold text-text-strong">Send for review</h3>
              {blockers.length ? (
                <div id={`blocked-${occurrence.id}`}>
                  <p className="text-sm text-text-body">Before you can send this for review:</p>
                  <ul
                    className="mt-2 grid list-disc gap-1 pl-5 text-sm text-text-muted"
                    aria-label="What is still needed"
                  >
                    {blockers.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-sm text-text-body">
                  Every step is done. Someone who did not work on it will review it.
                </p>
              )}
              <Button
                type="button"
                size="touch"
                className="w-fit"
                disabled={blockers.length > 0 || busy}
                aria-describedby={blockers.length ? `blocked-${occurrence.id}` : undefined}
                onClick={() => submit.mutate({ pharmacyBranchId, occurrenceId })}
              >
                {submit.isPending ? 'Sending…' : 'Send for review'}
              </Button>
            </section>
          ) : (
            <section
              aria-label="Review status"
              className="mt-6 grid gap-2 border-t border-border-subtle pt-5"
            >
              <p className="text-sm text-text-body" role="status">
                {OWNER_STATE[occurrence.status as SopStatus] ?? 'This procedure is closed.'}
              </p>
            </section>
          )
        ) : null}

        {reviewing ? (
          <SopReviewDecision
            pharmacyBranchId={pharmacyBranchId}
            occurrenceId={occurrenceId}
            evidence={occurrence.evidence}
            links={linksInStepOrder(occurrence)}
            rejection={rejection}
            reworkNotes={notes}
            stepName={stepName}
            timezone={timezone}
            onDone={(text) => {
              onNotice({ tone: 'success', text });
              void refresh();
              onBack();
            }}
            onConflict={conflicted}
          />
        ) : null}

        <History occurrence={occurrence} timezone={timezone} />
      </SectionCard>
    </div>
  );
}

function OverallReworkNote({
  notes,
  timezone,
  draft,
  onDraft,
  saving,
  saved,
  onSave,
}: {
  notes: SopReworkNote[];
  timezone: string | null;
  draft: string;
  onDraft: (note: string) => void;
  saving: boolean;
  saved: boolean;
  onSave: (note: string) => void;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="mt-6 grid gap-3 border-t border-border-subtle pt-5"
    >
      <h3 id={`${id}-title`} className="font-semibold text-text-strong">
        What did you change?
      </h3>
      <p id={`${id}-hint`} className="text-sm text-text-muted">
        {REWORK_NOTE_HINT}
      </p>
      <ReworkNoteList notes={notes} timezone={timezone} label="What you changed" />
      <label className="grid gap-1.5 text-sm font-medium text-text-strong" htmlFor={`${id}-note`}>
        <span>Your note</span>
        <Textarea
          id={`${id}-note`}
          className="min-h-20 bg-surface-raised"
          maxLength={2000}
          value={draft}
          disabled={saving}
          aria-describedby={`${id}-hint`}
          onChange={(event) => onDraft(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="touch"
          variant="outline"
          disabled={saving || !draft.trim()}
          onClick={() => onSave(draft)}
        >
          {saving ? 'Saving…' : 'Save note'}
        </Button>
        <span aria-live="polite" className="text-sm text-success">
          {saved ? 'Note saved.' : ''}
        </span>
      </div>
    </section>
  );
}

function StepItem({
  step,
  occurrence,
  pharmacyBranchId,
  timezone,
  editable,
  reworking,
  excursion,
  draft = EMPTY_DRAFT,
  onDraft,
  reworkDraft = EMPTY_DRAFT,
  onReworkDraft,
  savingReworkNote,
  reworkNoteSaved,
  onSaveReworkNote,
  saving,
  onComplete,
  recount,
  onChanged,
  onConflict,
}: {
  step: SopOccurrenceStep;
  occurrence: SopOccurrence;
  pharmacyBranchId: string;
  timezone: string | null;
  editable: boolean;
  /** Sent back and started again: done steps take new proof, links and notes. */
  reworking: boolean;
  excursion: SopOccurrenceStep | null;
  draft?: StepDraft;
  onDraft: (patch: Partial<StepDraft>) => void;
  reworkDraft?: StepDraft;
  onReworkDraft: (patch: Partial<StepDraft>) => void;
  savingReworkNote: boolean;
  reworkNoteSaved: boolean;
  onSaveReworkNote: (note: string) => void;
  saving: boolean;
  onComplete: (draft: StepDraft) => void;
  recount: (purpose: EvidencePurpose) => Promise<number>;
  onChanged: () => void;
  /** The procedure changed underneath this person: show the words and re-read it. */
  onConflict: (message: string) => void;
}) {
  const id = useId();
  const [changing, setChanging] = useState(false);
  const blockers = stepBlockers(occurrence, step, draft);
  const photos = stepEvidence(occurrence, step, 'photo');
  const signatures = stepEvidence(occurrence, step, 'signature');
  const links = stepLinks(occurrence, step);
  const stepNotes = reworkNotes(occurrence).filter((note) => note.occurrenceStepId === step.id);
  const newProof = [...photos, ...signatures].some((row) => row.createdAfterLatestRejection);
  // Proof that is on the step but does not count here yet. It exists, so it is
  // never described as missing; the pill says what is wrong with it.
  const unsettled = [...photos, ...signatures].filter(
    (row) => row.provenance === 'UNCONFIRMED' || row.provenance === 'FOREIGN'
  );
  const needs = [
    step.requiredRecordType ? `linked ${RECORD_LABEL[step.requiredRecordType]}` : null,
    step.requiresPhoto ? 'photo' : null,
    step.requiresSignature ? 'signature' : null,
    step.requiresNote ? 'note' : null,
  ].filter((value): value is string => value !== null);
  const proofLine = [
    photos.length ? `${photos.length} ${photos.length === 1 ? 'photo' : 'photos'}` : null,
    signatures.length
      ? signatures.length === 1
        ? 'Signature added'
        : `${signatures.length} signatures added`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const excursionTarget = excursion
    ? { stepOrder: excursion.stepOrder, title: excursion.title }
    : null;
  const canChange = reworking && step.completed;

  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-xs text-text-muted">Step {step.stepOrder}</p>
          <p className="mt-1 font-medium break-words text-text-strong">{step.title}</p>
        </div>
        <StatusPill
          status={step.completed ? 'complete' : 'pending'}
          tone={step.completed ? 'success' : 'neutral'}
          label={step.completed ? 'Done' : 'Not done'}
        />
      </div>
      {step.instructions ? (
        <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-text-muted">
          {step.instructions}
        </p>
      ) : null}
      {unsettled.length ? (
        <ul aria-label={`Proof to check on ${step.title}`} className="mt-2 flex flex-wrap gap-1.5">
          {unsettled.map((row) => (
            <li key={row.id}>
              <StatusPill
                status={row.provenance}
                tone={provenanceTone(row.provenance)}
                label={`${evidencePurposeOf(row.mimeType) === 'signature' ? 'Signature' : 'Photo'}: ${PROVENANCE_LABEL[row.provenance]}`}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {/* While editing, each control and the "still needed" list say what the
          step needs; the summary line would only repeat it. */}
      {needs.length && !(editable && !step.completed) ? (
        <p className="mt-2 text-xs text-text-muted">Needs a {needs.join(', ')}</p>
      ) : null}
      {step.completed ? (
        <div className="mt-2 grid gap-2 text-xs text-text-muted">
          <p>
            Done {formatWhen(step.completedAt, timezone)}
            {step.completedByName ? ` by ${step.completedByName}` : ''}
          </p>
          {step.note ? (
            <p className="rounded-xs bg-surface-sunken p-3 text-sm whitespace-pre-wrap text-text-body">
              {step.note}
            </p>
          ) : null}
          {proofLine ? (
            <p className="flex flex-wrap items-center gap-1.5">
              <span>{proofLine}</span>
              {newProof ? <NewSinceSentBack /> : null}
            </p>
          ) : null}
          <RecordLinkList
            links={links}
            timezone={timezone}
            label={`Linked records for step ${step.stepOrder}`}
          />
          {links.some((link) => link.detail?.outOfRange) && excursionTarget ? (
            <p className="text-sm text-warning">
              {excursionTarget.title === step.title
                ? 'A linked reading is out of range. This step’s note says what was done.'
                : `A linked reading is out of range. Step ${excursionTarget.stepOrder}, “${excursionTarget.title}”, says what was done.`}
            </p>
          ) : null}
          <ReworkNoteList
            notes={stepNotes}
            timezone={timezone}
            label={`What changed on step ${step.stepOrder}`}
          />
          {canChange ? (
            <Button
              type="button"
              size="touch"
              variant="outline"
              className="w-fit"
              aria-expanded={changing}
              aria-controls={`${id}-change`}
              onClick={() => setChanging((open) => !open)}
            >
              {changing
                ? `Close changes to step ${step.stepOrder}`
                : `Add a change to step ${step.stepOrder}`}
            </Button>
          ) : null}
          {canChange && changing ? (
            <div id={`${id}-change`} className="grid gap-3">
              <SopEvidenceUpload
                pharmacyBranchId={pharmacyBranchId}
                occurrenceId={occurrence.id}
                occurrenceStepId={step.id}
                stepTitle={step.title}
                purpose="photo"
                required={false}
                evidenceCount={photos.length}
                recount={() => recount('photo')}
                onUploaded={onChanged}
                onConflict={onConflict}
              />
              {step.requiresSignature ? (
                <SopEvidenceUpload
                  pharmacyBranchId={pharmacyBranchId}
                  occurrenceId={occurrence.id}
                  occurrenceStepId={step.id}
                  stepTitle={step.title}
                  purpose="signature"
                  required={false}
                  evidenceCount={signatures.length}
                  recount={() => recount('signature')}
                  onUploaded={onChanged}
                  onConflict={onConflict}
                />
              ) : null}
              {step.requiredRecordType ? (
                <SopRecordPicker
                  pharmacyBranchId={pharmacyBranchId}
                  occurrenceId={occurrence.id}
                  occurrenceStepId={step.id}
                  stepTitle={step.title}
                  recordType={step.requiredRecordType}
                  linked={links}
                  value={reworkDraft.recordId}
                  onChange={(recordId) => onReworkDraft({ recordId })}
                  onLinked={onChanged}
                  timezone={timezone}
                  variant="another"
                  excursionStep={excursionTarget}
                  onConflict={onConflict}
                />
              ) : null}
              <label
                className="grid gap-1.5 text-sm font-medium text-text-strong"
                htmlFor={`${id}-rework-note`}
              >
                <span>What you changed on this step</span>
                <Textarea
                  id={`${id}-rework-note`}
                  className="min-h-20 bg-surface-raised"
                  maxLength={2000}
                  value={reworkDraft.note}
                  disabled={savingReworkNote}
                  onChange={(event) => onReworkDraft({ note: event.target.value })}
                />
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  size="touch"
                  variant="outline"
                  disabled={savingReworkNote || !reworkDraft.note.trim()}
                  aria-label={`Save note for step ${step.stepOrder}`}
                  onClick={() => onSaveReworkNote(reworkDraft.note)}
                >
                  {savingReworkNote ? 'Saving…' : 'Save note'}
                </Button>
                <span aria-live="polite" className="text-sm text-success">
                  {reworkNoteSaved ? 'Note saved.' : ''}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      ) : editable ? (
        <div className="mt-3 grid gap-3">
          {step.requiredRecordType ? (
            <SopRecordPicker
              pharmacyBranchId={pharmacyBranchId}
              occurrenceId={occurrence.id}
              occurrenceStepId={step.id}
              stepTitle={step.title}
              recordType={step.requiredRecordType}
              linked={links}
              value={draft.recordId}
              onChange={(recordId) => onDraft({ recordId })}
              onLinked={onChanged}
              timezone={timezone}
              excursionStep={excursionTarget}
              onConflict={onConflict}
            />
          ) : null}
          {step.requiresPhoto ? (
            <SopEvidenceUpload
              pharmacyBranchId={pharmacyBranchId}
              occurrenceId={occurrence.id}
              occurrenceStepId={step.id}
              stepTitle={step.title}
              purpose="photo"
              evidenceCount={photos.length}
              recount={() => recount('photo')}
              onUploaded={onChanged}
              onConflict={onConflict}
            />
          ) : null}
          {step.requiresSignature ? (
            <SopEvidenceUpload
              pharmacyBranchId={pharmacyBranchId}
              occurrenceId={occurrence.id}
              occurrenceStepId={step.id}
              stepTitle={step.title}
              purpose="signature"
              evidenceCount={signatures.length}
              recount={() => recount('signature')}
              onUploaded={onChanged}
              onConflict={onConflict}
            />
          ) : null}
          <label
            className="grid gap-1.5 text-sm font-medium text-text-strong"
            htmlFor={`${id}-note`}
          >
            <span>
              Note
              {step.requiresNote || outOfRangeNoteNeeded(occurrence, step)
                ? ' · required'
                : ' · optional'}
            </span>
            <Textarea
              id={`${id}-note`}
              className="min-h-20 bg-surface-raised"
              maxLength={2000}
              value={draft.note}
              disabled={saving}
              onChange={(event) => onDraft({ note: event.target.value })}
            />
          </label>
          {blockers.length ? (
            <ul
              id={`${id}-blockers`}
              aria-label={`Still needed for step ${step.stepOrder}`}
              className="grid list-disc gap-1 pl-5 text-xs text-text-muted"
            >
              {blockers.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
          <Button
            type="button"
            size="touch"
            variant="outline"
            className="w-fit"
            disabled={saving || blockers.length > 0}
            aria-describedby={blockers.length ? `${id}-blockers` : undefined}
            aria-label={`Mark step ${step.stepOrder} done`}
            onClick={() => onComplete(draft)}
          >
            {saving ? 'Saving…' : 'Mark step done'}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** Same-origin file links only: a restaurant-attached ref is caller-supplied text. */
const FILE_REF = /^\/api\/files\/[A-Za-z0-9._-]+$/;

type HistoryEntry = {
  id: string;
  label: string;
  actor: string | null;
  detail: string | null;
  at: Date | string;
  proof: { href: string; image: boolean; alt: string } | null;
  /** Where the proof came from, in plain words (proof entries only). */
  provenance: SopEvidenceRow['provenance'] | null;
};

/**
 * One readable history: the engine trail (steps, proof, reminders, review
 * decisions), plus the claim, start and submit moments the trail does not
 * carry, taken from the occurrence's own timestamps, and the linked records
 * and rework notes, which live beside the engine.
 */
export function historyEntries(occurrence: SopOccurrence): HistoryEntry[] {
  const stepTitle = (stepId: string | null | undefined) => {
    const step = occurrence.steps.find((candidate) => candidate.id === stepId);
    return step ? `Step ${step.stepOrder} · ${step.title}` : null;
  };
  const decisions: Record<string, string> = HISTORY_LABEL;
  const fromTrail: HistoryEntry[] = occurrence.auditTrail.length
    ? occurrence.auditTrail.map((row) => {
        if (row.action === 'EVIDENCE_CAPTURED') {
          const evidenceId =
            row.proofRef && row.proofRef.kind === 'EVIDENCE' ? row.proofRef.evidenceId : row.id;
          const evidence = occurrence.evidence.find((candidate) => candidate.id === evidenceId);
          const purpose = evidence ? evidencePurposeOf(evidence.mimeType) : 'photo';
          const where = stepTitle(evidence?.occurrenceStepId);
          const ref = evidence?.storageRef ?? null;
          return {
            id: row.id,
            label: purpose === 'signature' ? 'Signature added' : 'Photo added',
            actor: row.actorName,
            detail: where,
            at: row.at,
            provenance: evidence?.provenance ?? null,
            proof:
              ref && FILE_REF.test(ref)
                ? {
                    href: ref,
                    image: Boolean(
                      evidence?.capturedInPharmacy && evidence.mimeType.startsWith('image/')
                    ),
                    alt: `${purpose === 'signature' ? 'Signature' : 'Photo'}${where ? ` for ${where}` : ''}`,
                  }
                : null,
          };
        }
        if (row.action === 'STEP_COMPLETED') {
          return {
            id: row.id,
            label: 'Step done',
            actor: row.actorName,
            detail: stepTitle(row.id),
            at: row.at,
            proof: null,
            provenance: null,
          };
        }
        return {
          id: row.id,
          label: decisions[row.action] ?? 'Updated',
          actor: row.actorName,
          detail: row.detail,
          at: row.at,
          proof: null,
          provenance: null,
        };
      })
    : occurrence.verifications.map((row) => ({
        id: row.id,
        label: decisions[row.action] ?? 'Updated',
        actor: row.actorName,
        detail: row.reason,
        at: row.createdAt,
        proof: null,
        provenance: null,
      }));
  const moments: HistoryEntry[] = [];
  if (occurrence.claimedAt) {
    moments.push({
      id: `${occurrence.id}:claimed`,
      label: 'Claimed from the role pool',
      actor: occurrence.claimedByName,
      detail: null,
      at: occurrence.claimedAt,
      proof: null,
      provenance: null,
    });
  }
  if (occurrence.startedAt) {
    moments.push({
      id: `${occurrence.id}:started`,
      label: 'Started',
      actor: occurrence.ownerName,
      detail: null,
      at: occurrence.startedAt,
      proof: null,
      provenance: null,
    });
  }
  if (occurrence.submittedAt) {
    moments.push({
      id: `${occurrence.id}:submitted`,
      label: 'Sent for review',
      actor: occurrence.ownerName,
      detail: null,
      at: occurrence.submittedAt,
      proof: null,
      provenance: null,
    });
  }
  const linked: HistoryEntry[] = (occurrence.recordLinks ?? []).map((link) => ({
    id: `link:${link.id}`,
    label: 'Record linked',
    actor: null,
    detail:
      [stepTitle(link.occurrenceStepId), link.detail?.label].filter(Boolean).join(' · ') || null,
    at: link.createdAt,
    proof: null,
    provenance: null,
  }));
  const noted: HistoryEntry[] = reworkNotes(occurrence).map((note) => {
    const where = stepTitle(note.occurrenceStepId);
    return {
      id: `rework:${note.id}`,
      label: 'Rework note added',
      actor: note.authorName,
      detail: where ? `${where}\n${note.note}` : note.note,
      at: note.createdAt,
      proof: null,
      provenance: null,
    };
  });
  return [...fromTrail, ...moments, ...linked, ...noted].sort(
    (left, right) => new Date(right.at).getTime() - new Date(left.at).getTime()
  );
}

/**
 * A proof link in History. An image that will not load (moved, expired or
 * blocked) falls back to an icon and an "Open file" link instead of a box of
 * clipped alt text.
 */
function ProofLink({ proof }: { proof: NonNullable<HistoryEntry['proof']> }) {
  const [broken, setBroken] = useState(false);
  const name = `${proof.alt.charAt(0).toLowerCase()}${proof.alt.slice(1)}`;
  const linkClass =
    'inline-flex min-h-11 w-fit items-center justify-center rounded-xs border border-border-subtle bg-surface-raised text-sm font-medium text-text-strong hover:bg-surface-sunken focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none';

  if (proof.image && broken) {
    return (
      <div className="grid w-fit gap-1 rounded-xs border border-border-subtle bg-surface-sunken p-3">
        <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
          <ImageOff aria-hidden className="size-4 shrink-0" />
          Preview unavailable
        </span>
        <a
          href={proof.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open file: ${name}`}
          className={`${linkClass} px-3`}
        >
          Open file
        </a>
      </div>
    );
  }
  return (
    <a
      href={proof.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`View ${name}`}
      className={linkClass}
    >
      {proof.image ? (
        // Proof is served by /api/files behind the pharmacy viewer check,
        // so next/image's optimiser (which fetches without the session)
        // cannot load it.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={proof.href}
          alt={proof.alt}
          loading="lazy"
          onError={() => setBroken(true)}
          className="size-16 rounded-xs object-cover"
        />
      ) : (
        <span className="px-3">View</span>
      )}
    </a>
  );
}

function History({ occurrence, timezone }: { occurrence: SopOccurrence; timezone: string | null }) {
  const entries = historyEntries(occurrence);

  return (
    <section aria-label="History" className="mt-6 border-t border-border-subtle pt-5">
      <h3 className="font-semibold text-text-strong">History</h3>
      {entries.length ? (
        <ul className="mt-3 divide-y divide-border-subtle">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="grid gap-3 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto]"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-text-strong">{entry.label}</span>
                  <time className="font-mono text-xs text-text-muted">
                    {formatWhen(entry.at, timezone)}
                  </time>
                </div>
                {entry.actor ? <p className="mt-1 text-xs text-text-muted">{entry.actor}</p> : null}
                {entry.provenance ? (
                  <StatusPill
                    className="mt-2"
                    status={entry.provenance}
                    tone={provenanceTone(entry.provenance)}
                    label={PROVENANCE_LABEL[entry.provenance]}
                  />
                ) : null}
                {entry.detail ? (
                  <p className="mt-1 text-sm break-words whitespace-pre-wrap text-text-body">
                    {entry.detail}
                  </p>
                ) : null}
              </div>
              {entry.proof ? <ProofLink proof={entry.proof} /> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-text-muted">Nothing has been recorded yet.</p>
      )}
    </section>
  );
}
