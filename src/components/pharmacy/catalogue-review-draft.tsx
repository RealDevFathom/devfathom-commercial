'use client';

import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * Start the review of a default-catalogue medicine from the workbench: the
 * pharmacist checks what the catalogue (or, for a held hand-entered medicine,
 * its own record) says, supplies what the catalogue does not carry — pack,
 * DRAP registration, and for a NARCOTICS item the controlled decision — and
 * submits. That only drafts UNREVIEWED assertions; the medicine stays
 * unsaleable until they are accepted and published below.
 */

export type CatalogueReviewCandidate = {
  id: string;
  productName: string;
  brandName: string | null;
  manufacturer: string | null;
  drapRegistrationNumber: string | null;
  productFamily: string;
  presentations: ReadonlyArray<{ dosageForm: string | null; presentation: string }>;
  strengths: ReadonlyArray<{ value: unknown; unit: string }>;
  catalogueProvenance: { controlledCandidate: boolean; linkedExisting: boolean } | null;
  catalogueItem: { strength: string | null; dosageForm: string | null } | null;
};

export type CatalogueReviewDraftValues = {
  productName: string;
  strength: string;
  dosageForm: string;
  pack: string;
  drapRegistrationNumber: string;
  alias: string;
  controlled: '' | 'true' | 'false';
};

/** The values the form opens with; the server applies the same defaults. */
export function catalogueReviewInitialValues(
  candidate: CatalogueReviewCandidate
): CatalogueReviewDraftValues {
  const presentation = candidate.presentations[0];
  const strength = candidate.strengths[0];
  const ownStrength = strength ? `${String(strength.value)} ${strength.unit}` : '';
  const linked = candidate.catalogueProvenance?.linkedExisting ?? false;
  const catalogueStrength = candidate.catalogueItem?.strength ?? '';
  const catalogueForm = candidate.catalogueItem?.dosageForm ?? '';
  return {
    productName: candidate.productName,
    strength: linked ? ownStrength || catalogueStrength : catalogueStrength || ownStrength,
    dosageForm: linked
      ? (presentation?.dosageForm ?? '') || catalogueForm
      : catalogueForm || (presentation?.dosageForm ?? ''),
    pack: presentation?.presentation ?? '',
    drapRegistrationNumber: candidate.drapRegistrationNumber ?? '',
    alias: '',
    controlled: '',
  };
}

const inputClass =
  'mt-1 min-h-11 w-full rounded-sm border border-border-default bg-surface-raised px-3 text-sm text-text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-destructive';

export function CatalogueReviewDraft({
  candidate,
  pending,
  error,
  onSubmit,
}: {
  candidate: CatalogueReviewCandidate;
  pending: boolean;
  error: string | null;
  onSubmit: (values: CatalogueReviewDraftValues) => void;
}) {
  const [values, setValues] = useState(() => catalogueReviewInitialValues(candidate));
  const [touched, setTouched] = useState(false);
  const formId = useId();
  const controlledCandidate = candidate.catalogueProvenance?.controlledCandidate ?? false;
  const registrationRequired = candidate.productFamily !== 'FRONT_SHOP';
  const missing = {
    productName: !values.productName.trim(),
    strength: !values.strength.trim(),
    dosageForm: !values.dosageForm.trim(),
    pack: !values.pack.trim(),
    drapRegistrationNumber: registrationRequired && !values.drapRegistrationNumber.trim(),
    controlled: controlledCandidate && !values.controlled,
  };
  const incomplete = Object.values(missing).some(Boolean);
  const errorId = `${formId}-error`;

  const set = (field: keyof CatalogueReviewDraftValues) => (value: string) =>
    setValues((current) => ({ ...current, [field]: value }));

  const text = (
    field: Exclude<keyof CatalogueReviewDraftValues, 'controlled'>,
    label: string,
    hint?: string
  ) => {
    const invalid = touched && field in missing && missing[field as keyof typeof missing];
    const id = `${formId}-${field}`;
    const describedBy = [hint ? `${id}-hint` : null, invalid ? errorId : null]
      .filter(Boolean)
      .join(' ');
    return (
      <div className="text-xs font-medium text-text-body">
        <label className="block" htmlFor={id}>
          {label}
        </label>
        <input
          id={id}
          className={inputClass}
          name={field}
          value={values[field]}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy || undefined}
          onChange={(event) => set(field)(event.target.value)}
        />
        {hint ? (
          <span id={`${id}-hint`} className="mt-1 block text-[11px] text-text-muted">
            {hint}
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <form
      aria-label={`Complete ${candidate.productName} for review`}
      className="mt-4 space-y-4 rounded-sm bg-surface-sunken p-4"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (incomplete) return;
        onSubmit(values);
      }}
    >
      <p className="text-sm text-text-muted">
        {candidate.catalogueProvenance?.linkedExisting
          ? 'Your own record, held from sale because the default catalogue filed it under NARCOTICS. Check it, record the controlled decision, and start the review.'
          : 'From the default catalogue. Add what it does not carry — pack and DRAP registration — then start the review. Nothing sells until the review is published.'}
      </p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {text('productName', 'Product name')}
        {text('strength', 'Strength', 'One number and unit, e.g. 500 mg')}
        {text('dosageForm', 'Dosage form')}
        {text('pack', 'Pack')}
        {text(
          'drapRegistrationNumber',
          'DRAP registration',
          registrationRequired ? undefined : 'Optional for front-shop items'
        )}
        {text('alias', 'Generic name', 'Optional; becomes the strength ingredient')}
        {controlledCandidate ? (
          <div className="text-xs font-medium text-text-body">
            <label className="block" htmlFor={`${formId}-controlled`}>
              Controlled decision
            </label>
            <select
              id={`${formId}-controlled`}
              className={inputClass}
              name="controlled"
              value={values.controlled}
              aria-invalid={(touched && missing.controlled) || undefined}
              aria-describedby={touched && missing.controlled ? errorId : undefined}
              onChange={(event) => set('controlled')(event.target.value)}
            >
              <option value="">Choose a reviewed decision</option>
              <option value="true">Controlled</option>
              <option value="false">Not controlled</option>
            </select>
          </div>
        ) : null}
      </div>
      {touched && incomplete ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          Fill in every highlighted field before starting the review.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button className="min-h-11" type="submit" disabled={pending}>
        {pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
        {pending ? 'Starting review…' : 'Start review'}
      </Button>
    </form>
  );
}
