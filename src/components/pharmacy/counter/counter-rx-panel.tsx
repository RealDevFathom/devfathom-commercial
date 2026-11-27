'use client';

import { forwardRef, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';

import {
  attachmentUrl,
  fileError,
  imageBase64,
  isImageType,
} from '@/components/pharmacy/dispensing/prescriptions-console';
import { PRESCRIPTION_DIRECTORY_ID } from '@/components/pharmacy/dispensing/prescription-directory';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import { Eyebrow } from '@/components/ui/eyebrow';
import { useCounterApprovalCopy } from './counter-approval-copy';
import { CounterDuplicateSaltAcknowledge } from './counter-duplicate-salt-acknowledge';
import type { CounterAlert } from '@/lib/pharmacy/counter-alerts';
import type { CounterPatientPanel } from '@/lib/pharmacy/counter-prescriptions';
import { formatReceiptDate } from '@/lib/pharmacy/counter-receipt';
import type { RxOcrPrefill } from '@/lib/pharmacy/rx-ocr';
import { pharmacyCalendarDay } from '@/lib/pharmacy/business-day';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

const selectClass =
  'h-11 w-full rounded-md border border-border-subtle bg-surface px-3 text-sm text-text-strong focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60';

/**
 * Photo captures store the prescription under `rx-<file id>` (see
 * `pharmacyPrescriptions.capture`), so the private evidence URL follows from
 * the id. Anything else (seeded or legacy references) has no thumbnail.
 */
function photoUrlFor(prescriptionId: string): string | null {
  const url = `/api/pharmacy/prescription-files?id=${prescriptionId.replace(/^rx-/, '')}`;
  return prescriptionId.startsWith('rx-') && attachmentUrl(url) ? url : null;
}

function PrescriptionThumbnail({ url, label }: { url: string; label: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-block shrink-0 rounded-md focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
    >
      {/* Private, authenticated, no-store evidence: next/image would cache it. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={label}
        loading="lazy"
        className="size-14 rounded-md border border-border-subtle object-cover"
      />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/**
 * DEV-943: a calendar day counted from today on the shop's clock (the organisation zone
 * the prescription workspace returns), not the UTC day: 00:00–04:59 PKT is already the
 * next day in Karachi.
 */
export const isoDay = (timeZone: string | null | undefined, offsetDays = 0, now = new Date()) =>
  new Date(
    Date.parse(`${pharmacyCalendarDay(timeZone, now)}T00:00:00.000Z`) + offsetDays * 86_400_000
  )
    .toISOString()
    .slice(0, 10);

/**
 * PH-A3 — photograph a paper Rx at the counter without leaving the bill.
 *
 * The photo is stored privately first; optional OCR then PROPOSES drug and
 * dose. A proposal is never applied by itself: each value is applied only when
 * the operator chooses it, stays editable, and a used proposal must be
 * explicitly confirmed against the photo before the prescription is saved.
 * Saving never signs anything — pharmacist review still releases the line.
 */
function CounterRxPhotoCapture({
  patientId,
  patientName,
  disabled,
}: {
  patientId: string;
  patientName: string;
  disabled: boolean;
}) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const workspace = trpc.pharmacyPrescriptions.workspace.useQuery(undefined, { enabled: open });
  const uploadSource = trpc.pharmacyPrescriptions.uploadSource.useMutation();
  const extractSource = trpc.pharmacyPrescriptions.extractSource.useMutation();
  const capture = trpc.pharmacyPrescriptions.capture.useMutation();

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<RxOcrPrefill | null>(null);
  const [medicineId, setMedicineId] = useState('');
  const [presentationId, setPresentationId] = useState('');
  const [directions, setDirections] = useState('');
  const [usedSuggestion, setUsedSuggestion] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [saved, setSaved] = useState<{ url: string } | null>(null);
  const inFlight = useRef(false);

  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const medicine = useMemo(
    () => workspace.data?.medicines.find((item) => item.id === medicineId) ?? null,
    [medicineId, workspace.data]
  );
  const busy = uploadSource.isPending || extractSource.isPending || capture.isPending;

  function reset() {
    setFile(null);
    setPreview(null);
    setUploadedUrl(null);
    setPrefill(null);
    setMedicineId('');
    setPresentationId('');
    setDirections('');
    setUsedSuggestion(false);
    setConfirmed(false);
    setError(null);
  }

  async function ensureUploaded(): Promise<string> {
    if (uploadedUrl) return uploadedUrl;
    if (!file || !isImageType(file.type)) throw new Error('Take or choose a prescription photo.');
    const result = await uploadSource.mutateAsync({
      patientId,
      contentType: file.type,
      dataBase64: await imageBase64(file),
    });
    if (!attachmentUrl(result?.url) || result.sourceFileRef !== result.url) {
      throw new Error('The upload could not be confirmed. Retry the photo.');
    }
    setUploadedUrl(result.url);
    return result.url;
  }

  async function suggest() {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    try {
      setPrefill(await extractSource.mutateAsync({ sourceFileRef: await ensureUploaded() }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The prescription could not be read.');
    } finally {
      inFlight.current = false;
    }
  }

  function applySuggestion(apply: () => void) {
    apply();
    setUsedSuggestion(true);
    setConfirmed(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const form = event.currentTarget;
    const validation = fileError(file);
    if (validation) {
      setError(validation);
      return;
    }
    if (usedSuggestion && !confirmed) {
      setError('Confirm the suggested values against the photo before saving.');
      return;
    }
    const data = new FormData(form);
    inFlight.current = true;
    setError(null);
    try {
      const sourceFileRef = await ensureUploaded();
      await capture.mutateAsync({
        patientId,
        prescriberId: String(data.get('prescriberId')),
        sourceKind: 'PAPER_IMAGE',
        sourceFileRef,
        custodyState: String(data.get('custodyState')) as 'NOT_HELD' | 'HELD_AT_PHARMACY',
        validFrom: new Date(isoDay(workspace.data?.timezone)),
        validUntil: new Date(String(data.get('validUntil'))),
        authorizedRepeats: 0,
        lines: [
          {
            lineNumber: 1,
            medicineId,
            presentationId,
            authorizedCanonicalUnits: Number(data.get('quantity')),
            directions: directions.trim(),
          },
        ],
      });
      setSaved({ url: sourceFileRef });
      reset();
      setOpen(false);
    } catch (failure) {
      setError(
        `${failure instanceof Error ? failure.message : 'The request failed.'} Your photo and form are kept for retry.`
      );
      return;
    } finally {
      inFlight.current = false;
    }
    await Promise.allSettled([
      utils.pharmacyPrescriptions.counterPatientPanel.invalidate({ patientId }),
      utils.pharmacyPrescriptions.workspace.invalidate(),
    ]);
  }

  return (
    <div className="space-y-2">
      {saved ? (
        <div role="status" className="flex items-center gap-3 text-sm text-text-body">
          <PrescriptionThumbnail
            url={saved.url}
            label={`Saved prescription photo for ${patientName}`}
          />
          <span>Prescription photo saved. A pharmacist must still sign it before release.</span>
        </div>
      ) : null}
      {!open ? (
        <Button
          type="button"
          variant="outline"
          className="h-11"
          disabled={disabled}
          onClick={() => {
            setSaved(null);
            setOpen(true);
          }}
        >
          Photograph prescription
        </Button>
      ) : (
        <form
          aria-label="Photograph prescription"
          aria-busy={busy}
          onSubmit={submit}
          className="space-y-3 rounded-md border border-border-subtle p-3"
        >
          <fieldset disabled={disabled || busy} className="grid min-w-0 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="counter-rx-photo">Prescription photo</Label>
              <input
                id="counter-rx-photo"
                type="file"
                accept="image/*"
                capture="environment"
                aria-describedby="counter-rx-photo-hint"
                onChange={(event) => {
                  const next = event.target.files?.[0] ?? null;
                  reset();
                  setFile(next);
                  setError(fileError(next));
                  setPreview(next && !fileError(next) ? URL.createObjectURL(next) : null);
                }}
                className="block w-full text-sm file:mr-3 file:h-11 file:rounded-md file:border file:border-border-subtle file:bg-transparent file:px-3 file:font-semibold"
              />
              <p id="counter-rx-photo-hint" className="text-xs text-text-muted">
                JPEG, PNG or WebP up to 5 MiB. Stored privately as inspection evidence.
              </p>
            </div>
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={preview}
                alt="Selected prescription photo"
                className="size-24 rounded-md border border-border-subtle object-cover"
              />
            ) : null}

            {file && !fileError(file) ? (
              <Button type="button" variant="outline" className="h-11" onClick={suggest}>
                {extractSource.isPending ? 'Reading photo…' : 'Suggest from photo'}
              </Button>
            ) : null}

            {prefill ? (
              <section aria-label="Suggestions from photo" className="space-y-2">
                <p className="text-xs text-text-muted">
                  Read by {prefill.adapter.toLowerCase()} OCR. Nothing is filled in until you choose
                  a suggestion.
                </p>
                {prefill.lines.length === 0 ? (
                  <p className="text-sm text-text-muted">
                    No medicine could be read from the photo.
                  </p>
                ) : null}
                {prefill.lines.map((line, index) => (
                  <div key={index} className="space-y-1 rounded-md bg-surface-sunken p-2 text-sm">
                    <p className="text-text-strong">
                      Read:{' '}
                      {[line.drugName.value, line.strength.value].filter(Boolean).join(' ') || '—'}{' '}
                      <span className="font-mono text-xs text-text-muted">
                        {Math.round(line.drugName.confidence * 100)}%
                      </span>
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {line.medicineCandidates.map((candidate) => (
                        <Button
                          key={candidate.medicineId}
                          type="button"
                          variant="outline"
                          className="h-11"
                          onClick={() =>
                            applySuggestion(() => {
                              setMedicineId(candidate.medicineId);
                              setPresentationId('');
                            })
                          }
                        >
                          Use medicine {candidate.label}
                        </Button>
                      ))}
                      {line.dose.value ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="h-11"
                          onClick={() =>
                            applySuggestion(() => setDirections(line.dose.value ?? ''))
                          }
                        >
                          Use directions “{line.dose.value}” (
                          {Math.round(line.dose.confidence * 100)}
                          %)
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </section>
            ) : null}

            {workspace.error ? (
              <p role="alert" className="text-sm text-destructive">
                {workspace.error.message}
              </p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="counter-rx-prescriber">Prescriber</Label>
                <select
                  id="counter-rx-prescriber"
                  name="prescriberId"
                  required
                  defaultValue=""
                  className={selectClass}
                >
                  <option value="" disabled>
                    {workspace.isLoading ? 'Loading…' : 'Select prescriber'}
                  </option>
                  {workspace.data?.prescribers.map((prescriber) => (
                    <option key={prescriber.id} value={prescriber.id}>
                      {prescriber.name} · {prescriber.registrationNumber}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="counter-rx-valid-until">Valid until</Label>
                <Input
                  // Remount once the shop's zone arrives so the default is the shop's day.
                  key={workspace.data?.timezone ?? 'zone-loading'}
                  id="counter-rx-valid-until"
                  name="validUntil"
                  type="date"
                  required
                  min={isoDay(workspace.data?.timezone, 1)}
                  defaultValue={isoDay(workspace.data?.timezone, 30)}
                  className="h-11"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="counter-rx-medicine">Medicine</Label>
                <select
                  id="counter-rx-medicine"
                  required
                  value={medicineId}
                  onChange={(event) => {
                    setMedicineId(event.target.value);
                    setPresentationId('');
                  }}
                  className={selectClass}
                >
                  <option value="" disabled>
                    Select medicine
                  </option>
                  {workspace.data?.medicines.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.productName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="counter-rx-presentation">Presentation</Label>
                <select
                  id="counter-rx-presentation"
                  required
                  disabled={!medicine}
                  value={presentationId}
                  onChange={(event) => setPresentationId(event.target.value)}
                  className={selectClass}
                >
                  <option value="" disabled>
                    Select presentation
                  </option>
                  {medicine?.presentations.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.presentation}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="counter-rx-quantity">Authorized units</Label>
                <Input
                  id="counter-rx-quantity"
                  name="quantity"
                  type="number"
                  min={1}
                  required
                  className="h-11"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="counter-rx-custody">Original custody</Label>
                <select
                  id="counter-rx-custody"
                  name="custodyState"
                  defaultValue="NOT_HELD"
                  className={selectClass}
                >
                  <option value="NOT_HELD">Returned / not held</option>
                  <option value="HELD_AT_PHARMACY">Held at pharmacy</option>
                </select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="counter-rx-directions">Directions</Label>
              <Input
                id="counter-rx-directions"
                required
                value={directions}
                onChange={(event) => setDirections(event.target.value)}
                className="h-11"
              />
            </div>
            {usedSuggestion ? (
              <label className="flex min-h-11 items-start gap-2 text-sm text-text-body">
                <input
                  type="checkbox"
                  required
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  className="mt-1 size-4"
                />
                I have checked the suggested medicine and directions against the photo.
              </label>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                className="h-11"
                disabled={!file || Boolean(fileError(file)) || (usedSuggestion && !confirmed)}
              >
                {uploadSource.isPending
                  ? 'Uploading photo…'
                  : capture.isPending
                    ? 'Saving…'
                    : 'Save prescription'}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-11"
                onClick={() => {
                  reset();
                  setOpen(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </fieldset>
        </form>
      )}
    </div>
  );
}

export type CounterRxPanelProps = {
  controlled?: {
    prescriptionLineId: string;
    staffProfileId: string;
    pin: string;
    pharmacists: ReadonlyArray<{ id: string; name: string }>;
    loading: boolean;
    error: boolean;
    patientAddress: string | null;
    rxSerialWritten: boolean;
    emergency: boolean;
    prescriberName: string;
    prescriberRegNo: string;
    refSerial: string;
    onChange: (
      field:
        | 'prescriptionLineId'
        | 'staffProfileId'
        | 'pin'
        | 'patientAddress'
        | 'prescriberName'
        | 'prescriberRegNo'
        | 'refSerial'
        | 'rxSerialWritten'
        | 'emergency',
      value: string | boolean
    ) => void;
  };
  alerts: readonly CounterAlert[];
  /**
   * #724: the bill an acknowledgeable advice alert belongs to. Without it the
   * advice still renders; only the Acknowledge control is withheld.
   */
  acknowledgementScope?: { branchId: string; saleId: string } | null;
  patient: CounterPatientPanel | null;
  candidates: ReadonlyArray<{ patientId: string; displayName: string; phone: string | null }>;
  query: string;
  state: 'idle' | 'loading' | 'ready' | 'error' | 'denied';
  error?: string | null;
  disabled?: boolean;
  /**
   * DEV-323: prescription upload and capture are refused on the server without
   * Pharmacy Dispensing and `pharmacy:prescriptions` (a pharmacist or tenant
   * administrator). Without them the counter withholds both capture controls
   * and says who can capture instead of offering an action that fails.
   */
  canCapturePrescription: boolean;
  onQueryChange: (query: string) => void;
  onSearch: () => void;
  onSelectPatient: (patientId: string) => void;
  onClearPatient: () => void;
  onCapturePrescription?: (context: { patientId: string }) => void;
};

/**
 * POS-09 — the prescription and patient panel that sits beside the cart.
 *
 * Three rules the requirement states outright, implemented here rather than
 * assumed:
 *
 * 1. NO NAVIGATION AWAY. The panel is part of the counter layout; attaching a
 *    patient never leaves the bill.
 * 2. SAFETY BLOCKS LOOK DIFFERENT. A block gets the destructive surface, an
 *    alert role, and a stated remedy. Advice and commercial notices get quieter
 *    surfaces and `status`, so a promotion notice cannot be mistaken for a
 *    clinical stop — and no alert offers "acknowledge" as a way past a block.
 * 3. KEYBOARD-ADDRESSABLE AND DEDUPLICATED. Alerts arrive already deduplicated
 *    from `counterAlertsFor`; each one is a list item inside a labelled region
 *    the console can focus with a single chord.
 */
export const CounterRxPanel = forwardRef<HTMLDivElement, CounterRxPanelProps>(
  function CounterRxPanel(
    {
      controlled,
      alerts,
      acknowledgementScope = null,
      patient,
      candidates,
      query,
      state,
      error,
      disabled = false,
      onQueryChange,
      onSearch,
      onSelectPatient,
      onClearPatient,
      onCapturePrescription,
      canCapturePrescription,
    },
    ref
  ) {
    const blocks = alerts.filter((alert) => alert.severity === 'SAFETY_BLOCK');
    const advice = alerts.filter((alert) => alert.severity === 'CLINICAL_ADVICE');
    const commercial = alerts.filter((alert) => alert.severity === 'COMMERCIAL');

    return (
      <div
        ref={ref}
        tabIndex={-1}
        className="min-w-0 space-y-5 rounded-lg focus-visible:outline-2 focus-visible:outline-ring"
      >
        <section aria-label="Safety blocks" className="space-y-3">
          <h4 className="font-mono text-xs tracking-wide text-text-muted uppercase">
            Safety blocks
          </h4>
          {blocks.length === 0 ? (
            <p className="text-sm text-text-muted">
              Safety checks run before payment. Any reported blocks appear here.
            </p>
          ) : (
            <ul className="space-y-2">
              {blocks.map((alert) => (
                <li
                  key={alert.key}
                  role="alert"
                  className="space-y-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3"
                >
                  <StatusPill status="blocked" tone="danger" label="Blocked" />
                  <p className="text-sm font-semibold leading-relaxed text-text-strong">
                    {alert.message}
                  </p>
                  {alert.remedy ? (
                    <p className="mt-1 text-sm text-text-body">{alert.remedy}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {advice.length > 0 || commercial.length > 0 ? (
          <section
            aria-label="Counselling and notices"
            className="space-y-3 border-t border-border-subtle pt-5"
          >
            <h4 className="font-mono text-xs tracking-wide text-text-muted uppercase">
              Counselling and notices
            </h4>
            {advice.length > 0 ? (
              <ul aria-label="Clinical advice" className="space-y-2">
                {advice.map((alert) => (
                  <li
                    key={alert.key}
                    role="status"
                    className="space-y-2 rounded-xl border border-border-subtle bg-surface-card p-3 text-sm text-text-body"
                  >
                    <StatusPill status="advice" tone="neutral" label="Advice" />
                    <p className="font-medium leading-relaxed">{alert.message}</p>
                    {alert.remedy ? (
                      <p className="text-sm text-text-muted">{alert.remedy}</p>
                    ) : null}
                    {alert.acknowledgement && acknowledgementScope ? (
                      <CounterDuplicateSaltAcknowledge
                        branchId={acknowledgementScope.branchId}
                        saleId={acknowledgementScope.saleId}
                        ingredientKey={alert.acknowledgement.ingredientKey}
                        medicines={alert.acknowledgement.medicines}
                        disabled={disabled}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {commercial.length > 0 ? (
              <ul aria-label="Commercial notices" className="space-y-2">
                {commercial.map((alert) => (
                  <li
                    key={alert.key}
                    role="status"
                    className="space-y-2 rounded-xl bg-surface-sunken p-3 text-sm text-text-body"
                  >
                    <StatusPill status="commercial" tone="neutral" label="Commercial" />
                    <p className="font-medium leading-relaxed">{alert.message}</p>
                    {alert.remedy ? (
                      <p className="text-sm text-text-muted">{alert.remedy}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        <section
          aria-label="Patient and prescriptions"
          className="space-y-3 border-t border-border-subtle pt-5"
        >
          <h4 className="font-mono text-xs tracking-wide text-text-muted uppercase">Patient</h4>

          {state === 'denied' ? (
            <p className="text-sm text-text-muted" role="status">
              Prescriptions are not enabled for this workspace. Commercial lines can still be sold;
              a prescription-only line will stay blocked.
            </p>
          ) : patient ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-text-strong">{patient.displayName}</p>
                  <p className="font-mono text-xs text-text-muted">
                    {patient.phone ?? '—'} · {patient.cnic ?? '—'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {patient.dispensingConsent ? (
                    <StatusPill status="consent" tone="success" label="Dispensing consent" />
                  ) : (
                    <StatusPill status="no-consent" tone="warning" label="No consent on file" />
                  )}
                </div>
              </div>

              {patient.prescriptions.length === 0 ? (
                <p className="text-sm text-text-muted">
                  No prescription is on file for this patient.
                </p>
              ) : (
                <ul className="space-y-3">
                  {patient.prescriptions.map((prescription) => (
                    <li
                      key={prescription.prescriptionId}
                      className="space-y-2 rounded-xl border border-border-subtle bg-surface-card p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-3">
                          {photoUrlFor(prescription.prescriptionId) ? (
                            <PrescriptionThumbnail
                              url={photoUrlFor(prescription.prescriptionId)!}
                              label={`Prescription photo from ${prescription.prescriberName}`}
                            />
                          ) : null}
                          <p className="text-sm text-text-strong">{prescription.prescriberName}</p>
                        </div>
                        {prescription.inDate ? (
                          <StatusPill status="valid" tone="success" label="In date" />
                        ) : (
                          <StatusPill status="expired" tone="danger" label="Outside validity" />
                        )}
                      </div>
                      <p className="break-words font-mono text-xs leading-relaxed text-text-muted">
                        {formatReceiptDate(prescription.validFrom)} →{' '}
                        {formatReceiptDate(prescription.validUntil)} · repeats{' '}
                        {prescription.authorizedRepeats} ·{' '}
                        {prescription.custodyState.toLowerCase().replaceAll('_', ' ')}
                      </p>
                      <ul className="mt-2 space-y-1">
                        {prescription.lines.map((line) => (
                          <li
                            key={line.prescriptionLineId}
                            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-sm"
                          >
                            <span className="text-text-strong">{line.medicineName}</span>
                            <span className="font-mono tabular-nums text-text-muted">
                              {line.remainingAuthorizedUnits} of {line.authorizedCanonicalUnits}{' '}
                              units left
                            </span>
                            {line.verified ? (
                              <StatusPill
                                status="verified"
                                tone="success"
                                label="Pharmacist signed"
                              />
                            ) : (
                              <StatusPill
                                status="unverified"
                                tone="warning"
                                label={
                                  line.latestDecision
                                    ? `Awaiting sign · ${line.latestDecision.toLowerCase()}`
                                    : 'Awaiting pharmacist'
                                }
                              />
                            )}
                            {line.fills?.length ? (
                              <ul
                                aria-label={`Fill history for ${line.medicineName}`}
                                className="w-full space-y-1 text-sm text-text-body"
                              >
                                {line.fills.map((fill, index) => (
                                  <li key={`${fill.date}-${index}`}>
                                    <span>{fill.label}</span> ·{' '}
                                    <time dateTime={fill.date}>{fill.date}</time> · {fill.quantity}{' '}
                                    {fill.quantity === 1 ? 'unit' : 'units'}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  {!canCapturePrescription ? null : onCapturePrescription ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11"
                      disabled={disabled || state === 'loading' || state === 'error'}
                      onClick={() => onCapturePrescription({ patientId: patient.patientId })}
                    >
                      Capture prescription
                    </Button>
                  ) : disabled || state === 'loading' || state === 'error' ? (
                    <Button type="button" variant="outline" className="h-11" disabled>
                      Capture prescription
                    </Button>
                  ) : (
                    <Link
                      className={cn(buttonVariants({ variant: 'outline' }), 'h-11 rounded-sm')}
                      href={`/pharmacy/prescriptions#patientId=${encodeURIComponent(patient.patientId)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      prefetch={false}
                    >
                      Capture prescription
                      <span className="sr-only">
                        {' '}
                        for {patient.displayName} (opens in a new tab)
                      </span>
                    </Link>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11"
                    disabled={disabled}
                    onClick={onClearPatient}
                  >
                    Detach patient
                  </Button>
                </div>
                {canCapturePrescription ? (
                  <>
                    <p className="text-xs text-text-muted">
                      {onCapturePrescription
                        ? `Capture evidence for ${patient.displayName}.`
                        : `Opens capture for ${patient.displayName} in a new tab. This bill stays open.`}{' '}
                      Capture does not replace pharmacist review or dispensing consent.
                    </p>
                    <CounterRxPhotoCapture
                      key={patient.patientId}
                      patientId={patient.patientId}
                      patientName={patient.displayName}
                      disabled={disabled || state === 'loading' || state === 'error'}
                    />
                  </>
                ) : (
                  <p className="text-xs text-text-muted">
                    Prescription capture needs a pharmacist or administrator. Ask one to capture the
                    prescription for {patient.displayName}; this bill stays open.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-text-muted">
                Select a patient to capture their prescription.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="counter-patient-search">Find patient</Label>
                <div className="flex gap-2">
                  <Input
                    id="counter-patient-search"
                    value={query}
                    autoComplete="off"
                    disabled={disabled}
                    placeholder="Name or phone"
                    onChange={(event) => onQueryChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      onSearch();
                    }}
                    className="h-11"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11"
                    disabled={disabled || query.trim().length < 2}
                    onClick={onSearch}
                  >
                    Search
                  </Button>
                </div>
              </div>

              {state === 'loading' ? (
                <p className="text-sm text-text-muted" role="status">
                  Searching patients…
                </p>
              ) : null}
              {state === 'error' ? (
                <p className="text-sm text-destructive" role="alert">
                  {error ?? 'Patient search failed.'}
                </p>
              ) : null}
              {state === 'ready' && candidates.length === 0 ? (
                <p className="text-sm text-text-muted">
                  No patient matches that search.{' '}
                  <Link
                    href={`/pharmacy/prescriptions#${PRESCRIPTION_DIRECTORY_ID}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-11 min-w-11 items-center text-primary underline underline-offset-4 focus-visible:ring-3 focus-visible:ring-ring"
                  >
                    Add the patient or prescriber in Prescriptions (opens in a new tab)
                  </Link>
                  . This bill stays open.
                </p>
              ) : null}

              {candidates.map((candidate) => (
                <Button
                  key={candidate.patientId}
                  type="button"
                  variant="outline"
                  className="h-11 w-full justify-between"
                  disabled={disabled}
                  onClick={() => onSelectPatient(candidate.patientId)}
                >
                  <span className="truncate">{candidate.displayName}</span>
                  <span className="font-mono text-xs">{candidate.phone ?? ''}</span>
                </Button>
              ))}
            </div>
          )}
        </section>
        {controlled ? (
          <CounterControlledAuthorization
            controlled={controlled}
            patient={patient}
            disabled={disabled}
          />
        ) : null}
      </div>
    );
  }
);

/**
 * The controlled-medicine authorisation: patient address, prescription or emergency supply, and
 * the approving pharmacist with their PIN. DEV-977 phase 3 (Counter v2 A5): the counter shows it
 * in its own "Authorise" sheet; the fields, labels and the server's checks are unchanged.
 */
export function CounterControlledAuthorization({
  controlled,
  patient,
  disabled = false,
  inSheet = false,
}: {
  controlled: NonNullable<CounterRxPanelProps['controlled']>;
  patient: CounterPatientPanel | null;
  disabled?: boolean;
  /**
   * DEV-977 phase 3: drawn in the "Authorise" sheet, whose own header already carries the
   * eyebrow and the title, so they are not repeated here. The region keeps its name.
   */
  inSheet?: boolean;
}) {
  // DEV-961: the pharmacist's approval follows the authenticator for approvals setting.
  const approvalCopy = useCounterApprovalCopy();
  return (
    <section
      aria-label="Controlled medicine authorization"
      data-counter-controlled=""
      className={inSheet ? 'space-y-4' : 'space-y-4 border-t border-border-subtle pt-5'}
    >
      {/* DEV-977 phase 2B (Counter v2 A5): the authorisation in three numbered steps, with
            a progress strip. The steps only show what is filled in; the server still checks
            every field and the pharmacist's PIN. */}
      <div className="space-y-1">
        {inSheet ? null : (
          <>
            <Eyebrow className="block">Controlled medicine · online only</Eyebrow>
            <h4 className="text-base font-semibold text-text-strong">
              Controlled medicine authorization
            </h4>
          </>
        )}
        <p className="text-xs text-text-muted">{approvalCopy.controlledIntro}</p>
      </div>
      <ControlledSteps
        steps={[
          {
            label: 'Patient',
            done:
              Boolean(patient) &&
              (controlled.patientAddress === null || controlled.patientAddress.trim().length >= 3),
          },
          {
            label: 'Prescription',
            done: controlled.emergency || controlled.prescriptionLineId !== '',
          },
          {
            label: 'Pharmacist',
            done: controlled.staffProfileId !== '' && controlled.pin !== '',
          },
        ]}
      />
      <section aria-labelledby="controlled-step-patient" className="space-y-2.5">
        <h5 id="controlled-step-patient" className="text-[15px] font-semibold text-text-strong">
          1 · Patient
        </h5>
        <Label className="text-xs text-text-muted" htmlFor="controlled-address">
          Patient address
        </Label>
        <Input
          id="controlled-address"
          className="h-11"
          disabled={disabled || !patient}
          placeholder={controlled.patientAddress === null ? 'Use the address on file' : undefined}
          aria-describedby="controlled-address-help"
          value={controlled.patientAddress ?? ''}
          onChange={(event) => controlled.onChange('patientAddress', event.target.value)}
        />
        <p id="controlled-address-help" className="text-xs text-text-muted">
          The pharmacist’s approval uses the selected patient’s address on file. Enter an address to
          use for this supply instead.
        </p>
      </section>
      <section
        aria-labelledby="controlled-step-prescription"
        className="space-y-2.5 border-t border-border-subtle pt-4"
      >
        <h5
          id="controlled-step-prescription"
          className="text-[15px] font-semibold text-text-strong"
        >
          2 · Prescription
        </h5>
        <Label htmlFor="controlled-prescription">Prescription line</Label>
        <select
          id="controlled-prescription"
          className="h-11 w-full rounded-md border border-border-subtle bg-surface-raised px-3 focus-visible:outline-2 focus-visible:outline-ring"
          disabled={disabled || !patient}
          value={controlled.prescriptionLineId}
          onChange={(event) => controlled.onChange('prescriptionLineId', event.target.value)}
        >
          <option value="">Select prescription</option>
          {patient?.prescriptions
            .filter((rx) => rx.inDate)
            .flatMap((rx) =>
              rx.lines.map((line) => (
                <option key={line.prescriptionLineId} value={line.prescriptionLineId}>
                  {line.medicineName} · {rx.prescriberName} · {line.remainingAuthorizedUnits} units
                </option>
              ))
            )}
        </select>
        <label
          className="flex min-h-11 items-center gap-2 text-sm text-text-body"
          htmlFor="controlled-emergency"
        >
          <input
            id="controlled-emergency"
            type="checkbox"
            checked={controlled.emergency}
            disabled={disabled}
            onChange={(event) => controlled.onChange('emergency', event.target.checked)}
          />
          Emergency supply, no prescription
        </label>
        {controlled.emergency ? (
          <>
            <Label className="text-xs text-text-muted" htmlFor="controlled-prescriber-name">
              Prescriber name
            </Label>
            <Input
              id="controlled-prescriber-name"
              className="h-11"
              disabled={disabled}
              value={controlled.prescriberName}
              onChange={(event) => controlled.onChange('prescriberName', event.target.value)}
            />
            <Label className="text-xs text-text-muted" htmlFor="controlled-prescriber-reg">
              Prescriber registration
            </Label>
            <Input
              id="controlled-prescriber-reg"
              className="h-11"
              disabled={disabled}
              value={controlled.prescriberRegNo}
              onChange={(event) => controlled.onChange('prescriberRegNo', event.target.value)}
            />
          </>
        ) : null}
        <label
          className="flex min-h-11 items-center gap-2 text-sm text-text-body"
          htmlFor="controlled-rx-serial"
        >
          <input
            id="controlled-rx-serial"
            type="checkbox"
            checked={controlled.rxSerialWritten}
            disabled={disabled}
            onChange={(event) => controlled.onChange('rxSerialWritten', event.target.checked)}
          />
          Register serial written on the prescription
        </label>
        <Label className="text-xs text-text-muted" htmlFor="controlled-ref-serial">
          Earlier register serial
        </Label>
        <Input
          id="controlled-ref-serial"
          className="h-11"
          inputMode="numeric"
          disabled={disabled}
          value={controlled.refSerial}
          onChange={(event) => controlled.onChange('refSerial', event.target.value)}
        />
      </section>
      <section
        aria-labelledby="controlled-step-pharmacist"
        className="space-y-2.5 border-t border-border-subtle pt-4"
      >
        <h5 id="controlled-step-pharmacist" className="text-[15px] font-semibold text-text-strong">
          3 · Approving pharmacist
        </h5>
        <Label htmlFor="controlled-pharmacist">Approving pharmacist</Label>
        <select
          id="controlled-pharmacist"
          className="h-11 w-full rounded-md border border-border-subtle bg-surface-raised px-3 focus-visible:outline-2 focus-visible:outline-ring"
          disabled={disabled || controlled.loading || controlled.error}
          value={controlled.staffProfileId}
          onChange={(event) => controlled.onChange('staffProfileId', event.target.value)}
        >
          <option value="">Select pharmacist</option>
          {controlled.pharmacists.map((staff) => (
            <option key={staff.id} value={staff.id}>
              {staff.name}
            </option>
          ))}
        </select>
        {controlled.loading ? (
          <p role="status">Loading pharmacists…</p>
        ) : controlled.error ? (
          <p role="alert">Pharmacists could not be loaded. Retry by refreshing the counter.</p>
        ) : controlled.pharmacists.length === 0 ? (
          <p role="status">
            No independent pharmacist with an active staff PIN is available. Ask your administrator
            to configure one.
          </p>
        ) : null}
        <Label htmlFor="controlled-pin">{approvalCopy.pharmacistLabel}</Label>
        <Input
          id="controlled-pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={8}
          className="h-11"
          aria-describedby="controlled-pin-hint"
          disabled={disabled || !controlled.staffProfileId}
          value={controlled.pin}
          onChange={(event) => controlled.onChange('pin', event.target.value)}
        />
        <p id="controlled-pin-hint" className="text-xs text-text-muted">
          {approvalCopy.hint}
        </p>
        <p className="text-xs text-text-muted">{approvalCopy.pharmacistCleared}</p>
      </section>
    </section>
  );
}

/** Counter v2 A5: three short bars, done in the success token, the next one in ink. */
function ControlledSteps({ steps }: { steps: ReadonlyArray<{ label: string; done: boolean }> }) {
  const next = steps.findIndex((step) => !step.done);
  return (
    <ol aria-label="Authorization steps" className="flex gap-1.5">
      {steps.map((step, index) => {
        const state = step.done ? 'done' : index === next ? 'now' : 'todo';
        return (
          <li
            key={step.label}
            data-state={state}
            className={`grid flex-1 gap-1.5 text-xs font-semibold ${state === 'now' ? 'text-text-strong' : 'text-text-muted'}`}
          >
            <span
              aria-hidden="true"
              className={`h-1 rounded-full ${state === 'done' ? 'bg-success' : state === 'now' ? 'bg-text-strong' : 'bg-surface-sunken'}`}
            />
            <span>
              {step.label}
              <span className="sr-only">{state === 'done' ? ', done' : ', to do'}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
