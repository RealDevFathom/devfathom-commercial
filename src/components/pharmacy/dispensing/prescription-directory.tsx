'use client';

import { useState, type FormEvent } from 'react';
import { UserPlus } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { Field, fieldClass } from './field';

export const addPatientAnchor = 'add-patient';
export const addPrescriberAnchor = 'add-prescriber';

const optional = (value: FormDataEntryValue | null) => {
  const text = String(value ?? '').trim();
  return text ? text : undefined;
};

/**
 * Patient and prescriber directory entry for the capture form. Each new record
 * is selected in the capture form once the workspace has refreshed.
 */
export function PrescriptionDirectory({
  onPatientCreated,
  onPrescriberCreated,
}: {
  onPatientCreated: (id: string) => void;
  onPrescriberCreated: (id: string) => void;
}) {
  const utils = trpc.useUtils();
  const createPatient = trpc.pharmacyPrescriptions.createPatient.useMutation();
  const createPrescriber = trpc.pharmacyPrescriptions.createPrescriber.useMutation();
  const [patientNotice, setPatientNotice] = useState('');
  const [prescriberNotice, setPrescriberNotice] = useState('');

  async function refresh() {
    try {
      await utils.pharmacyPrescriptions.workspace.invalidate();
    } catch {
      // The record is saved; the capture form picks it up on the next load.
    }
  }

  async function submitPatient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setPatientNotice('');
    const data = new FormData(form);
    try {
      const patient = await createPatient.mutateAsync({
        displayName: String(data.get('displayName') ?? '').trim(),
        phone: optional(data.get('phone')),
      });
      form.reset();
      await refresh();
      onPatientCreated(patient.id);
      setPatientNotice(`${patient.displayName} added and selected for capture.`);
    } catch {
      // The mutation error is rendered below.
    }
  }

  async function submitPrescriber(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setPrescriberNotice('');
    const data = new FormData(form);
    try {
      const prescriber = await createPrescriber.mutateAsync({
        name: String(data.get('name') ?? '').trim(),
        registrationNumber: String(data.get('registrationNumber') ?? '').trim(),
        phone: optional(data.get('phone')),
        facility: optional(data.get('facility')),
      });
      form.reset();
      await refresh();
      onPrescriberCreated(prescriber.id);
      setPrescriberNotice(`${prescriber.name} added and selected for capture.`);
    } catch {
      // The mutation error is rendered below.
    }
  }

  return (
    <SectionCard title="Patients and prescribers" titleLevel={2}>
      <p className="mb-5 max-w-2xl text-sm leading-relaxed text-text-muted">
        Every prescription is captured against a patient and a prescriber from this
        organization&apos;s directory. Add them here if they are not listed yet.
      </p>
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <form
          id={addPatientAnchor}
          aria-labelledby={`${addPatientAnchor}-title`}
          aria-busy={createPatient.isPending}
          onSubmit={submitPatient}
          className="scroll-mt-6 rounded-lg border border-border-subtle bg-surface-sunken p-5"
        >
          <fieldset disabled={createPatient.isPending} className="grid min-w-0 gap-4">
            <h3 id={`${addPatientAnchor}-title`} className="font-semibold text-text-strong">
              Add patient
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Patient name" required>
                <input
                  required
                  aria-required
                  name="displayName"
                  maxLength={200}
                  autoComplete="off"
                  className={fieldClass}
                />
              </Field>
              <Field label="Phone" hint="Optional. Stored masked in this workspace.">
                <input
                  name="phone"
                  type="tel"
                  maxLength={32}
                  autoComplete="off"
                  className={fieldClass}
                />
              </Field>
            </div>
            {createPatient.error ? (
              <p role="alert" className="text-sm text-destructive">
                {createPatient.error.message} The patient was not added.
              </p>
            ) : null}
            {patientNotice ? (
              <p role="status" className="text-sm text-success">
                {patientNotice}
              </p>
            ) : null}
            <Button type="submit" variant="outline" size="touch" className="w-fit">
              <UserPlus aria-hidden />
              {createPatient.isPending ? 'Adding patient…' : 'Add patient'}
            </Button>
          </fieldset>
        </form>
        <form
          id={addPrescriberAnchor}
          aria-labelledby={`${addPrescriberAnchor}-title`}
          aria-busy={createPrescriber.isPending}
          onSubmit={submitPrescriber}
          className="scroll-mt-6 rounded-lg border border-border-subtle bg-surface-sunken p-5"
        >
          <fieldset disabled={createPrescriber.isPending} className="grid min-w-0 gap-4">
            <h3 id={`${addPrescriberAnchor}-title`} className="font-semibold text-text-strong">
              Add prescriber
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Prescriber name" required>
                <input
                  required
                  aria-required
                  name="name"
                  maxLength={200}
                  autoComplete="off"
                  className={fieldClass}
                />
              </Field>
              <Field label="Registration number" required hint="Unique within your organization.">
                <input
                  required
                  aria-required
                  name="registrationNumber"
                  maxLength={64}
                  autoComplete="off"
                  className={fieldClass}
                />
              </Field>
              <Field label="Phone" hint="Optional.">
                <input
                  name="phone"
                  type="tel"
                  maxLength={32}
                  autoComplete="off"
                  className={fieldClass}
                />
              </Field>
              <Field label="Facility" hint="Optional.">
                <input name="facility" maxLength={200} autoComplete="off" className={fieldClass} />
              </Field>
            </div>
            {createPrescriber.error ? (
              <p role="alert" className="text-sm text-destructive">
                {createPrescriber.error.message} The prescriber was not added.
              </p>
            ) : null}
            {prescriberNotice ? (
              <p role="status" className="text-sm text-success">
                {prescriberNotice}
              </p>
            ) : null}
            <Button type="submit" variant="outline" size="touch" className="w-fit">
              <UserPlus aria-hidden />
              {createPrescriber.isPending ? 'Adding prescriber…' : 'Add prescriber'}
            </Button>
          </fieldset>
        </form>
      </div>
    </SectionCard>
  );
}
