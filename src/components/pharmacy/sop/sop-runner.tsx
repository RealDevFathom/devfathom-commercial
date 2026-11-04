'use client';

import { ArrowLeft } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { WorkspaceState } from '@/components/pharmacy/dispensing/field';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Textarea } from '@/components/ui/textarea';
import { trpc } from '@/lib/trpc';

import { SopEvidenceUpload } from './sop-evidence-upload';
import {
  EMPTY_DRAFT,
  errorCode,
  errorMessage,
  evidencePurposeOf,
  formatWhen,
  isDenied,
  RECORD_LABEL,
  statusCopy,
  stepBlockers,
  stepEvidence,
  stepLinks,
  submitBlockers,
  type EvidencePurpose,
  type SopAccess,
  type SopOccurrence,
  type SopOccurrenceStep,
  type StepDraft,
} from './sop-model';
import { SopRecordPicker } from './sop-record-picker';
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
  const [error, setError] = useState<string | null>(null);
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

  async function refresh() {
    await Promise.all([
      utils.pharmacySop.occurrence.invalidate({ pharmacyBranchId, occurrenceId }),
      utils.pharmacySop.board.invalidate({ pharmacyBranchId }),
    ]);
  }

  const fail = (fallback: string) => (cause: unknown) => setError(errorMessage(cause, fallback));
  const claim = trpc.pharmacySop.claim.useMutation({
    onSuccess: async () => {
      setError(null);
      await refresh();
    },
    onError: (cause) => {
      fail('This procedure could not be claimed. Retry.')(cause);
      if (errorCode(cause) === 'CONFLICT') void refresh();
    },
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
  const blockers = submitBlockers(occurrence);
  const done = occurrence.steps.filter((step) => step.completed).length;
  const busy = claim.isPending || start.isPending || submit.isPending;

  async function recount(step: SopOccurrenceStep, purpose: EvidencePurpose) {
    const result = await query.refetch();
    return result.data ? stepEvidence(result.data, step, purpose).length : 0;
  }

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
          <p className="mt-4 text-sm text-destructive" role="alert">
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

        {startable ? (
          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border-subtle pt-5">
            <p className="min-w-0 text-sm text-text-body">
              {occurrence.status === 'REJECTED'
                ? 'This was sent back. Start again to fix it.'
                : 'Start when you are ready to work through the steps.'}
            </p>
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
          <ol className="mt-3 divide-y divide-border-subtle">
            {occurrence.steps.map((step) => {
              const key = `${occurrence.id}:${step.templateStepId}`;
              return (
                <StepItem
                  key={step.id}
                  step={step}
                  occurrence={occurrence}
                  pharmacyBranchId={pharmacyBranchId}
                  timezone={timezone}
                  editable={editable}
                  draft={draftFor(key)}
                  onDraft={(patch) => setDraft(key, patch)}
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
                />
              );
            })}
          </ol>
        </section>

        {owner && access.canComplete ? (
          <section
            aria-label="Send for review"
            className="mt-6 grid gap-3 border-t border-border-subtle pt-5"
          >
            <h3 className="font-semibold text-text-strong">Send for review</h3>
            {blockers.length ? (
              <div id={`blocked-${occurrence.id}`}>
                <p className="text-sm text-text-body">You can send this for review once:</p>
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
        ) : null}

        {reviewing ? (
          <SopReviewDecision
            pharmacyBranchId={pharmacyBranchId}
            occurrenceId={occurrenceId}
            onDone={(text) => {
              onNotice({ tone: 'success', text });
              void refresh();
              onBack();
            }}
          />
        ) : null}

        <History occurrence={occurrence} timezone={timezone} />
      </SectionCard>
    </div>
  );
}

function StepItem({
  step,
  occurrence,
  pharmacyBranchId,
  timezone,
  editable,
  draft = EMPTY_DRAFT,
  onDraft,
  saving,
  onComplete,
  recount,
  onChanged,
}: {
  step: SopOccurrenceStep;
  occurrence: SopOccurrence;
  pharmacyBranchId: string;
  timezone: string | null;
  editable: boolean;
  draft?: StepDraft;
  onDraft: (patch: Partial<StepDraft>) => void;
  saving: boolean;
  onComplete: (draft: StepDraft) => void;
  recount: (purpose: EvidencePurpose) => Promise<number>;
  onChanged: () => void;
}) {
  const id = useId();
  const blockers = stepBlockers(occurrence, step, draft);
  const photos = stepEvidence(occurrence, step, 'photo');
  const signatures = stepEvidence(occurrence, step, 'signature');
  const links = stepLinks(occurrence, step);
  const needs = [
    step.requiredRecordType ? `linked ${RECORD_LABEL[step.requiredRecordType]}` : null,
    step.requiresPhoto ? 'photo' : null,
    step.requiresSignature ? 'signature' : null,
    step.requiresNote ? 'note' : null,
  ].filter((value): value is string => value !== null);

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
      {/* While editing, each control and the "still needed" list say what the
          step needs; the summary line would only repeat it. */}
      {needs.length && !(editable && !step.completed) ? (
        <p className="mt-2 text-xs text-text-muted">Needs a {needs.join(', ')}</p>
      ) : null}
      {step.completed ? (
        <div className="mt-2 grid gap-1 text-xs text-text-muted">
          <p>
            Done {formatWhen(step.completedAt, timezone)}
            {step.completedByName ? ` by ${step.completedByName}` : ''}
          </p>
          {step.note ? (
            <p className="rounded-xs bg-surface-sunken p-3 text-sm whitespace-pre-wrap text-text-body">
              {step.note}
            </p>
          ) : null}
          {photos.length || signatures.length || links.length ? (
            <p>
              {[
                photos.length
                  ? `${photos.length} ${photos.length === 1 ? 'photo' : 'photos'}`
                  : null,
                signatures.length ? 'signed' : null,
                links.length
                  ? `${links.length} linked ${links.length === 1 ? 'record' : 'records'}`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
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
            />
          ) : null}
          <label
            className="grid gap-1.5 text-sm font-medium text-text-strong"
            htmlFor={`${id}-note`}
          >
            <span>Note{step.requiresNote ? ' · required' : ' · optional'}</span>
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
};

/**
 * One readable history: the engine trail (steps, proof, reminders, review
 * decisions), plus the claim, start and submit moments the trail does not
 * carry, taken from the occurrence's own timestamps.
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
          };
        }
        return {
          id: row.id,
          label: decisions[row.action] ?? 'Updated',
          actor: row.actorName,
          detail: row.detail,
          at: row.at,
          proof: null,
        };
      })
    : occurrence.verifications.map((row) => ({
        id: row.id,
        label: decisions[row.action] ?? 'Updated',
        actor: row.actorName,
        detail: row.reason,
        at: row.createdAt,
        proof: null,
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
    });
  }
  return [...fromTrail, ...moments].sort(
    (left, right) => new Date(right.at).getTime() - new Date(left.at).getTime()
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
                {entry.detail ? (
                  <p className="mt-1 text-sm break-words whitespace-pre-wrap text-text-body">
                    {entry.detail}
                  </p>
                ) : null}
              </div>
              {entry.proof ? (
                <a
                  href={entry.proof.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`View ${entry.proof.alt.charAt(0).toLowerCase()}${entry.proof.alt.slice(1)}`}
                  className="inline-flex min-h-11 w-fit items-center justify-center rounded-xs border border-border-subtle bg-surface-raised text-sm font-medium text-text-strong hover:bg-surface-sunken focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  {entry.proof.image ? (
                    // Proof is served by /api/files behind the pharmacy viewer check,
                    // so next/image's optimiser (which fetches without the session)
                    // cannot load it.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={entry.proof.href}
                      alt={entry.proof.alt}
                      loading="lazy"
                      className="size-16 rounded-xs object-cover"
                    />
                  ) : (
                    <span className="px-3">View</span>
                  )}
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-text-muted">Nothing has been recorded yet.</p>
      )}
    </section>
  );
}
