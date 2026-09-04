'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { CalendarClock, Plus, Upload } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Field, WorkspaceState, fieldClass } from './field';
import { MedicationCard } from './medication-card';

const today = () => new Date().toISOString().slice(0, 10);

export function PrescriptionsConsole() {
  const utils = trpc.useUtils();
  const [selectedBranchId, setSelectedBranchId] = useState('');
  const workspace = trpc.pharmacyPrescriptions.workspace.useQuery(
    selectedBranchId ? { branchId: selectedBranchId } : undefined
  );
  const capture = trpc.pharmacyPrescriptions.capture.useMutation({
    onSuccess: async () => {
      await utils.pharmacyPrescriptions.workspace.invalidate();
      setNotice('Prescription captured and ready for dispensing review.');
    },
  });
  const captureReminder = trpc.pharmacyPrescriptions.captureRefillReminder.useMutation({
    onSuccess: async () => {
      await utils.pharmacyPrescriptions.workspace.invalidate();
      setNotice('Refill reminder captured. Nothing has been sent.');
    },
  });
  const [notice, setNotice] = useState('');
  const [medicineId, setMedicineId] = useState('');
  const medicine = useMemo(
    () => workspace.data?.medicines.find((item) => item.id === medicineId),
    [medicineId, workspace.data]
  );

  const effectiveBranchId = selectedBranchId || workspace.data?.selectedBranchId || '';

  const dispensedFills = useMemo(
    () =>
      workspace.data?.prescriptions.flatMap((prescription) =>
        prescription.lines.flatMap((line) =>
          line.fills.map((fill) => ({
            fill,
            patientName: prescription.patient.displayName,
            medicineName: line.medicine.productName,
            directions: line.directions,
          }))
        )
      ) ?? [],
    [workspace.data]
  );

  async function submitReminder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice('');
    const data = new FormData(event.currentTarget);
    const fillId = String(data.get('fillId'));
    await captureReminder.mutateAsync({
      branchId: effectiveBranchId,
      fillId,
      channel: String(data.get('channel')) as 'PHONE' | 'SMS' | 'WHATSAPP' | 'EMAIL',
      directionsUrdu: String(data.get('directionsUrdu')),
      idempotencyKey: `rx-07:${effectiveBranchId}:${fillId}`,
    });
  }

  const reminderError = captureReminder.error?.message
    ? ({
        REMINDER_CONSENT_REQUIRED:
          'Reminder refused: record active consent for this patient, purpose and channel first.',
        PHARMACIST_APPROVAL_REQUIRED:
          'Reminder refused: this Rx item needs a signed pharmacist decision first.',
        AMBIGUOUS_DIRECTIONS:
          'Reminder refused: directions must state a deterministic daily or hourly cadence.',
      }[captureReminder.error.message] ?? captureReminder.error.message)
    : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice('');
    const data = new FormData(event.currentTarget);
    const file = data.get('source') as File;
    await capture.mutateAsync({
      patientId: String(data.get('patientId')),
      prescriberId: String(data.get('prescriberId')),
      sourceKind: String(data.get('sourceKind')) as 'PAPER_IMAGE' | 'WHATSAPP_PHOTO',
      sourceFileRef: `capture://${file.name}`,
      custodyState: String(data.get('custodyState')) as 'NOT_HELD' | 'HELD_AT_PHARMACY',
      validFrom: new Date(String(data.get('validFrom'))),
      validUntil: new Date(String(data.get('validUntil'))),
      authorizedRepeats: Number(data.get('authorizedRepeats')),
      lines: [
        {
          lineNumber: 1,
          medicineId,
          presentationId: String(data.get('presentationId')),
          authorizedCanonicalUnits: Number(data.get('quantity')),
          directions: String(data.get('directions')),
        },
      ],
    });
    event.currentTarget.reset();
    setMedicineId('');
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Pharmacy · RX-02"
        heading="Prescriptions"
        description="Capture the original evidence, authority and every authorized unit before dispensing."
      />
      {workspace.isLoading ? (
        <WorkspaceState title="Loading prescriptions">
          Retrieving protected patient and prescription records.
        </WorkspaceState>
      ) : null}
      {workspace.error ? (
        <WorkspaceState title="Prescriptions could not be loaded" tone="danger">
          {workspace.error.message} Try again when the connection is restored.
        </WorkspaceState>
      ) : null}
      {workspace.data ? (
        <>
          <div className="grid gap-6 xl:grid-cols-[minmax(22rem,0.8fr)_minmax(32rem,1.2fr)]">
            <SectionCard title="Capture prescription" titleLevel={2}>
              <form className="grid gap-4" onSubmit={submit}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Patient">
                    <select required name="patientId" className={fieldClass} defaultValue="">
                      <option value="" disabled>
                        Select a patient
                      </option>
                      {workspace.data.patients.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.displayName}
                          {p.phone ? ` · ${p.phone}` : ''}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Prescriber">
                    <select required name="prescriberId" className={fieldClass} defaultValue="">
                      <option value="" disabled>
                        Select from directory
                      </option>
                      {workspace.data.prescribers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} · {p.registrationNumber}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Evidence type">
                    <select name="sourceKind" className={fieldClass}>
                      <option value="PAPER_IMAGE">Paper prescription</option>
                      <option value="WHATSAPP_PHOTO">Photo received digitally</option>
                    </select>
                  </Field>
                  <Field
                    label="Prescription image"
                    hint="The original image remains attached to this record."
                  >
                    <span className="relative">
                      <Upload
                        aria-hidden
                        className="pointer-events-none absolute top-3.5 left-3 size-4 text-text-muted"
                      />
                      <input
                        required
                        name="source"
                        type="file"
                        accept="image/*,.pdf"
                        className={`${fieldClass} file:mr-3 file:border-0 file:bg-transparent file:font-semibold pl-9 pt-2`}
                      />
                    </span>
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Valid from">
                    <input
                      required
                      name="validFrom"
                      type="date"
                      defaultValue={today()}
                      className={fieldClass}
                    />
                  </Field>
                  <Field label="Valid until">
                    <input required name="validUntil" type="date" className={fieldClass} />
                  </Field>
                  <Field label="Repeats">
                    <input
                      required
                      name="authorizedRepeats"
                      type="number"
                      min="0"
                      defaultValue="0"
                      className={fieldClass}
                    />
                  </Field>
                </div>
                <Field label="Original custody">
                  <select name="custodyState" className={fieldClass}>
                    <option value="NOT_HELD">Returned / not held</option>
                    <option value="HELD_AT_PHARMACY">Held at pharmacy</option>
                  </select>
                </Field>
                <div className="border-t border-border-subtle pt-4">
                  <p className="mb-3 font-mono text-xs tracking-wide text-text-muted uppercase">
                    Line 1
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Medicine">
                      <select
                        required
                        value={medicineId}
                        onChange={(e) => setMedicineId(e.target.value)}
                        className={fieldClass}
                      >
                        <option value="" disabled>
                          Select medicine
                        </option>
                        {workspace.data.medicines.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.productName}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Presentation">
                      <select
                        required
                        name="presentationId"
                        disabled={!medicine}
                        className={fieldClass}
                        defaultValue=""
                      >
                        <option value="" disabled>
                          Select presentation
                        </option>
                        {medicine?.presentations.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.presentation}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <Field label="Authorized units">
                      <input
                        required
                        name="quantity"
                        type="number"
                        min="1"
                        className={fieldClass}
                      />
                    </Field>
                    <Field label="Directions">
                      <input
                        required
                        name="directions"
                        className={fieldClass}
                        placeholder="e.g. One capsule every 8 hours"
                      />
                    </Field>
                  </div>
                </div>
                {capture.error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {capture.error.message}
                  </p>
                ) : null}
                {notice ? (
                  <p role="status" className="text-sm text-success">
                    {notice}
                  </p>
                ) : null}
                <Button size="lg" disabled={capture.isPending} type="submit">
                  <Plus aria-hidden />
                  {capture.isPending ? 'Capturing…' : 'Capture prescription'}
                </Button>
              </form>
            </SectionCard>
            <SectionCard title="Prescription register" titleLevel={2}>
              {workspace.data.prescriptions.length === 0 ? (
                <WorkspaceState title="No prescriptions yet">
                  Captured prescriptions will appear here with the remaining authorized quantity for
                  every line.
                </WorkspaceState>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[46rem] text-left text-sm">
                    <thead className="font-mono text-[0.65rem] tracking-wide text-text-muted uppercase">
                      <tr>
                        <th className="pb-3">Patient</th>
                        <th className="pb-3">Prescriber</th>
                        <th className="pb-3">Validity</th>
                        <th className="pb-3">Medicine</th>
                        <th className="pb-3 text-right">Remaining</th>
                        <th className="pb-3">Custody</th>
                      </tr>
                    </thead>
                    <tbody>
                      {workspace.data.prescriptions.flatMap((rx) =>
                        rx.lines.map((line) => (
                          <tr key={line.id} className="border-t border-border-subtle">
                            <td className="py-4 font-medium text-text-strong">
                              {rx.patient.displayName}
                            </td>
                            <td className="py-4">{rx.prescriber.name}</td>
                            <td className="py-4 tabular-nums">
                              {rx.validFrom.toLocaleDateString()}–
                              {rx.validUntil.toLocaleDateString()}
                            </td>
                            <td className="py-4">
                              {line.medicine.productName}
                              <span className="block text-xs text-text-muted">
                                {line.presentation.presentation}
                              </span>
                            </td>
                            <td className="py-4 text-right font-mono font-semibold tabular-nums">
                              {line.remainingAuthorizedUnits}
                            </td>
                            <td className="py-4">
                              <StatusPill
                                status={rx.custodyState}
                                label={rx.custodyState.replaceAll('_', ' ')}
                              />
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          </div>
          <SectionCard title="Refill support" titleLevel={2}>
            <div className="mb-5 flex flex-wrap items-end justify-between gap-4 border-b border-border-subtle pb-5">
              <div className="max-w-2xl">
                <p className="text-sm leading-relaxed text-text-muted">
                  Build a reminder from what was actually dispensed. Captures stay in the protected
                  patient context and are never sent from this workspace.
                </p>
              </div>
              <Field label="Dispensing branch">
                <select
                  aria-label="Dispensing branch"
                  className={`${fieldClass} min-w-56`}
                  value={effectiveBranchId}
                  disabled={workspace.data.branches.length === 0 || captureReminder.isPending}
                  onChange={(event) => setSelectedBranchId(event.target.value)}
                >
                  {workspace.data.branches.length === 0 ? (
                    <option value="">No active branch</option>
                  ) : null}
                  {workspace.data.branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {workspace.data.branches.length === 0 ? (
              <WorkspaceState title="No active pharmacy branch">
                Activate a branch before capturing refill reminders.
              </WorkspaceState>
            ) : dispensedFills.length === 0 ? (
              <WorkspaceState title="No dispensed items yet">
                A refill schedule becomes available after a prescription fill records the quantity
                actually dispensed.
              </WorkspaceState>
            ) : (
              <div className="space-y-6">
                {reminderError ? (
                  <div
                    role="alert"
                    className="rounded-md bg-destructive/10 p-4 text-sm text-destructive"
                  >
                    {reminderError}
                  </div>
                ) : null}
                {dispensedFills.map(({ fill, patientName, medicineName, directions }) => {
                  const reminder = workspace.data.reminderCaptures.find(
                    (capture) => capture.prescriptionFillId === fill.id
                  );
                  return reminder ? (
                    <MedicationCard
                      key={fill.id}
                      card={{
                        ...reminder,
                        reminderAt: new Date(reminder.reminderAt),
                        expectedExhaustionAt: new Date(reminder.expectedExhaustionAt),
                      }}
                    />
                  ) : (
                    <form
                      key={fill.id}
                      className="rounded-lg border border-border-subtle bg-surface-sunken p-5"
                      onSubmit={submitReminder}
                    >
                      <input type="hidden" name="fillId" value={fill.id} />
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="font-medium text-text-strong">
                            {medicineName} · {patientName}
                          </p>
                          <p className="mt-1 font-mono text-xs text-text-muted">
                            {fill.quantityCanonicalUnits} unit(s) dispensed ·{' '}
                            {new Date(fill.dispensedAt).toLocaleDateString()}
                          </p>
                          <p className="mt-2 text-sm text-text-muted">{directions}</p>
                        </div>
                        <StatusPill status="draft" label="Needs capture" />
                      </div>
                      <div className="mt-5 grid gap-4 md:grid-cols-[12rem_minmax(18rem,1fr)_auto] md:items-end">
                        <Field label="Reminder channel" hint="Consent is checked for this channel.">
                          <select name="channel" className={fieldClass} defaultValue="WHATSAPP">
                            <option value="WHATSAPP">WhatsApp</option>
                            <option value="SMS">SMS</option>
                            <option value="PHONE">Phone</option>
                            <option value="EMAIL">Email</option>
                          </select>
                        </Field>
                        <Field
                          label="Urdu directions"
                          hint="Enter the pharmacist-reviewed wording printed on the card."
                        >
                          <input
                            required
                            dir="rtl"
                            lang="ur"
                            name="directionsUrdu"
                            maxLength={500}
                            className={`${fieldClass} text-right`}
                            placeholder="مثال: روزانہ ایک گولی لیں"
                          />
                        </Field>
                        <Button
                          type="submit"
                          size="lg"
                          className="h-11"
                          disabled={captureReminder.isPending || !effectiveBranchId}
                        >
                          <CalendarClock aria-hidden />
                          {captureReminder.isPending ? 'Capturing…' : 'Capture reminder'}
                        </Button>
                      </div>
                    </form>
                  );
                })}
              </div>
            )}
          </SectionCard>
        </>
      ) : null}
    </div>
  );
}
