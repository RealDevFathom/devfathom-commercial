'use client';

import { useId, useState, type FormEvent } from 'react';
import { Loader2, Search } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';

type Draft = {
  productName: string;
  strength: string;
  dosageForm: string;
  pack: string;
  drapRegistrationNumber: string;
  /** null until the person (or a stated DRAP flag) answers; never defaulted. */
  rx: boolean | null;
  controlled: boolean | null;
};

type FlagField = 'rx' | 'controlled';

type ReferenceValues = {
  productName?: string;
  strength?: string;
  dosageForm?: string;
  drapRegistrationNumber?: string;
  rx?: boolean;
  controlled?: boolean;
};

type AppliedReference = { referenceId: string; fileName: string; values: ReferenceValues };

const EMPTY_DRAFT: Draft = {
  productName: '',
  strength: '',
  dosageForm: '',
  pack: '',
  drapRegistrationNumber: '',
  rx: null,
  controlled: null,
};

const SEARCH_MIN_LENGTH = 2;

const inputClass =
  'mt-1 min-h-11 w-full rounded-control border border-border-default bg-surface-raised px-3 text-sm text-text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring read-only:bg-surface-sunken disabled:opacity-60';

function flagLabel(value: boolean | undefined, yes: string, no: string, unknown: string) {
  if (value === undefined) return unknown;
  return value ? yes : no;
}

const FLAG_FIELDS: ReadonlyArray<readonly [FlagField, string]> = [
  ['rx', 'Prescription only'],
  ['controlled', 'Controlled drug'],
];

/**
 * DEV-683: the add-medicine form. A catalogue editor may pre-fill an unsaved draft from the
 * organisation's imported DRAP reference rows; nothing is saved until they confirm, and the
 * saved draft is published only through the catalogue review workbench. Prices are never filled.
 */
export function AddMedicineForm() {
  const formId = useId();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [reference, setReference] = useState<AppliedReference | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const utils = trpc.useUtils();
  const access = trpc.pharmacyMedicine.catalogueQueueAccess.useQuery(undefined, { retry: false });
  const canEdit = access.data?.canEdit === true;
  const lookup = trpc.pharmacyMedicine.drapReferenceSearch.useQuery(
    { query: term },
    { enabled: canEdit, retry: false }
  );
  const save = trpc.pharmacyMedicine.addMedicineDraft.useMutation({
    onSuccess: async (medicine) => {
      toast.success(
        `${medicine.productName} was saved as a draft. It is not saleable until a reviewer accepts and publishes it.`
      );
      setDraft(EMPTY_DRAFT);
      setReference(null);
      setSubmitted(false);
      await utils.pharmacyMedicine.referenceCandidates.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  if (access.isPending)
    return (
      <SectionCard title="Add medicine" titleLevel={2}>
        <p role="status" className="flex items-center gap-2 text-sm text-text-muted">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Checking catalogue
          permission…
        </p>
      </SectionCard>
    );
  if (!canEdit)
    return (
      <SectionCard title="Add medicine" titleLevel={2}>
        <p className="text-sm text-text-muted">
          Adding medicines needs the catalogue edit permission. No reference data was shown and
          nothing was changed.
        </p>
      </SectionCard>
    );

  const flagsLocked = {
    rx: reference?.values.rx !== undefined,
    controlled: reference?.values.controlled !== undefined,
  };
  const registrationLocked = reference?.values.drapRegistrationNumber !== undefined;
  const hasReferenceData = lookup.data?.hasReferenceData === true;

  function update<K extends keyof Draft>(field: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function runSearch(event: FormEvent) {
    event.preventDefault();
    setTerm(search.trim());
  }

  function applyReference(row: { referenceId: string; fileName: string; values: ReferenceValues }) {
    // Only reference values are copied; pack and anything else the person enters stays theirs.
    setDraft((current) => ({
      ...current,
      productName: row.values.productName ?? '',
      strength: row.values.strength ?? '',
      dosageForm: row.values.dosageForm ?? '',
      drapRegistrationNumber: row.values.drapRegistrationNumber ?? '',
      // A flag the DRAP row does not state stays unanswered until the person chooses.
      rx: row.values.rx ?? null,
      controlled: row.values.controlled ?? null,
    }));
    setReference(row);
    setSubmitted(false);
  }

  function clearReference() {
    setReference(null);
    setDraft(EMPTY_DRAFT);
    setSubmitted(false);
  }

  function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (!event.currentTarget.checkValidity() || draft.rx === null || draft.controlled === null)
      return;
    save.mutate({
      ...draft,
      ...(reference ? { drapReferenceId: reference.referenceId } : {}),
    });
  }

  const invalid = (field: keyof Draft) =>
    submitted && typeof draft[field] === 'string' && !(draft[field] as string).trim();

  const textFields: Array<{ field: keyof Draft; label: string; hint?: string }> = [
    { field: 'productName', label: 'New medicine name' },
    { field: 'strength', label: 'Strength', hint: 'For example 500 mg' },
    { field: 'dosageForm', label: 'Dosage form', hint: 'For example Tablet' },
    {
      field: 'pack',
      label: 'Pack',
      hint: 'State a unit count, such as 10 tablets or 3 x 10',
    },
    { field: 'drapRegistrationNumber', label: 'DRAP registration number' },
  ];

  return (
    <SectionCard
      eyebrow="Catalogue / add medicine"
      title="Add medicine"
      titleLevel={2}
      role="region"
      aria-label="Add medicine"
    >
      <div className="space-y-5">
        {lookup.isPending ? (
          <p role="status" className="flex items-center gap-2 text-sm text-text-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Checking DRAP reference
            data…
          </p>
        ) : lookup.error ? (
          <p role="alert" className="text-sm text-destructive">
            DRAP reference search is unavailable: {lookup.error.message} You can still enter the
            medicine below.
          </p>
        ) : !hasReferenceData ? (
          <p className="rounded-md bg-surface-sunken px-4 py-4 text-sm text-text-muted">
            No DRAP reference data has been uploaded for this pharmacy, so there is nothing to
            auto-fill. Enter the medicine yourself below. An administrator can upload the DRAP
            registered-products export under Medicine reference connectors.
          </p>
        ) : (
          <div className="space-y-3">
            <form role="search" className="flex flex-wrap items-end gap-2" onSubmit={runSearch}>
              <label className="block min-w-0 flex-1 text-sm font-medium text-text-body">
                Search DRAP reference by name or registration number
                <input
                  className={inputClass}
                  type="search"
                  value={search}
                  minLength={SEARCH_MIN_LENGTH}
                  maxLength={100}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <Button className="min-h-11" type="submit" variant="secondary">
                {lookup.isFetching ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" />
                ) : (
                  <Search data-icon="inline-start" />
                )}
                Search
              </Button>
            </form>
            {term.length >= SEARCH_MIN_LENGTH && !lookup.isFetching ? (
              lookup.data?.matches.length ? (
                <ul aria-label="DRAP reference matches" className="space-y-2">
                  {lookup.data.matches.map((row) => {
                    const rx = flagLabel(
                      row.values.rx,
                      'Prescription only',
                      'Not prescription',
                      'Prescription status not stated'
                    );
                    const controlled = flagLabel(
                      row.values.controlled,
                      'Controlled',
                      'Not controlled',
                      'Controlled status not stated'
                    );
                    return (
                      <li
                        key={row.referenceId}
                        className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-md border border-border-subtle p-3"
                      >
                        <div className="min-w-0">
                          <p className="font-medium text-text-strong">{row.values.productName}</p>
                          <p className="mt-1 break-words text-xs text-text-muted">
                            {[
                              row.values.strength,
                              row.values.dosageForm,
                              row.values.drapRegistrationNumber
                                ? `Reg. ${row.values.drapRegistrationNumber}`
                                : null,
                              rx,
                              controlled,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                        </div>
                        {row.inCatalogue ? (
                          <StatusPill status="Already in catalogue" tone="neutral" />
                        ) : (
                          <Button
                            className="min-h-11"
                            type="button"
                            variant="outline"
                            aria-label={`Use ${row.values.productName}`}
                            onClick={() => applyReference(row)}
                          >
                            Use this row
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-text-muted">
                  No DRAP reference row matches “{term}”. Check the spelling or enter the medicine
                  yourself.
                </p>
              )
            ) : null}
          </div>
        )}

        {reference ? (
          <div
            role="status"
            className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border-subtle bg-surface-sunken p-3"
          >
            <div className="min-w-0 space-y-1">
              <StatusPill status="Unsaved draft" tone="warning" />
              <p className="text-sm text-text-body">
                Pre-filled from the DRAP reference file {reference.fileName}. Check every value;
                nothing is saved until you confirm. Prices are never filled.
              </p>
            </div>
            <Button className="min-h-11" type="button" variant="outline" onClick={clearReference}>
              Clear auto-fill
            </Button>
          </div>
        ) : null}

        <form
          id={formId}
          noValidate
          aria-label="New medicine draft"
          className="space-y-4"
          onSubmit={confirm}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {textFields.map(({ field, label, hint }) => {
              const locked = field === 'drapRegistrationNumber' && registrationLocked;
              const errorId = `${formId}-${field}-error`;
              return (
                <label key={field} className="block min-w-0 text-sm font-medium text-text-body">
                  {label}
                  <input
                    className={inputClass}
                    name={field}
                    required
                    maxLength={field === 'productName' || field === 'pack' ? 300 : 100}
                    readOnly={locked}
                    value={draft[field] as string}
                    aria-invalid={invalid(field) || undefined}
                    aria-describedby={invalid(field) ? errorId : undefined}
                    onChange={(event) => update(field, event.target.value)}
                  />
                  {locked ? (
                    <span className="mt-1 block text-xs font-normal text-text-muted">
                      From the DRAP reference row
                    </span>
                  ) : hint ? (
                    <span className="mt-1 block text-xs font-normal text-text-muted">{hint}</span>
                  ) : null}
                  {invalid(field) ? (
                    <span id={errorId} className="mt-1 block text-xs text-destructive">
                      {label} is required.
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
          {FLAG_FIELDS.map(([field, label]) => {
            const locked = flagsLocked[field];
            const missing = submitted && draft[field] === null;
            const errorId = `${formId}-${field}-error`;
            return (
              <fieldset
                key={field}
                className="min-w-0 space-y-1"
                aria-invalid={missing || undefined}
                aria-describedby={missing ? errorId : undefined}
              >
                <legend className="text-sm font-medium text-text-body">{label}</legend>
                {locked ? (
                  <p className="text-xs text-text-muted">From the DRAP reference row</p>
                ) : reference ? (
                  <p className="text-xs text-text-muted">
                    Not stated in the DRAP reference. Choose yes or no.
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-4">
                  {(
                    [
                      [true, 'Yes'],
                      [false, 'No'],
                    ] as const
                  ).map(([value, text]) => (
                    <label
                      key={text}
                      className="flex min-h-11 items-center gap-2 text-sm text-text-body"
                    >
                      <input
                        type="radio"
                        name={`${formId}-${field}`}
                        className="size-4 focus-visible:outline-2 focus-visible:outline-ring"
                        checked={draft[field] === value}
                        disabled={locked}
                        onChange={() => update(field, value)}
                      />
                      {text}
                    </label>
                  ))}
                </div>
                {missing ? (
                  <span id={errorId} className="block text-xs text-destructive">
                    Choose yes or no.
                  </span>
                ) : null}
              </fieldset>
            );
          })}
          <p className="text-xs text-text-muted">
            The draft is saved without a price and is not saleable. It appears in the reference
            review workbench, where a reviewer accepts and publishes it.
          </p>
          <Button className="min-h-11" type="submit" disabled={save.isPending}>
            {save.isPending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
            {save.isPending ? 'Saving draft…' : 'Confirm and save draft'}
          </Button>
        </form>
      </div>
    </SectionCard>
  );
}
