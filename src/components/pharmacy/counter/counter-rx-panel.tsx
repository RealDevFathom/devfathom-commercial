'use client';

import { useTranslations } from 'next-intl';
import { useCounterError } from '@/i18n/use-counter-error';
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
import { CounterDuplicateSaltAcknowledge } from './counter-duplicate-salt-acknowledge';
import type { CounterAlert } from '@/lib/pharmacy/counter-alerts';
import type { CounterPatientPanel } from '@/lib/pharmacy/counter-prescriptions';
import { formatReceiptDate } from '@/lib/pharmacy/counter-receipt';
import type { RxOcrPrefill } from '@/lib/pharmacy/rx-ocr';
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
  const ct = useTranslations('CounterText');
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
      <span className="sr-only"> {ct('opensInANewTab')}</span>
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
  const ct = useTranslations('CounterText');
  const messageFrom = useCounterError();
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
    if (!file || !isImageType(file.type)) throw new Error(ct('takePrescriptionPhoto'));
    const result = await uploadSource.mutateAsync({
      patientId,
      contentType: file.type,
      dataBase64: await imageBase64(file),
    });
    if (!attachmentUrl(result?.url) || result.sourceFileRef !== result.url) {
      throw new Error(ct('uploadNotConfirmed'));
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
      setError(failure instanceof Error ? failure.message : ct('thePrescriptionCouldNotBeRead'));
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
      setError(ct('confirmTheSuggestedValuesAgainstThePhotoBeforeSaving'));
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
        ct('value0YourPhotoAndFormAreKeptForRetry', {
          value0: failure instanceof Error ? failure.message : ct('requestFailed'),
        })
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
            label={ct('savedPrescriptionPhotoForValue0', { value0: patientName })}
          />
          <span>{ct('prescriptionPhotoSavedAPharmacistMustStillSignIt')}</span>
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
          {ct('photographPrescription')}
        </Button>
      ) : (
        <form
          aria-label={ct('photographPrescription')}
          aria-busy={busy}
          onSubmit={submit}
          className="space-y-3 rounded-md border border-border-subtle p-3"
        >
          <fieldset disabled={disabled || busy} className="grid min-w-0 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="counter-rx-photo">{ct('prescriptionPhoto')}</Label>
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
                className="block w-full text-sm file:me-3 file:h-11 file:rounded-md file:border file:border-border-subtle file:bg-transparent file:px-3 file:font-semibold"
              />
              <p id="counter-rx-photo-hint" className="text-xs text-text-muted">
                {ct('jpegPNGOrWebPUpTo5MiBStored')}
              </p>
            </div>
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={preview}
                alt={ct('selectedPrescriptionPhoto')}
                className="size-24 rounded-md border border-border-subtle object-cover"
              />
            ) : null}

            {file && !fileError(file) ? (
              <Button type="button" variant="outline" className="h-11" onClick={suggest}>
                {extractSource.isPending ? ct('readingPhoto') : ct('suggestFromPhoto')}
              </Button>
            ) : null}

            {prefill ? (
              <section aria-label={ct('suggestionsFromPhoto')} className="space-y-2">
                <p className="text-xs text-text-muted">
                  {ct('readBy')}
                  {prefill.adapter.toLowerCase()} {ct('ocrNothingIsFilledInUntilYouChooseA')}
                </p>
                {prefill.lines.length === 0 ? (
                  <p className="text-sm text-text-muted">
                    {ct('noMedicineCouldBeReadFromThePhoto')}
                  </p>
                ) : null}
                {prefill.lines.map((line, index) => (
                  <div key={index} className="space-y-1 rounded-md bg-surface-sunken p-2 text-sm">
                    <p className="text-text-strong">
                      {ct('read')}{' '}
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
                          {ct('useMedicine')}
                          {candidate.label}
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
                          {ct('useDirections')}
                          {line.dose.value}” ({Math.round(line.dose.confidence * 100)}
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
                <Label htmlFor="counter-rx-prescriber">{ct('prescriber')}</Label>
                <select
                  id="counter-rx-prescriber"
                  name="prescriberId"
                  required
                  defaultValue=""
                  className={selectClass}
                >
                  <option value="" disabled>
                    {workspace.isLoading ? ct('loading') : ct('selectPrescriber')}
                  </option>
                  {workspace.data?.prescribers.map((prescriber) => (
                    <option key={prescriber.id} value={prescriber.id}>
                      {prescriber.name} · {prescriber.registrationNumber}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="counter-rx-valid-until">{ct('validUntil')}</Label>
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
                <Label htmlFor="counter-rx-medicine">{ct('medicine')}</Label>
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
                    {ct('selectMedicine')}
                  </option>
                  {workspace.data?.medicines.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.productName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="counter-rx-presentation">{ct('presentation')}</Label>
                <select
                  id="counter-rx-presentation"
                  required
                  disabled={!medicine}
                  value={presentationId}
                  onChange={(event) => setPresentationId(event.target.value)}
                  className={selectClass}
                >
                  <option value="" disabled>
                    {ct('selectPresentation')}
                  </option>
                  {medicine?.presentations.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.presentation}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="counter-rx-quantity">{ct('authorizedUnits')}</Label>
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
                <Label htmlFor="counter-rx-custody">{ct('originalCustody')}</Label>
                <select
                  id="counter-rx-custody"
                  name="custodyState"
                  defaultValue="NOT_HELD"
                  className={selectClass}
                >
                  <option value="NOT_HELD">{ct('returnedNotHeld')}</option>
                  <option value="HELD_AT_PHARMACY">{ct('heldAtPharmacy')}</option>
                </select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="counter-rx-directions">{ct('directions')}</Label>
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
                {ct('iHaveCheckedTheSuggestedMedicineAndDirectionsAgainst')}
              </label>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {messageFrom(new Error(error))}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                className="h-11"
                disabled={!file || Boolean(fileError(file)) || (usedSuggestion && !confirmed)}
              >
                {uploadSource.isPending
                  ? ct('uploadingPhoto')
                  : capture.isPending
                    ? ct('saving')
                    : ct('savePrescription')}
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
                {ct('cancel')}
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
    },
    ref
  ) {
    const ct = useTranslations('CounterText');
    const blocks = alerts.filter((alert) => alert.severity === 'SAFETY_BLOCK');
    const advice = alerts.filter((alert) => alert.severity === 'CLINICAL_ADVICE');
    const commercial = alerts.filter((alert) => alert.severity === 'COMMERCIAL');

    return (
      <div
        ref={ref}
        tabIndex={-1}
        className="min-w-0 space-y-5 rounded-lg focus-visible:outline-2 focus-visible:outline-ring"
      >
        <section aria-label={ct('safetyBlocks')} className="space-y-3">
          <h4 className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
            {ct('safetyBlocks')}
          </h4>
          {blocks.length === 0 ? (
            <p className="text-sm text-text-muted">
              {ct('safetyChecksRunBeforePaymentAnyReportedBlocksAppear')}
            </p>
          ) : (
            <ul className="space-y-2">
              {blocks.map((alert) => (
                <li
                  key={alert.key}
                  role="alert"
                  className="space-y-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3"
                >
                  <StatusPill status="blocked" tone="danger" label={ct('blocked')} />
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
            aria-label={ct('counsellingAndNotices')}
            className="space-y-3 border-t border-border-subtle pt-5"
          >
            <h4 className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
              {ct('counsellingAndNotices')}
            </h4>
            {advice.length > 0 ? (
              <ul aria-label={ct('clinicalAdvice')} className="space-y-2">
                {advice.map((alert) => (
                  <li
                    key={alert.key}
                    role="status"
                    className="space-y-2 rounded-xl border border-border-subtle bg-surface-card p-3 text-sm text-text-body"
                  >
                    <StatusPill status="advice" tone="neutral" label={ct('advice')} />
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
              <ul aria-label={ct('commercialNotices')} className="space-y-2">
                {commercial.map((alert) => (
                  <li
                    key={alert.key}
                    role="status"
                    className="space-y-2 rounded-xl bg-surface-sunken p-3 text-sm text-text-body"
                  >
                    <StatusPill status="commercial" tone="neutral" label={ct('commercial')} />
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
          aria-label={ct('patientAndPrescriptions')}
          className="space-y-3 border-t border-border-subtle pt-5"
        >
          <h4 className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
            {ct('patient')}
          </h4>

          {state === 'denied' ? (
            <p className="text-sm text-text-muted" role="status">
              {ct('prescriptionsAreNotEnabledForThisWorkspaceCommercialLines')}
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
                    <StatusPill status="consent" tone="success" label={ct('dispensingConsent')} />
                  ) : (
                    <StatusPill status="no-consent" tone="warning" label={ct('noConsentOnFile')} />
                  )}
                </div>
              </div>

              {patient.prescriptions.length === 0 ? (
                <p className="text-sm text-text-muted">
                  {ct('noPrescriptionIsOnFileForThisPatient')}
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
                              label={ct('prescriptionPhotoFromValue0', {
                                value0: prescription.prescriberName,
                              })}
                            />
                          ) : null}
                          <p className="text-sm text-text-strong">{prescription.prescriberName}</p>
                        </div>
                        {prescription.inDate ? (
                          <StatusPill status="valid" tone="success" label={ct('inDate')} />
                        ) : (
                          <StatusPill
                            status="expired"
                            tone="danger"
                            label={ct('outsideValidity')}
                          />
                        )}
                      </div>
                      <p className="break-words font-mono text-xs leading-relaxed text-text-muted">
                        {formatReceiptDate(prescription.validFrom)} →{' '}
                        {formatReceiptDate(prescription.validUntil)} {ct('repeats')}{' '}
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
                              {line.remainingAuthorizedUnits} {ct('of')}
                              {line.authorizedCanonicalUnits} {ct('unitsLeft')}
                            </span>
                            {line.verified ? (
                              <StatusPill
                                status="verified"
                                tone="success"
                                label={ct('pharmacistSigned')}
                              />
                            ) : (
                              <StatusPill
                                status="unverified"
                                tone="warning"
                                label={
                                  line.latestDecision
                                    ? ct('awaitingSignValue0', {
                                        value0: line.latestDecision.toLowerCase(),
                                      })
                                    : ct('awaitingPharmacist')
                                }
                              />
                            )}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  {onCapturePrescription ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11"
                      disabled={disabled || state === 'loading' || state === 'error'}
                      onClick={() => onCapturePrescription({ patientId: patient.patientId })}
                    >
                      {ct('capturePrescription')}
                    </Button>
                  ) : disabled || state === 'loading' || state === 'error' ? (
                    <Button type="button" variant="outline" className="h-11" disabled>
                      {ct('capturePrescription')}
                    </Button>
                  ) : (
                    <Link
                      className={cn(buttonVariants({ variant: 'outline' }), 'h-11 rounded-sm')}
                      href={`/pharmacy/prescriptions#patientId=${encodeURIComponent(patient.patientId)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      prefetch={false}
                    >
                      {ct('capturePrescription')}
                      <span className="sr-only">
                        {' '}
                        for {patient.displayName} {ct('opensInANewTab')}
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
                    {ct('detachPatient')}
                  </Button>
                </div>
                <p className="text-xs text-text-muted">
                  {onCapturePrescription
                    ? ct('captureEvidenceForValue0', { value0: patient.displayName })
                    : ct('opensCaptureForValue0InANewTabThis', {
                        value0: patient.displayName,
                      })}{' '}
                  {ct('captureDoesNotReplacePharmacistReviewOrDispensingConsent')}
                </p>
                <CounterRxPhotoCapture
                  key={patient.patientId}
                  patientId={patient.patientId}
                  patientName={patient.displayName}
                  disabled={disabled || state === 'loading' || state === 'error'}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-text-muted">
                {ct('selectAPatientToCaptureTheirPrescription')}
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="counter-patient-search">{ct('findPatient')}</Label>
                <div className="flex gap-2">
                  <Input
                    id="counter-patient-search"
                    value={query}
                    autoComplete="off"
                    disabled={disabled}
                    placeholder={ct('nameOrPhone')}
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
                    {ct('search')}
                  </Button>
                </div>
              </div>

              {state === 'loading' ? (
                <p className="text-sm text-text-muted" role="status">
                  {ct('searchingPatients')}
                </p>
              ) : null}
              {state === 'error' ? (
                <p className="text-sm text-destructive" role="alert">
                  {error ?? ct('patientSearchFailed')}
                </p>
              ) : null}
              {state === 'ready' && candidates.length === 0 ? (
                <p className="text-sm text-text-muted">{ct('noPatientMatchesThatSearch')}</p>
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
          <section
            aria-label={ct('controlledMedicineAuthorization')}
            className="space-y-3 border-t border-border-subtle pt-5"
          >
            <h4 className="font-semibold text-text-strong">
              {ct('controlledMedicineAuthorization')}
            </h4>
            <p className="text-xs text-text-muted">
              {ct('patientAddressAndAPharmacistPINAreRequiredUse')}
            </p>
            <Label className="text-xs text-text-muted" htmlFor="controlled-address">
              {ct('patientAddress')}
            </Label>
            <Input
              id="controlled-address"
              className="h-11"
              disabled={disabled || !patient}
              value={controlled.patientAddress}
              onChange={(event) => controlled.onChange('patientAddress', event.target.value)}
            />
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
              {ct('emergencySupplyNoPrescription')}
            </label>
            {controlled.emergency ? (
              <>
                <Label className="text-xs text-text-muted" htmlFor="controlled-prescriber-name">
                  {ct('prescriberName')}
                </Label>
                <Input
                  id="controlled-prescriber-name"
                  className="h-11"
                  disabled={disabled}
                  value={controlled.prescriberName}
                  onChange={(event) => controlled.onChange('prescriberName', event.target.value)}
                />
                <Label className="text-xs text-text-muted" htmlFor="controlled-prescriber-reg">
                  {ct('prescriberRegistration')}
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
            <Label htmlFor="controlled-prescription">{ct('prescriptionLine')}</Label>
            <select
              id="controlled-prescription"
              className="h-11 w-full rounded-md border border-border-subtle bg-surface-raised px-3 focus-visible:outline-2 focus-visible:outline-ring"
              disabled={disabled || !patient}
              value={controlled.prescriptionLineId}
              onChange={(event) => controlled.onChange('prescriptionLineId', event.target.value)}
            >
              <option value="">{ct('selectPrescription')}</option>
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
            <Label htmlFor="controlled-pharmacist">{ct('approvingPharmacist')}</Label>
            <select
              id="controlled-pharmacist"
              className="h-11 w-full rounded-md border border-border-subtle bg-surface-raised px-3 focus-visible:outline-2 focus-visible:outline-ring"
              disabled={disabled || controlled.loading || controlled.error}
              value={controlled.staffProfileId}
              onChange={(event) => controlled.onChange('staffProfileId', event.target.value)}
            >
              <option value="">{ct('selectPharmacist')}</option>
              {controlled.pharmacists.map((staff) => (
                <option key={staff.id} value={staff.id}>
                  {staff.name}
                </option>
              ))}
            </select>
            {controlled.loading ? (
              <p role="status">{ct('loadingPharmacists')}</p>
            ) : controlled.error ? (
              <p role="alert">{ct('pharmacistsCouldNotBeLoadedRetryByRefreshingThe')}</p>
            ) : controlled.pharmacists.length === 0 ? (
              <p role="status">{ct('noIndependentPharmacistWithAnActiveStaffPINIs')}</p>
            ) : null}
            <Label htmlFor="controlled-pin">{ct('pharmacistPIN')}</Label>
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
              {ct('registerSerialWrittenOnThePrescription')}
            </label>
            <Label className="text-xs text-text-muted" htmlFor="controlled-ref-serial">
              {ct('earlierRegisterSerial')}
            </Label>
            <Input
              id="controlled-ref-serial"
              className="h-11"
              inputMode="numeric"
              disabled={disabled}
              value={controlled.refSerial}
              onChange={(event) => controlled.onChange('refSerial', event.target.value)}
            />
            <p className="text-xs text-text-muted">
              {ct('leaveTheEarlierSerialBlankUnlessThisRepeatsA')}
            </p>
          </section>
        ) : null}
      </div>
    );
  }
);
