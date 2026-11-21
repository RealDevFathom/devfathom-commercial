'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, fieldClass } from './field';

export type SubstitutionChoice = { id: string; label: string };
export type SubstitutionValue = {
  suppliedPresentationId: string;
  equivalenceBasis: string;
  patientCommunication: string;
  jurisdictionRuleRef: string;
};

export function SubstitutionForm({
  prescribed,
  choices,
  pending = false,
  onSubmit,
}: {
  prescribed: SubstitutionChoice;
  choices: SubstitutionChoice[];
  pending?: boolean;
  onSubmit: (value: SubstitutionValue) => void | Promise<void>;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void onSubmit({
      suppliedPresentationId: String(data.get('suppliedPresentationId')),
      equivalenceBasis: String(data.get('equivalenceBasis')),
      patientCommunication: String(data.get('patientCommunication')),
      jurisdictionRuleRef: String(data.get('jurisdictionRuleRef')),
    });
  }
  return (
    <form className="grid gap-4" onSubmit={submit}>
      <Field label="Prescribed presentation">
        <input readOnly value={prescribed.label} className={fieldClass} />
      </Field>
      <Field label="Supplied presentation">
        <StudioSelect required name="suppliedPresentationId" className={fieldClass} defaultValue="">
          <option value="" disabled>
            Select supplied presentation
          </option>
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </StudioSelect>
      </Field>
      <Field label="Equivalence basis">
        <textarea
          required
          name="equivalenceBasis"
          className={`${fieldClass} min-h-20 py-3`}
          placeholder="Document strength, dosage form and clinical equivalence"
        />
      </Field>
      <Field label="Governing rule reference">
        <input
          required
          name="jurisdictionRuleRef"
          className={fieldClass}
          placeholder="Rule, formulary or approval reference"
        />
      </Field>
      <Field label="Patient communication">
        <textarea
          required
          name="patientCommunication"
          className={`${fieldClass} min-h-20 py-3`}
          placeholder="What was explained and how the patient responded"
        />
      </Field>
      <label className="flex min-h-11 items-center gap-3 rounded-sm border border-border-subtle px-3 text-sm text-text-strong">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        Patient communication was acknowledged
      </label>
      <Button size="lg" disabled={!acknowledged || pending} type="submit">
        {pending ? 'Recording…' : 'Record substitution'}
      </Button>
    </form>
  );
}
