'use client';

import { StatusPill } from '@/components/ui/status-pill';

import {
  formatWhen,
  RECORD_LABEL,
  type SopRecordDetail,
  type SopRecordLink,
  type SopRecordType,
  type SopRejection,
  type SopReworkNote,
} from './sop-model';

/**
 * DEV-751 — the pieces that show a send-back and what was changed after it,
 * shared by the person doing the work and the reviewer, so both read the same
 * words.
 */

/** Marks proof, links and notes added after the latest send-back. */
export function NewSinceSentBack() {
  return <StatusPill status="new" tone="info" label="New since sent back" />;
}

/** The reviewer's reason, shown where the person acts on it, not only in History. */
export function SentBackNotice({
  rejection,
  timezone,
  children,
}: {
  rejection: SopRejection;
  timezone: string | null;
  /** What to do about it, for this person, in one or two sentences. */
  children?: React.ReactNode;
}) {
  return (
    <section
      aria-label="Why it was sent back"
      className="grid gap-2 rounded-md border border-warning/30 bg-warning/10 p-4"
    >
      <p className="text-sm font-semibold text-text-strong">
        Sent back{rejection.reviewerName ? ` by ${rejection.reviewerName}` : ''}
        <span className="font-normal text-text-body">
          {' '}
          · <time>{formatWhen(rejection.createdAt, timezone)}</time>
        </span>
      </p>
      {rejection.reason ? (
        <blockquote className="border-l-2 border-warning pl-3 text-sm break-words whitespace-pre-wrap text-text-body">
          {rejection.reason}
        </blockquote>
      ) : (
        <p className="text-sm text-text-body">No reason was written.</p>
      )}
      {children ? <div className="text-sm text-text-body">{children}</div> : null}
    </section>
  );
}

/**
 * The record's state in words, unless it only repeats "out of range", which
 * already has its own pill.
 */
export function recordStatusLabel(detail: SopRecordDetail | null | undefined) {
  const status = detail?.statusLabel ?? null;
  if (!status) return null;
  return detail?.outOfRange && /out of range/i.test(status) ? null : status;
}

/** One line of facts about a linked record: value, place and time, when known. */
export function recordFacts(link: Pick<SopRecordLink, 'detail'>, timezone: string | null) {
  const detail = link.detail;
  if (!detail) return [];
  return [
    detail.value,
    detail.location,
    detail.recordedAt ? `Recorded ${formatWhen(detail.recordedAt, timezone)}` : null,
  ].filter((part): part is string => Boolean(part));
}

/** Linked records as a reviewer needs them: what, where, when, and whether it was out of range. */
export function RecordLinkList({
  links,
  timezone,
  label,
  stepName,
}: {
  links: readonly SopRecordLink[];
  timezone: string | null;
  label: string;
  /** Names the step each link belongs to, when the list spans steps. */
  stepName?: (occurrenceStepId: string | null) => string | null;
}) {
  if (!links.length) return null;
  return (
    <ul aria-label={label} className="grid gap-2">
      {links.map((link) => {
        const detail = link.detail;
        const where = stepName?.(link.occurrenceStepId) ?? null;
        const facts = recordFacts(link, timezone);
        return (
          <li
            key={link.id}
            className="grid gap-1 rounded-xs border border-border-subtle bg-surface-raised p-3"
          >
            {where ? <p className="font-mono text-xs text-text-muted">{where}</p> : null}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="min-w-0 text-sm font-medium break-words text-text-strong">
                {detail?.label ?? `Linked ${RECORD_LABEL[link.recordType as SopRecordType]}`}
              </span>
              {detail?.outOfRange ? (
                <StatusPill status="out-of-range" tone="danger" label="Out of range" />
              ) : null}
              {recordStatusLabel(detail) ? (
                <StatusPill
                  status="record-status"
                  tone="neutral"
                  label={recordStatusLabel(detail)}
                />
              ) : null}
              {link.createdAfterLatestRejection ? <NewSinceSentBack /> : null}
            </div>
            {facts.length ? (
              <p className="text-xs break-words text-text-muted">{facts.join(' · ')}</p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Notes saying what was changed after a send-back. */
export function ReworkNoteList({
  notes,
  timezone,
  label,
  stepName,
}: {
  notes: readonly SopReworkNote[];
  timezone: string | null;
  label: string;
  stepName?: (occurrenceStepId: string | null) => string | null;
}) {
  if (!notes.length) return null;
  return (
    <ul aria-label={label} className="grid gap-2">
      {notes.map((note) => {
        const where = stepName?.(note.occurrenceStepId) ?? null;
        return (
          <li
            key={note.id}
            className="grid gap-1 rounded-xs border border-border-subtle bg-surface-raised p-3"
          >
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
              {where ? <span className="font-mono">{where}</span> : null}
              <span>
                {note.authorName ? `${note.authorName} · ` : ''}
                <time>{formatWhen(note.createdAt, timezone)}</time>
              </span>
              {note.afterLatestRejection ? <NewSinceSentBack /> : null}
            </div>
            <p className="text-sm break-words whitespace-pre-wrap text-text-body">{note.note}</p>
          </li>
        );
      })}
    </ul>
  );
}
