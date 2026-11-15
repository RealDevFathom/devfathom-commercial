'use client';

import { useState, type FormEvent } from 'react';
import { Stethoscope, UserPlus } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { Field, fieldClass } from './field';

export const PRESCRIPTION_DIRECTORY_ID = 'prescription-directory';

function text(data: FormData, name: string) {
  return String(data.get(name) ?? '').trim();
}

type Outcome = { tone: 'success' | 'error'; message: string } | null;

function OutcomeMessage({ id, outcome }: { id: string; outcome: Outcome }) {
  if (!outcome) return null;
  return outcome.tone === 'error' ? (
    <p id={id} role="alert" className="text-sm text-destructive">
      {outcome.message}
    </p>
  ) : (
    <p id={id} role="status" className="text-sm text-success">
      {outcome.message}
    </p>
  );
}

/**
 * DEV-626: the pharmacist registers the patient and the prescribing doctor in
 * place, so an Rx line can be captured without a separate admin screen. The
 * server gates both writes on `pharmacy:prescriptions`.
 */
export function PrescriptionDirectoryCard({
  onPatientAdded,
  onPrescriberAdded,
}: {
  onPatientAdded: (patientId: string) => void;
  onPrescriberAdded: (prescriberId: string) => void;
}) {
  const utils = trpc.useUtils();
  const createPatient = trpc.pharmacyPrescriptions.createPatient.useMutation();
  const createPrescriber = trpc.pharmacyPrescriptions.createPrescriber.useMutation();
  const [patientOutcome, setPatientOutcome] = useState<Outcome>(null);
  const [prescriberOutcome, setPrescriberOutcome] = useState<Outcome>(null);
  const [duplicateRegistration, setDuplicateRegistration] = useState(false);

  async function refresh() {
    try {
      await utils.pharmacyPrescriptions.workspace.invalidate();
    } catch {
      // The record is saved; the lists catch up on the next load.
    }
  }

  async function addPatient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createPatient.isPending) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setPatientOutcome(null);
    try {
      const patient = await createPatient.mutateAsync({
        displayName: text(data, 'displayName'),
        phone: text(data, 'phone'),
        cnic: text(data, 'cnic'),
      });
      form.reset();
      // Refresh first so the new entry is in the lists when it is selected.
      await refresh();
      onPatientAdded(patient.id);
      setPatientOutcome({
        tone: 'success',
        message: `${patient.displayName} added and selected for capture.`,
      });
    } catch (error) {
      setPatientOutcome({
        tone: 'error',
        message: `${error instanceof Error ? error.message : 'The request failed.'} Patient not added; your entries are kept.`,
      });
    }
  }

  async function addPrescriber(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createPrescriber.isPending) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setPrescriberOutcome(null);
    setDuplicateRegistration(false);
    try {
      const prescriber = await createPrescriber.mutateAsync({
        name: text(data, 'name'),
        registrationNumber: text(data, 'registrationNumber'),
        phone: text(data, 'phone'),
        facility: text(data, 'facility'),
      });
      form.reset();
      // Refresh first so the new entry is in the lists when it is selected.
      await refresh();
      onPrescriberAdded(prescriber.id);
      setPrescriberOutcome({
        tone: 'success',
        message: `${prescriber.name} added and selected for capture.`,
      });
    } catch (error) {
      const conflict =
        (error as { data?: { code?: string } | null } | null)?.data?.code === 'CONFLICT';
      setDuplicateRegistration(conflict);
      setPrescriberOutcome({
        tone: 'error',
        message: `${error instanceof Error ? error.message : 'The request failed.'} Prescriber not added; your entries are kept.`,
      });
    }
  }

  return (
    <SectionCard id={PRESCRIPTION_DIRECTORY_ID} title="Patients and prescribers" titleLevel={2}>
      <p className="mb-4 text-sm text-text-muted">
        Add the patient or prescribing doctor here when they are not in the lists yet. A new entry
        is selected in the capture form.
      </p>
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <form aria-label="Add patient" aria-busy={createPatient.isPending} onSubmit={addPatient}>
          <fieldset disabled={createPatient.isPending} className="grid min-w-0 gap-4">
            <legend className="mb-2 font-mono text-xs tracking-wide text-text-muted uppercase">
              New patient
            </legend>
            <Field label="Patient name">
              <input required name="displayName" maxLength={200} className={fieldClass} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Phone (optional)">
                <input name="phone" type="tel" maxLength={32} className={fieldClass} />
              </Field>
              <Field label="CNIC (optional)">
                <input name="cnic" maxLength={32} className={fieldClass} />
              </Field>
            </div>
            <OutcomeMessage id="add-patient-outcome" outcome={patientOutcome} />
            <Button type="submit" variant="outline" size="lg" className="h-11 justify-self-start">
              <UserPlus aria-hidden />
              {createPatient.isPending ? 'Adding patient…' : 'Add patient'}
            </Button>
          </fieldset>
        </form>
        <form
          aria-label="Add prescriber"
          aria-busy={createPrescriber.isPending}
          onSubmit={addPrescriber}
        >
          <fieldset disabled={createPrescriber.isPending} className="grid min-w-0 gap-4">
            <legend className="mb-2 font-mono text-xs tracking-wide text-text-muted uppercase">
              New prescriber
            </legend>
            {/* Top-align: the registration hint must not stretch the name field. */}
            <div className="grid items-start gap-4 sm:grid-cols-2">
              <Field label="Doctor name">
                <input required name="name" maxLength={200} className={fieldClass} />
              </Field>
              <Field
                label="Registration number"
                hint="The doctor's medical council registration, as printed on the prescription."
              >
                <input
                  required
                  name="registrationNumber"
                  maxLength={64}
                  aria-invalid={duplicateRegistration}
                  aria-describedby={duplicateRegistration ? 'add-prescriber-outcome' : undefined}
                  className={`${fieldClass} aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20`}
                />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Phone (optional)">
                <input name="phone" type="tel" maxLength={32} className={fieldClass} />
              </Field>
              <Field label="Clinic or hospital (optional)">
                <input name="facility" maxLength={200} className={fieldClass} />
              </Field>
            </div>
            <OutcomeMessage id="add-prescriber-outcome" outcome={prescriberOutcome} />
            <Button type="submit" variant="outline" size="lg" className="h-11 justify-self-start">
              <Stethoscope aria-hidden />
              {createPrescriber.isPending ? 'Adding prescriber…' : 'Add prescriber'}
            </Button>
          </fieldset>
        </form>
      </div>
    </SectionCard>
  );
}
