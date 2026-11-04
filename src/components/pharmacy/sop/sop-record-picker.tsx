'use client';

import Link from 'next/link';
import { useId, useState } from 'react';

import { fieldClass } from '@/components/pharmacy/dispensing/field';
import { Button } from '@/components/ui/button';
import { trpc } from '@/lib/trpc';

import {
  errorMessage,
  RECORD_LABEL,
  type SopLinkableRecord,
  type SopOccurrence,
  type SopRecordType,
} from './sop-model';

type SopRecordLink = SopOccurrence['recordLinks'][number];

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
};

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
}: SopRecordPickerProps) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const label = RECORD_LABEL[recordType];
  const records = trpc.pharmacySop.linkableRecords.useQuery(
    { pharmacyBranchId, occurrenceId, recordType },
    { retry: false }
  );
  const link = trpc.pharmacySop.linkRecord.useMutation({
    onSuccess: () => {
      setError(null);
      onChange('');
      onLinked();
    },
    onError: (cause) => setError(errorMessage(cause, `The ${label} could not be linked. Retry.`)),
  });
  const linkedIds = new Set(linked.map((row) => row.recordId));
  const all: SopLinkableRecord[] = records.data ?? [];
  const byId = new Map(all.map((record) => [record.id, record]));
  const options = all.filter((record) => !linkedIds.has(record.id));
  const describe = (record: SopLinkableRecord) =>
    record.outOfRange ? `${record.label} · out of range` : record.label;
  const home = RECORD_HOME[recordType];

  return (
    <div className="grid gap-3 rounded-md border border-border-subtle bg-surface-sunken p-4">
      <p className="text-sm font-medium text-text-strong">
        Linked {label}
        {linked.length ? '' : ' · required'}
      </p>
      {linked.length ? (
        <ul className="grid gap-1 text-sm text-text-body">
          {linked.map((row) => {
            const record = byId.get(row.recordId);
            return <li key={row.id}>{record ? describe(record) : `Linked ${label}`}</li>;
          })}
        </ul>
      ) : null}
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
            link.mutate({
              pharmacyBranchId,
              occurrenceId,
              occurrenceStepId,
              recordType,
              recordId: value,
            });
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium text-text-strong" htmlFor={id}>
            <span>Choose the {label}</span>
            <select
              id={id}
              aria-label={`${label} for ${stepTitle}`}
              aria-invalid={error ? true : undefined}
              className={fieldClass}
              value={value}
              disabled={link.isPending}
              onChange={(event) => onChange(event.target.value)}
            >
              <option value="">Select…</option>
              {options.map((record) => (
                <option key={record.id} value={record.id}>
                  {describe(record)}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="outline" size="touch" disabled={link.isPending}>
            {link.isPending ? 'Linking…' : 'Link record'}
          </Button>
        </form>
      )}
      {linked.some((row) => byId.get(row.recordId)?.outOfRange) ? (
        <p className="text-sm text-warning">
          A linked reading is out of range. Write what happened and what you did in the note before
          sending this for review.
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
