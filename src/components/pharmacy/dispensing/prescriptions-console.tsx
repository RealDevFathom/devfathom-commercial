'use client';

import { useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { CalendarClock, Plus, Upload } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { pharmacyCalendarDay } from '@/lib/pharmacy/business-day';
import type { PrescriptionUpload } from '@/lib/pharmacy/prescription-files';
import {
  formatPrescriptionDate,
  prescriptionCalendarDate,
} from '@/lib/pharmacy/prescription-calendar';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { AccessDeniedState, Field, WorkspaceState, fieldClass, isAccessDenied } from './field';
import { MedicationCard } from './medication-card';
import { PrescriptionDirectoryCard } from './prescription-directory';

/** Private, authenticated, no-store evidence thumbnail; next/image would cache it. */
function EvidenceThumbnail({ url, label }: { url: string; label: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={label}
      loading="lazy"
      className="size-12 shrink-0 rounded-md border border-border-subtle object-cover"
    />
  );
}

// Matches the pharmacy upload contract; its runtime module is server-only.
const maxPrescriptionBytes = 5 * 1024 * 1024;
const evidenceTypes: Record<PrescriptionUpload['contentType'], readonly string[]> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
};

export function isImageType(value: string): value is PrescriptionUpload['contentType'] {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp';
}

export function fileError(file: File | null) {
  if (!file || file.size === 0) return 'Choose a non-empty prescription image.';
  if (file.size > maxPrescriptionBytes) return 'Choose a file no larger than 5 MiB.';
  if (
    !isImageType(file.type) ||
    !evidenceTypes[file.type].includes(file.name.split('.').pop()?.toLowerCase() ?? '')
  )
    return 'Use a JPEG, PNG or WebP with a matching file extension.';
  return null;
}

export function attachmentUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\/api\/pharmacy\/prescription-files\?id=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value
    )
  );
}

export function imageBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The image could not be read. Select it again.'));
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.includes(',')) {
        reject(new Error('The image could not be read. Select it again.'));
        return;
      }
      resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

export type PrescriptionsConsoleProps = { initialPatientId?: string };

function subscribeToPatientFragment(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function patientFromFragment() {
  return new URLSearchParams(window.location.hash.slice(1)).get('patientId') ?? '';
}

export function PrescriptionsConsole({ initialPatientId }: PrescriptionsConsoleProps = {}) {
  const utils = trpc.useUtils();
  const [selectedBranchId, setSelectedBranchId] = useState('');
  const workspace = trpc.pharmacyPrescriptions.workspace.useQuery(
    selectedBranchId ? { branchId: selectedBranchId } : undefined
  );
  const capture = trpc.pharmacyPrescriptions.capture.useMutation();
  const uploadSource = trpc.pharmacyPrescriptions.uploadSource.useMutation();
  const captureReminder = trpc.pharmacyPrescriptions.captureRefillReminder.useMutation({
    onSuccess: async () => {
      await utils.pharmacyPrescriptions.workspace.invalidate();
      setNotice('Refill reminder captured. Nothing has been sent.');
    },
  });
  const [notice, setNotice] = useState('');
  const [lines, setLines] = useState([
    { id: 0, medicineId: '', presentationId: '', medicineQuery: '' },
  ]);
  const nextLineId = useRef(1);
  const [selectedPatientId, setPatientId] = useState<string | null>(null);
  const counterPatientId = useSyncExternalStore(
    subscribeToPatientFragment,
    patientFromFragment,
    () => ''
  );
  const patientId = selectedPatientId ?? initialPatientId ?? counterPatientId;
  const [prescriberId, setPrescriberId] = useState('');
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState('');
  const [stage, setStage] = useState<'uploading' | 'capturing' | null>(null);
  const [savedAttachment, setSavedAttachment] = useState<{ url: string; name: string } | null>(
    null
  );
  const inFlight = useRef(false);
  const uploaded = useRef<{ file: File; patientId: string; url: string } | null>(null);

  const busy = stage !== null || capture.isPending;
  const selectedPatient = workspace.data?.patients.find((item) => item.id === patientId);
  const medicines = workspace.data?.medicines ?? [];
  const captureRequirements: string[] = [];
  if (!selectedPatient) {
    captureRequirements.push(
      workspace.data?.patients.length
        ? 'Select a patient above.'
        : 'Add the patient under Patients and prescribers.'
    );
  }
  if (!sourceFile) captureRequirements.push('Choose a prescription image above.');
  else if (sourceError) captureRequirements.push(sourceError);
  if (!workspace.data?.prescribers.length)
    captureRequirements.push('Add the prescribing doctor under Patients and prescribers.');
  if (!medicines.some((item) => item.presentations.length > 0))
    captureRequirements.push(
      'Ask a workspace administrator to add a medicine with a medicine form, then reload this page.'
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
            sourceFileRef: prescription.sourceFileRef,
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
        FILL_DISPENSED_AT_ANOTHER_BRANCH:
          'Reminder refused: this fill was dispensed at another branch. Only that branch can record its refill reminder.',
        FILL_BRANCH_UNKNOWN:
          'Reminder refused: the branch that dispensed this fill is not recorded. Ask the owner to record its refill reminder.',
      }[captureReminder.error.message] ?? captureReminder.error.message)
    : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const form = event.currentTarget;
    setNotice('');
    setSubmitError('');
    const validation = fileError(sourceFile);
    setSourceError(validation);
    if (validation || !sourceFile || !isImageType(sourceFile.type) || captureRequirements.length)
      return;
    const data = new FormData(form);
    inFlight.current = true;
    let currentStage: 'uploading' | 'capturing' = 'uploading';
    try {
      let evidence = uploaded.current;
      if (!evidence || evidence.file !== sourceFile || evidence.patientId !== patientId) {
        setStage('uploading');
        const result = await uploadSource.mutateAsync({
          patientId,
          contentType: sourceFile.type,
          dataBase64: await imageBase64(sourceFile),
        });
        if (
          !result ||
          !attachmentUrl(result.url) ||
          result.sourceFileRef !== result.url ||
          result.size !== sourceFile.size ||
          result.contentType !== sourceFile.type
        )
          throw new Error(
            'The upload response could not confirm the attachment. Retry the upload.'
          );
        evidence = { file: sourceFile, patientId, url: result.url };
        uploaded.current = evidence;
      }
      currentStage = 'capturing';
      setStage('capturing');
      await capture.mutateAsync({
        patientId,
        prescriberId: String(data.get('prescriberId')),
        sourceKind: String(data.get('sourceKind')) as 'PAPER_IMAGE' | 'WHATSAPP_PHOTO',
        sourceFileRef: evidence.url,
        custodyState: String(data.get('custodyState')) as 'NOT_HELD' | 'HELD_AT_PHARMACY',
        validFrom: prescriptionCalendarDate(String(data.get('validFrom'))),
        validUntil: prescriptionCalendarDate(String(data.get('validUntil'))),
        authorizedRepeats: Number(data.get('authorizedRepeats')),
        lines: lines.map((line, index) => ({
          lineNumber: index + 1,
          medicineId: line.medicineId,
          presentationId: String(data.get(`presentationId-${line.id}`)),
          authorizedCanonicalUnits: Number(data.get(`quantity-${line.id}`)),
          directions: String(data.get(`directions-${line.id}`)),
        })),
      });
      setSavedAttachment({ url: evidence.url, name: sourceFile.name });
      form.reset();
      setPrescriberId('');
      setLines([
        { id: nextLineId.current++, medicineId: '', presentationId: '', medicineQuery: '' },
      ]);
      setSourceFile(null);
      uploaded.current = null;
      setNotice('Prescription captured. Pharmacist review and dispensing consent still apply.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The request failed.';
      setSubmitError(
        currentStage === 'capturing'
          ? `${message} Prescription not confirmed. Your form and uploaded attachment are retained for retry.`
          : `${message} Prescription not captured. Your form is retained for retry.`
      );
      return;
    } finally {
      inFlight.current = false;
      setStage(null);
    }
    try {
      await utils.pharmacyPrescriptions.workspace.invalidate();
    } catch {
      setNotice('Prescription captured. Register refresh failed; reload to see the saved record.');
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Prescriptions"
        description="Save the prescription image and prescribed medicines before dispensing."
      />
      {workspace.isLoading ? (
        <WorkspaceState title="Loading prescriptions">
          Retrieving protected patient and prescription records.
        </WorkspaceState>
      ) : null}
      {workspace.error ? (
        isAccessDenied(workspace.error) ? (
          <AccessDeniedState title="You do not have prescription access">
            Prescription records are restricted to pharmacists and administrators holding the
            prescription permission.
          </AccessDeniedState>
        ) : (
          <WorkspaceState title="Prescriptions could not be loaded" tone="danger">
            {workspace.error.message} Try again when the connection is restored.
          </WorkspaceState>
        )
      ) : null}
      {workspace.data ? (
        <>
          <PrescriptionDirectoryCard
            onPatientAdded={(id) => {
              setPatientId(id);
              uploaded.current = null;
            }}
            onPrescriberAdded={setPrescriberId}
          />
          <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <SectionCard title="Capture prescription" titleLevel={2}>
              <form aria-label="Capture prescription" aria-busy={busy} onSubmit={submit}>
                <fieldset disabled={busy} className="grid min-w-0 gap-4">
                  {patientId && !selectedPatient ? (
                    <p role="alert" className="text-sm text-destructive">
                      The patient passed from the counter is unavailable. Select an accessible
                      patient.
                    </p>
                  ) : selectedPatient ? (
                    <p className="text-sm text-text-body">
                      Capturing for {selectedPatient.displayName}.
                    </p>
                  ) : null}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Patient">
                      <select
                        required
                        name="patientId"
                        className={fieldClass}
                        value={selectedPatient ? patientId : ''}
                        onChange={(event) => {
                          setPatientId(event.target.value);
                          uploaded.current = null;
                        }}
                      >
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
                      <select
                        required
                        name="prescriberId"
                        className={fieldClass}
                        value={
                          workspace.data.prescribers.some((p) => p.id === prescriberId)
                            ? prescriberId
                            : ''
                        }
                        onChange={(event) => setPrescriberId(event.target.value)}
                      >
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
                    <Field label="Prescription source">
                      <select name="sourceKind" className={fieldClass}>
                        <option value="PAPER_IMAGE">Paper prescription</option>
                        <option value="WHATSAPP_PHOTO">Photo received digitally</option>
                      </select>
                    </Field>
                    <Field
                      label="Prescription image"
                      hint="Single-frame JPEG, PNG or WebP; up to 5 MiB and 25 megapixels. Uploaded before the prescription is captured."
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
                          accept="image/jpeg,image/png,image/webp"
                          aria-invalid={Boolean(sourceError)}
                          aria-describedby={sourceError ? 'prescription-file-error' : undefined}
                          onChange={(event) => {
                            const file = event.target.files?.[0] ?? null;
                            setSourceFile(file);
                            setSourceError(fileError(file));
                            setSubmitError('');
                            uploaded.current = null;
                          }}
                          className={`${fieldClass} file:mr-3 file:border-0 file:bg-transparent file:font-semibold pl-9 pt-2`}
                        />
                      </span>
                    </Field>
                  </div>
                  {sourceError ? (
                    <p
                      id="prescription-file-error"
                      role="alert"
                      className="text-sm text-destructive"
                    >
                      {sourceError}
                    </p>
                  ) : null}
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="Valid from">
                      <input
                        required
                        name="validFrom"
                        type="date"
                        defaultValue={pharmacyCalendarDay(workspace.data.timezone)}
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
                  <Field label="Where is the original prescription?">
                    <select name="custodyState" className={fieldClass}>
                      <option value="NOT_HELD">Returned / not held</option>
                      <option value="HELD_AT_PHARMACY">Held at pharmacy</option>
                    </select>
                  </Field>
                  {lines.map((line, index) => {
                    const medicine = medicines.find((item) => item.id === line.medicineId);
                    const medicineSearch = line.medicineQuery.trim().toLowerCase();
                    const matchingMedicines = medicines.filter((item) =>
                      item.productName.toLowerCase().includes(medicineSearch)
                    );
                    const noMedicineMatches =
                      medicineSearch !== '' && matchingMedicines.length === 0;
                    const searchEmptyId = `capture-medicine-search-empty-${line.id}`;
                    return (
                      <fieldset key={line.id} className="min-w-0 border-t border-border-subtle pt-4">
                        <legend className="font-mono text-xs tracking-wide text-text-muted uppercase">
                          Line {index + 1}
                        </legend>
                        <div className="mb-4 space-y-2">
                          <Field label="Search medicine names">
                            <input
                              type="search"
                              value={line.medicineQuery}
                              onChange={(event) => {
                                const medicineQuery = event.target.value;
                                setLines((current) => current.map((item) =>
                                  item.id === line.id ? { ...item, medicineQuery } : item
                                ));
                              }}
                              className={fieldClass}
                              aria-describedby={
                                noMedicineMatches ? searchEmptyId : undefined
                              }
                            />
                          </Field>
                          {noMedicineMatches ? (
                            <p
                              id={searchEmptyId}
                              role="status"
                              className="text-sm text-text-muted"
                            >
                              No medicines match this search. Clear or change the name.
                            </p>
                          ) : null}
                        </div>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <Field label="Medicine">
                            <select
                              required
                              value={line.medicineId}
                              onChange={(event) => {
                                const medicineId = event.target.value;
                                setLines((current) => current.map((item) =>
                                  item.id === line.id
                                    ? { ...item, medicineId, presentationId: '' }
                                    : item
                                ));
                              }}
                              className={fieldClass}
                            >
                              <option value="" disabled>
                                Select medicine
                              </option>
                              {medicine && !matchingMedicines.includes(medicine) ? (
                                <option value={medicine.id}>{medicine.productName}</option>
                              ) : null}
                              {matchingMedicines.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.productName}
                                </option>
                              ))}
                            </select>
                          </Field>
                          <Field label="Medicine form">
                            <select
                              required
                              name={`presentationId-${line.id}`}
                              disabled={!medicine}
                              className={fieldClass}
                              value={line.presentationId}
                              onChange={(event) => {
                                const presentationId = event.target.value;
                                setLines((current) => current.map((item) =>
                                  item.id === line.id ? { ...item, presentationId } : item
                                ));
                              }}
                            >
                              <option value="" disabled>
                                Select medicine form
                              </option>
                              {medicine?.presentations.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.presentation}
                                </option>
                              ))}
                            </select>
                          </Field>
                        </div>
                        {medicine && medicine.presentations.length === 0 ? (
                          <p className="mt-2 text-sm text-text-muted">
                            This medicine has no medicine forms. Choose another medicine or ask a
                            workspace administrator to add its form, then reload this page.
                          </p>
                        ) : null}
                        <div className="mt-4 grid gap-4 sm:grid-cols-2">
                          <Field label="Prescribed quantity (units)">
                            <input
                              required
                              name={`quantity-${line.id}`}
                              type="number"
                              min="1"
                              className={fieldClass}
                            />
                          </Field>
                          <Field label="Directions">
                            <input
                              required
                              name={`directions-${line.id}`}
                              maxLength={2000}
                              className={fieldClass}
                              placeholder="e.g. One capsule every 8 hours"
                            />
                          </Field>
                        </div>
                        {lines.length > 1 ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="touch"
                            className="mt-3"
                            aria-label={`Remove line ${index + 1}`}
                            onClick={() => setLines((current) =>
                              current.filter((item) => item.id !== line.id)
                            )}
                          >
                            Remove line
                          </Button>
                        ) : null}
                      </fieldset>
                    );
                  })}
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    disabled={lines.length >= 30}
                    aria-describedby={lines.length >= 30 ? 'capture-line-limit' : undefined}
                    onClick={() => {
                      const id = nextLineId.current++;
                      setLines((current) => [
                        ...current,
                        { id, medicineId: '', presentationId: '', medicineQuery: '' },
                      ]);
                    }}
                  >
                    <Plus aria-hidden />
                    Add line
                  </Button>
                  {lines.length >= 30 ? (
                    <p id="capture-line-limit" className="text-sm text-text-muted">
                      A prescription can contain up to 30 lines. Remove a line to add another.
                    </p>
                  ) : null}
                  <div
                    id="capture-requirements"
                    aria-live="polite"
                    className="space-y-2 text-sm text-text-muted"
                  >
                    {captureRequirements.length ? (
                      <>
                        <p>Before you can capture this prescription:</p>
                        <ul className="list-disc space-y-1 pl-5">
                          {captureRequirements.map((requirement) => (
                            <li key={requirement}>{requirement}</li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    <p>
                      Complete the patient, prescriber, dates, and each medicine’s form,
                      prescribed quantity and directions, then select Capture prescription.
                    </p>
                  </div>
                  {submitError ? (
                    <p role="alert" className="text-sm text-destructive">
                      {submitError}
                    </p>
                  ) : null}
                  {notice ? (
                    <p role="status" className="text-sm text-success">
                      {notice}
                    </p>
                  ) : null}
                  {busy ? (
                    <div
                      id="capture-progress"
                      role="status"
                      className="space-y-2 text-sm text-text-muted"
                    >
                      <p>
                        {stage === 'uploading'
                          ? 'Uploading attachment…'
                          : 'Attachment uploaded. Saving prescription…'}
                      </p>
                      <progress
                        aria-label={
                          stage === 'uploading' ? 'Uploading attachment' : 'Saving prescription'
                        }
                        className="w-full"
                      />
                    </div>
                  ) : null}
                  <Button
                    size="lg"
                    className="h-11"
                    disabled={busy || captureRequirements.length > 0}
                    aria-describedby={busy ? 'capture-progress' : 'capture-requirements'}
                    type="submit"
                  >
                    <Plus aria-hidden />
                    {busy ? 'Capturing…' : submitError ? 'Retry capture' : 'Capture prescription'}
                  </Button>
                </fieldset>
              </form>
              {savedAttachment ? (
                <div className="mt-4 space-y-2 text-sm">
                  <StatusPill status="saved" tone="success" label="Attachment saved" />
                  <a
                    href={savedAttachment.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block break-all text-primary underline underline-offset-4 focus-visible:ring-3 focus-visible:ring-ring"
                  >
                    View saved attachment: {savedAttachment.name} (opens in a new tab)
                  </a>
                </div>
              ) : null}
            </SectionCard>
            <SectionCard title="Prescription register" titleLevel={2}>
              {workspace.data.prescriptions.length === 0 ? (
                <WorkspaceState title="No prescriptions yet">
                  Captured prescriptions will appear here with the remaining prescribed quantity for
                  every line.
                </WorkspaceState>
              ) : (
                <div
                  role="region"
                  aria-label="Captured prescriptions"
                  tabIndex={0}
                  className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <table className="w-full min-w-[46rem] text-left text-sm">
                    <thead className="font-mono text-xs tracking-wide text-text-muted uppercase">
                      <tr>
                        <th className="pb-3">Patient</th>
                        <th className="pb-3">Prescriber</th>
                        <th className="pb-3">Validity</th>
                        <th className="pb-3">Medicine</th>
                        <th className="pb-3 text-right">Remaining</th>
                        <th className="pb-3">Original prescription</th>
                        <th className="pb-3">Image</th>
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
                              {formatPrescriptionDate(rx.validFrom)}–
                              {formatPrescriptionDate(rx.validUntil)}
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
                            <td className="py-4">
                              {attachmentUrl(rx.sourceFileRef) ? (
                                <a
                                  href={rx.sourceFileRef}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-2 text-primary underline underline-offset-4 focus-visible:ring-3 focus-visible:ring-ring"
                                >
                                  <EvidenceThumbnail
                                    url={rx.sourceFileRef}
                                    label={`Prescription photo for ${rx.patient.displayName}`}
                                  />
                                  View attachment
                                  <span className="sr-only">
                                    {' '}
                                    for {rx.patient.displayName} (opens in a new tab)
                                  </span>
                                </a>
                              ) : (
                                <span className="text-text-muted">
                                  Reference only · no uploaded attachment
                                </span>
                              )}
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

            {!workspace.data.canDispense ? (
              <WorkspaceState title="Dispensing permission required">
                Refill reminders are captured by staff with the pharmacy dispensing permission.
              </WorkspaceState>
            ) : workspace.data.branches.length === 0 ? (
              <WorkspaceState title="No active pharmacy branch">
                Refill reminders are captured at a branch you are assigned to. Ask the owner to
                assign you to an active branch.
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
                {dispensedFills.map(
                  ({ fill, patientName, medicineName, directions, sourceFileRef }) => {
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
                          {attachmentUrl(sourceFileRef) ? (
                            <a
                              href={sourceFileRef}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="rounded-md focus-visible:ring-3 focus-visible:ring-ring"
                            >
                              <EvidenceThumbnail
                                url={sourceFileRef}
                                label={`Prescription photo for this fill of ${medicineName}`}
                              />
                              <span className="sr-only"> (opens in a new tab)</span>
                            </a>
                          ) : null}
                          <div className="mr-auto">
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
                          <Field
                            label="Reminder channel"
                            hint="Consent is checked for this channel."
                          >
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
                  }
                )}
              </div>
            )}
          </SectionCard>
        </>
      ) : null}
    </div>
  );
}
