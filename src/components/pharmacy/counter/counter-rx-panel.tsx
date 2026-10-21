'use client';

import { forwardRef, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';

import {
  attachmentUrl,
  fileError,
  imageBase64,
  isImageType,
} from '@/components/pharmacy/dispensing/prescriptions-console';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import type { CounterAlert } from '@/lib/pharmacy/counter-alerts';
import type { CounterPatientPanel } from '@/lib/pharmacy/counter-prescriptions';
import { formatReceiptDate } from '@/lib/pharmacy/counter-receipt';
import type { RxOcrPrefill } from '@/lib/pharmacy/rx-ocr';
import { trpc } from '@/lib/trpc';

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

const isoDay = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

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
        validFrom: new Date(isoDay()),
        validUntil: new Date(String(data.get('validUntil'))),
        authorizedRepeats: Number(data.get('authorizedRepeats')),
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
                  id="counter-rx-valid-until"
                  name="validUntil"
                  type="date"
                  required
                  min={isoDay(1)}
                  defaultValue={isoDay(30)}
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
                <Label htmlFor="counter-rx-repeats">Authorized repeats</Label>
                <Input
                  id="counter-rx-repeats"
                  name="authorizedRepeats"
                  type="number"
                  min={0}
                  step={1}
                  required
                  defaultValue={0}
                  aria-describedby="counter-rx-repeats-hint"
                  className="h-11"
                />
                <p id="counter-rx-repeats-hint" className="text-xs text-text-muted">
                  Number of refills beyond the first fill. Total authorised = units × (repeats + 1).
                </p>
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
              <label className="flex items-start gap-2 text-sm text-text-body">
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
  rxAuthorization?: {
    prescriptionLineId: string;
    reason: string;
    staffProfileId: string;
    pin: string;
    actorCanDispense: boolean;
    loading: boolean;
    error: boolean;
    pharmacists: ReadonlyArray<{ id: string; name: string }>;
    onChange: (
      field: 'prescriptionLineId' | 'reason' | 'staffProfileId' | 'pin',
      value: string
    ) => void;
  };
  controlled?: {
    prescriptionLineId: string;
    staffProfileId: string;
    pin: string;
    pharmacists: ReadonlyArray<{ id: string; name: string }>;
    loading: boolean;
    error: boolean;
    patientAddress: string;
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
  patient: CounterPatientPanel | null;
  candidates: ReadonlyArray<{ patientId: string; displayName: string; phone: string | null }>;
  query: string;
  state: 'idle' | 'loading' | 'ready' | 'error' | 'denied';
  error?: string | null;
  disabled?: boolean;
  onQueryChange: (query: string) => void;
  onSearch: () => void;
  onSelectPatient: (patientId: string) => void;
  onClearPatient: () => void;
  canCapturePrescription?: boolean;
  onCapturePrescription?: (context: { patientId: string }) => void;
  /** #235: sign (pharmacist-verify) a cart Rx line without leaving the counter. */
  onSignPrescriptionLine?: (prescriptionLineId: string) => void;
  signing?: boolean;
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
      rxAuthorization: rx,
      alerts,
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
      canCapturePrescription = false,
      onSignPrescriptionLine,
      signing = false,
    },
    ref
  ) {
    // A mismatch is meaningful only after the bill has an attached patient.
    // In particular, do not make the initial anonymous-bill state look as if
    // the operator selected the wrong person.
    const visibleAlerts = alerts.filter(
      (alert) => alert.code !== 'PRESCRIPTION_PATIENT_MISMATCH' || patient !== null
    );
    const blocks = visibleAlerts.filter((alert) => alert.severity === 'SAFETY_BLOCK');
    const advice = visibleAlerts.filter((alert) => alert.severity === 'CLINICAL_ADVICE');
    const commercial = visibleAlerts.filter((alert) => alert.severity === 'COMMERCIAL');

    return (
      <div ref={ref} tabIndex={-1} className="space-y-5 focus-visible:outline-none">
        {rx ? (
          <fieldset
            disabled={disabled}
            className="space-y-3 rounded-md border border-border-subtle p-3"
          >
            <legend className="font-semibold text-text-strong">
              Rx and restricted authorization
            </legend>
            <p className="text-sm text-text-body">
              Select a prescription line below, or record a pharmacist override.
            </p>
            {rx.prescriptionLineId ? (
              <div role="status">
                Prescription line selected.
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => rx.onChange('prescriptionLineId', '')}
                >
                  Use pharmacist override
                </Button>
              </div>
            ) : (
              <>
                <Label htmlFor="rx-reason">Pharmacist override reason</Label>
                <Input
                  id="rx-reason"
                  className="h-11"
                  maxLength={500}
                  value={rx.reason}
                  onChange={(event) => rx.onChange('reason', event.target.value)}
                />
                {!rx.actorCanDispense ? (
                  <>
                    <Label htmlFor="rx-staff">Override pharmacist</Label>
                    <select
                      id="rx-staff"
                      className="h-11 w-full rounded-md border border-border-subtle bg-surface-raised px-3 focus-visible:outline-2 focus-visible:outline-ring"
                      disabled={rx.loading || rx.error}
                      value={rx.staffProfileId}
                      onChange={(event) => rx.onChange('staffProfileId', event.target.value)}
                    >
                      <option value="">Select pharmacist</option>
                      {rx.pharmacists.map((staff) => (
                        <option key={staff.id} value={staff.id}>
                          {staff.name}
                        </option>
                      ))}
                    </select>
                    <Label htmlFor="rx-pin">Override pharmacist PIN</Label>
                    <Input
                      id="rx-pin"
                      className="h-11"
                      type="password"
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={8}
                      disabled={!rx.staffProfileId}
                      value={rx.pin}
                      onChange={(event) => rx.onChange('pin', event.target.value)}
                    />
                    {rx.loading ? (
                      <p role="status">Checking pharmacist authorization…</p>
                    ) : rx.error ? (
                      <p role="alert">Authorization could not be loaded. Refresh the counter.</p>
                    ) : rx.pharmacists.length === 0 ? (
                      <p role="status">
                        No independent pharmacist with an active PIN is available.
                      </p>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
          </fieldset>
        ) : null}
        {controlled ? (
          <section
            aria-label="Controlled medicine authorization"
            className="space-y-3 rounded-md border border-border-subtle p-3"
          >
            <h4 className="font-semibold text-text-strong">Controlled medicine authorization</h4>
            <p className="text-xs text-text-muted">
              Patient address and a pharmacist PIN are required. Use a prescription, or record an
              emergency supply. Online only.
            </p>
            <Label className="text-xs text-text-muted" htmlFor="controlled-address">
              Patient address
            </Label>
            <Input
              id="controlled-address"
              className="h-9"
              disabled={disabled || !patient}
              value={controlled.patientAddress}
              onChange={(event) => controlled.onChange('patientAddress', event.target.value)}
            />
            <label
              className="flex items-center gap-2 text-xs text-text-muted"
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
                  className="h-9"
                  disabled={disabled}
                  value={controlled.prescriberName}
                  onChange={(event) => controlled.onChange('prescriberName', event.target.value)}
                />
                <Label className="text-xs text-text-muted" htmlFor="controlled-prescriber-reg">
                  Prescriber registration
                </Label>
                <Input
                  id="controlled-prescriber-reg"
                  className="h-9"
                  disabled={disabled}
                  value={controlled.prescriberRegNo}
                  onChange={(event) => controlled.onChange('prescriberRegNo', event.target.value)}
                />
              </>
            ) : null}
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
                      {line.medicineName} · {rx.prescriberName} · {line.remainingAuthorizedUnits}{' '}
                      units
                    </option>
                  ))
                )}
            </select>
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
                No independent pharmacist with an active staff PIN is available. Ask your
                administrator to configure one.
              </p>
            ) : null}
            <Label htmlFor="controlled-pin">Pharmacist PIN</Label>
            <Input
              id="controlled-pin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={8}
              className="h-11"
              disabled={disabled || !controlled.staffProfileId}
              value={controlled.pin}
              onChange={(event) => controlled.onChange('pin', event.target.value)}
            />
            <label
              className="flex items-center gap-2 text-xs text-text-muted"
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
              className="h-9"
              inputMode="numeric"
              disabled={disabled}
              value={controlled.refSerial}
              onChange={(event) => controlled.onChange('refSerial', event.target.value)}
            />
            <p className="text-xs text-text-muted">
              Leave the earlier serial blank unless this repeats a previous entry. PIN is cleared
              after each attempt.
            </p>
          </section>
        ) : null}
        <section aria-label="Safety blocks" className="space-y-2">
          <h3 className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
            Safety blocks
          </h3>
          {blocks.length === 0 ? (
            <p className="text-sm text-text-muted">
              No safety block on this bill. Lines may still carry advice below.
            </p>
          ) : (
            <ul className="space-y-2">
              {blocks.map((alert) => (
                <li
                  key={alert.key}
                  role="alert"
                  className="rounded-md border-l-4 border-destructive border-y border-r border-y-destructive/30 border-r-destructive/30 bg-destructive/10 p-3"
                >
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text-strong">
                    <StatusPill status="blocked" tone="danger" label="Blocked" />
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

        {advice.length > 0 ? (
          <section aria-label="Clinical advice" className="space-y-2">
            <h3 className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
              Counselling
            </h3>
            <ul className="space-y-2">
              {advice.map((alert) => (
                <li
                  key={alert.key}
                  role="status"
                  className="rounded-md border border-border-subtle bg-surface-sunken p-3 text-sm text-text-body"
                >
                  <StatusPill status="advice" tone="info" label="Advice" />
                  <span className="ml-2">{alert.message}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {commercial.length > 0 ? (
          <section aria-label="Commercial notices" className="space-y-2">
            <h3 className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
              Commercial
            </h3>
            <ul className="space-y-2">
              {commercial.map((alert) => (
                <li
                  key={alert.key}
                  role="status"
                  className="rounded-md border border-dashed border-border-subtle p-3 text-sm text-text-muted"
                >
                  <StatusPill status="commercial" tone="neutral" label="Commercial" />
                  <span className="ml-2">{alert.message}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section aria-label="Patient and prescriptions" className="space-y-3">
          <h3 className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
            Patient
          </h3>

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
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11"
                    disabled={disabled}
                    onClick={onClearPatient}
                  >
                    Detach
                  </Button>
                </div>
              </div>

              {canCapturePrescription ? (
                <div className="space-y-2">
                  {onCapturePrescription ? (
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
                      className={buttonVariants({ variant: 'outline', className: 'h-11' })}
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
                </div>
              ) : null}

              {patient.prescriptions.length === 0 ? (
                <p className="text-sm text-text-muted">
                  No prescription is on file for this patient.
                </p>
              ) : (
                <ul className="space-y-3">
                  {patient.prescriptions.map((prescription) => (
                    <li
                      key={prescription.prescriptionId}
                      className="rounded-md border border-border-subtle p-3"
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
                      <p className="font-mono text-xs text-text-muted">
                        {formatReceiptDate(prescription.validFrom)} →{' '}
                        {formatReceiptDate(prescription.validUntil)} · repeats{' '}
                        {prescription.authorizedRepeats} · {prescription.custodyState.toLowerCase()}
                      </p>
                      <ul className="mt-2 space-y-1">
                        {prescription.lines.map((line) => (
                          <li
                            key={line.prescriptionLineId}
                            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
                          >
                            <span className="text-text-strong">{line.medicineName}</span>
                            {rx ? (
                              <Button
                                type="button"
                                variant="outline"
                                disabled={disabled || !prescription.inDate}
                                aria-pressed={rx.prescriptionLineId === line.prescriptionLineId}
                                onClick={() =>
                                  rx.onChange('prescriptionLineId', line.prescriptionLineId)
                                }
                              >
                                Select for Rx authorization
                              </Button>
                            ) : null}
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
                            {!line.verified && onSignPrescriptionLine ? (
                              <Button
                                type="button"
                                variant="outline"
                                disabled={disabled || signing || !prescription.inDate}
                                onClick={() => onSignPrescriptionLine(line.prescriptionLineId)}
                              >
                                {signing ? 'Signing…' : 'Sign as pharmacist'}
                              </Button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
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
                <p className="text-sm text-text-muted">No patient matches that search.</p>
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
      </div>
    );
  }
);
