'use client';

import Link from 'next/link';
import { useId, useState } from 'react';

import { fieldClass } from '@/components/pharmacy/dispensing/field';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { trpc } from '@/lib/trpc';

import {
  CONFLICT_MESSAGE,
  errorCode,
  errorMessage,
  RECORD_LABEL,
  type SopLinkableRecord,
  type SopRecordLink,
  type SopRecordType,
} from './sop-model';
import { RecordLinkList, recordStatusLabel } from './sop-rework';

/** Where each kind of record is written, when the workspace has a screen for it. */
const RECORD_HOME: Partial<Record<SopRecordType, { href: string; label: string }>> = {
  CONTROLLED_REGISTER_ENTRY: {
    href: '/pharmacy/controlled-register',
    label: 'Controlled register',
  },
  GOODS_RECEIPT: { href: '/pharmacy/purchasing', label: 'Purchasing' },
};

export type SopRecordPickerProps = {
  pharmacyBranchId: string;
  occurrenceId: string;
  occurrenceStepId: string;
  stepTitle: string;
  recordType: SopRecordType;
  linked: SopRecordLink[];
  value: string;
  onChange: (recordId: string) => void;
  onLinked: () => void;
  /** Branch timezone, for when a linked reading was recorded. */
  timezone?: string | null;
  /**
   * `step`: the step's own record requirement, with what is already linked.
   * `another`: after a send-back, linking one more record to a done step (the
   * step summary already lists what is linked).
   */
  variant?: 'step' | 'another';
  /** The step that records an out-of-range reading and what was done, when the procedure has one. */
  excursionStep?: { stepOrder: number; title: string } | null;
  /**
   * The procedure changed underneath this person: the procedure shows the
   * server's words where they will be seen and re-reads it (this step may no
   * longer be open for linking once it does).
   */
  onConflict?: (message: string) => void;
};

/** A record in the list, in plain words: what it is, its state, and whether it was out of range. */
export function recordOptionLabel(record: Pick<SopLinkableRecord, 'detail'>) {
  const detail = record.detail;
  return [
    detail?.label ?? 'Record',
    recordStatusLabel(detail),
    // Capitalised like the server's own states ("In range", "Received").
    detail?.outOfRange ? 'Out of range' : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

/** Where to write what happened about an out-of-range reading. */
export function outOfRangeAdvice(
  excursion: { stepOrder: number; title: string } | null | undefined,
  stepTitle: string
) {
  return excursion && excursion.title !== stepTitle
    ? `A linked reading is out of range. On step ${excursion.stepOrder}, “${excursion.title}”, write what happened and what you did before sending this for review.`
    : 'A linked reading is out of range. Write what happened and what you did in this step’s note before marking it done.';
}

/**
 * Point a step at a record that already exists at this branch. Linking never
 * creates or changes the record; it only shows which one the step checked.
 */
export function SopRecordPicker({
  pharmacyBranchId,
  occurrenceId,
  occurrenceStepId,
  stepTitle,
  recordType,
  linked,
  value,
  onChange,
  onLinked,
  timezone = null,
  variant = 'step',
  excursionStep = null,
  onConflict,
}: SopRecordPickerProps) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [linkNote, setLinkNote] = useState('');
  const label = RECORD_LABEL[recordType];
  const records = trpc.pharmacySop.linkableRecords.useQuery(
    // The step lets the server offer only records that fit it (for example
    // refrigerator readings for a refrigerator step).
    { pharmacyBranchId, occurrenceId, recordType, occurrenceStepId },
    { retry: false }
  );
  const link = trpc.pharmacySop.linkRecord.useMutation({
    onSuccess: () => {
      setError(null);
      setLinkNote('');
      onChange('');
      onLinked();
    },
    onError: (cause) => {
      if (errorCode(cause) === 'CONFLICT' && onConflict) {
        setError(null);
        onConflict(errorMessage(cause, CONFLICT_MESSAGE));
        return;
      }
      setError(errorMessage(cause, `The ${label} could not be linked. Retry.`));
    },
  });
  const linkedIds = new Set(linked.map((row) => row.recordId));
  const all: SopLinkableRecord[] = records.data ?? [];
  const options = all.filter((record) => !linkedIds.has(record.id));
  const home = RECORD_HOME[recordType];
  const another = variant === 'another';
  // A done step's note can't change, so without a separate excursion step an
  // out-of-range reading linked after a send-back carries its own note (the
  // server refuses it otherwise).
  const needsLinkNote =
    another &&
    !excursionStep &&
    options.some((record) => record.id === value && record.detail?.outOfRange === true);

  return (
    <div className="grid gap-3 rounded-md border border-border-subtle bg-surface-sunken p-4">
      {/* The requirement itself is stated once, in the step's "still needed" list. */}
      <p className="text-sm font-medium text-text-strong">
        {another ? `Link another ${label}` : `Linked ${label}`}
      </p>
      {another ? null : (
        <RecordLinkList
          links={linked}
          timezone={timezone}
          label={`Linked ${label}s for ${stepTitle}`}
        />
      )}
      {records.isLoading ? (
        <p className="text-sm text-text-muted" role="status">
          Looking for {label}s at this branch…
        </p>
      ) : records.error ? (
        <div className="flex flex-wrap items-center gap-3" role="alert">
          <p className="text-sm text-destructive">
            {errorMessage(records.error, `${label} records could not be loaded.`)}
          </p>
          <Button
            type="button"
            variant="outline"
            size="touch"
            onClick={() => void records.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : options.length === 0 ? (
        <p className="text-sm text-text-muted">
          {linked.length
            ? `No other ${label}s to link.`
            : `No ${label} is recorded at this branch for this period yet. Record it first, then come back to link it.`}{' '}
          {home && !linked.length ? (
            <Link
              href={home.href}
              className="font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Open {home.label}
            </Link>
          ) : null}
        </p>
      ) : (
        <form
          className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (!value) {
              setError(`Choose the ${label} to link.`);
              return;
            }
            if (needsLinkNote && !linkNote.trim()) {
              setError('This reading is out of range. Write what happened and what you did.');
              return;
            }
            link.mutate({
              pharmacyBranchId,
              occurrenceId,
              occurrenceStepId,
              recordType,
              recordId: value,
              ...(needsLinkNote ? { note: linkNote.trim() } : {}),
            });
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium text-text-strong" htmlFor={id}>
            <span>Choose the {label}</span>
            <select
              id={id}
              aria-label={`${label} for ${stepTitle}`}
              aria-invalid={error && !needsLinkNote ? true : undefined}
              className={fieldClass}
              value={value}
              disabled={link.isPending}
              onChange={(event) => {
                setError(null);
                onChange(event.target.value);
              }}
            >
              <option value="">Select…</option>
              {options.map((record) => (
                <option key={record.id} value={record.id}>
                  {recordOptionLabel(record)}
                </option>
              ))}
            </select>
          </label>
          {needsLinkNote ? (
            <label
              className="grid gap-1.5 text-sm font-medium text-text-strong sm:col-span-2"
              htmlFor={`${id}-link-note`}
            >
              <span>What happened and what you did · required</span>
              <Textarea
                id={`${id}-link-note`}
                className="min-h-20 bg-surface-raised"
                maxLength={2000}
                aria-required
                aria-invalid={error && !linkNote.trim() ? true : undefined}
                aria-describedby={error ? `${id}-error` : undefined}
                value={linkNote}
                disabled={link.isPending}
                onChange={(event) => {
                  setError(null);
                  setLinkNote(event.target.value);
                }}
              />
            </label>
          ) : null}
          <Button
            type="submit"
            variant="outline"
            size="touch"
            className={needsLinkNote ? 'sm:col-start-2' : undefined}
            disabled={link.isPending}
          >
            {link.isPending ? 'Linking…' : 'Link record'}
          </Button>
        </form>
      )}
      {!another && linked.some((row) => row.detail?.outOfRange) ? (
        <p className="text-sm text-warning">{outOfRangeAdvice(excursionStep, stepTitle)}</p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
