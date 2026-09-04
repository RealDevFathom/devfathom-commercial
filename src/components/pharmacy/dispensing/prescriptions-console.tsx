'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { Plus, Upload } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Field, WorkspaceState, fieldClass } from './field';

const today = () => new Date().toISOString().slice(0, 10);

export function PrescriptionsConsole() {
  const utils = trpc.useUtils();
  const workspace = trpc.pharmacyPrescriptions.workspace.useQuery();
  const capture = trpc.pharmacyPrescriptions.capture.useMutation({
    onSuccess: async () => {
      await utils.pharmacyPrescriptions.workspace.invalidate();
      setNotice('Prescription captured and ready for dispensing review.');
    },
  });
  const [notice, setNotice] = useState('');
  const [medicineId, setMedicineId] = useState('');
  const medicine = useMemo(
    () => workspace.data?.medicines.find((item) => item.id === medicineId),
    [medicineId, workspace.data]
  );

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
                    <input required name="quantity" type="number" min="1" className={fieldClass} />
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
                            {rx.validFrom.toLocaleDateString()}–{rx.validUntil.toLocaleDateString()}
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
      ) : null}
    </div>
  );
}
