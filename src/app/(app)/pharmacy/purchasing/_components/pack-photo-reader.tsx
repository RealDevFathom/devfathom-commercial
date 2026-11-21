'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { Camera, RotateCcw, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import type { PackLabelProposal } from '@/lib/pharmacy/pack-label-ocr';
import {
  checkPackPhotoLot,
  minorToRupees,
  type PackPhotoLotField,
} from '@/lib/pharmacy/pack-photo-receiving';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { CONTROL } from './form-controls';

/** Matches the server's bounded-image limit. */
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
/** Longest edge kept on the device before upload; plenty for a printed batch. */
const MAX_EDGE = 2000;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
type PhotoType = (typeof PHOTO_TYPES)[number];

export type PackPhotoReaderProps = {
  branchId: string;
  purchaseOrderId: string;
  purchaseOrderLineId: string;
  /** Capture-fieldset key whose batch, expiry, precision, MRP, packs and shelf fields are filled. */
  fieldKey: string;
  lotLabel: string;
  medicineName: string;
  packLevel: string;
  unitsPerPack: number;
  outstandingPacks: number | null;
  locations: ReadonlyArray<{ id: string; label: string }>;
  defaultLocationId: string | null;
  /** The capture line already carries a scanned GS1 serial. */
  serialLocked?: boolean;
  /** Other lot slots of the same order line, so the outstanding balance is net of them. */
  siblingFieldKeys?: readonly string[];
};

type Draft = {
  batch: string;
  expiryDate: string;
  precision: 'DAY' | 'MONTH' | '';
  /** Printed MRP per pack in rupees. */
  mrp: string;
  packs: string;
  shelf: string;
  confirmed: boolean;
};

const EMPTY_DRAFT = (shelf: string): Draft => ({
  batch: '',
  expiryDate: '',
  precision: '',
  mrp: '',
  packs: '',
  shelf,
  confirmed: false,
});

/** "93% sure" beside a value read from the photo. */
function sureness(confidence: number): string {
  return `${Math.round(Math.min(1, Math.max(0, confidence)) * 100)}% sure`;
}

/**
 * The printed price and the pack's current price disagree: neither is filled
 * in, so the receiver has to choose one (or type the price on the pack).
 */
function priceConflict(proposal: PackLabelProposal | null): boolean {
  return (
    proposal?.price?.kind === 'read' &&
    proposal.currentMrpMinor !== null &&
    proposal.currentMrpMinor !== undefined &&
    proposal.price.amountMinor !== proposal.currentMrpMinor
  );
}

function isPhotoType(value: string): value is PhotoType {
  return (PHOTO_TYPES as readonly string[]).includes(value);
}

export function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The photo could not be read. Take it again.'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      if (comma < 0) reject(new Error('The photo could not be read. Take it again.'));
      else resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Downscale and re-encode on the device: smaller uploads on a phone, and the
 * canvas drops EXIF (including location) before anything leaves the bench.
 * Fails closed when the browser cannot re-encode it, so the original file and
 * its metadata are never uploaded; manual entry stays available.
 */
export async function preparedPhoto(
  file: File
): Promise<{ contentType: PhotoType; dataBase64: string }> {
  if (!isPhotoType(file.type)) throw new Error('Use a JPEG, PNG or WebP photo.');
  if (file.size === 0) throw new Error('That photo is empty. Take it again.');
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no canvas');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.85)
    );
    if (!blob || blob.size === 0 || blob.size > MAX_PHOTO_BYTES) throw new Error('no blob');
    return { contentType: 'image/jpeg', dataBase64: await base64Of(blob) };
  } catch {
    throw new Error(
      'This photo could not be prepared on this device. Take it again, or enter the batch and expiry by hand.'
    );
  }
}

function fill(form: HTMLFormElement, name: string, value: string) {
  const control = form.elements.namedItem(name);
  if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) return false;
  control.value = value;
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function fieldValue(form: HTMLFormElement | null | undefined, name: string): string {
  const control = form?.elements.namedItem(name);
  return control instanceof HTMLInputElement || control instanceof HTMLSelectElement
    ? control.value
    : '';
}

/**
 * DEV-752: photograph ONE pack, review the batch, expiry and (DEV-770) printed
 * MRP it suggests, enter how many packs carry that same lot, optionally pick a
 * shelf, then copy the reviewed values into this line's capture fields. Ten
 * packs of one batch are one scan and a typed count of 10. Nothing is drafted
 * or posted here: the receipt is still filed and posted through the existing
 * actions.
 */
export function PackPhotoReader(props: PackPhotoReaderProps) {
  const id = useId();
  // The reader's own controls belong to an inert form outside the receipt, so
  // Enter cannot draft the receipt and their validation cannot block filing it.
  const formId = `${id}-reader`;
  const root = useRef<HTMLDivElement>(null);
  const read = trpc.pharmacyPackLabel.read.useMutation();
  // Each read gets a number; a late answer to a closed or replaced read is ignored.
  const request = useRef(0);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [proposal, setProposal] = useState<PackLabelProposal | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(() => EMPTY_DRAFT(props.defaultLocationId ?? ''));
  const [shelfTouched, setShelfTouched] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<PackPhotoLotField, string>>>({});
  const [applied, setApplied] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const serialPrinted = proposal?.serialPrinted ?? false;
  const packsNumber = /^\d+$/.test(draft.packs.trim()) ? Number(draft.packs.trim()) : null;

  function reset() {
    setPreview(null);
    setProposal(null);
    setFailure(null);
    setDraft(EMPTY_DRAFT(props.defaultLocationId ?? ''));
    setShelfTouched(false);
    setErrors({});
    setNotes([]);
  }

  function close() {
    request.current += 1;
    reset();
    setOpen(false);
  }

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    const mine = (request.current += 1);
    reset();
    setApplied(null);
    setPreview(URL.createObjectURL(file));
    try {
      const photo = await preparedPhoto(file);
      // Closed or replaced while the device was re-encoding: do not spend a read.
      if (mine !== request.current) return;
      const result = await read.mutateAsync({
        branchId: props.branchId,
        purchaseOrderId: props.purchaseOrderId,
        purchaseOrderLineId: props.purchaseOrderLineId,
        photo,
      });
      if (mine !== request.current) return;
      setProposal(result);
      const form = root.current?.closest('form');
      const currentShelf = fieldValue(form, `stockLocation:${props.fieldKey}`);
      setDraft({
        batch: result.batch.value ?? '',
        expiryDate: result.expiry.kind === 'read' ? result.expiry.candidate.date : '',
        precision: result.expiry.kind === 'read' ? result.expiry.candidate.precision : '',
        // A price that disagrees with the current one is left for the receiver to choose.
        mrp:
          result.price?.kind === 'read' && !priceConflict(result)
            ? minorToRupees(result.price.amountMinor)
            : '',
        packs: '',
        shelf: currentShelf || props.defaultLocationId || '',
        confirmed: false,
      });
    } catch (error) {
      if (mine !== request.current) return;
      setFailure(
        error instanceof Error && error.message
          ? error.message
          : 'The pack photo could not be read. Enter the batch and expiry by hand.'
      );
    }
  }

  function update(patch: Partial<Draft>) {
    // Any edit invalidates an earlier confirmation: the receiver confirms what is shown.
    setDraft((current) => ({
      ...current,
      ...patch,
      confirmed: 'confirmed' in patch ? Boolean(patch.confirmed) : false,
    }));
    setApplied(null);
  }

  function apply() {
    const form = root.current?.closest('form');
    if (!form) return;
    // A scanned 2D code wins over typed values on the server, so a photo cannot
    // silently be booked under the scanned batch.
    if (fieldValue(form, `gs1Payload:${props.fieldKey}`)) {
      setFailure(
        'This lot was filled from a 2D scan. Use another lot for a pack with a different batch or expiry.'
      );
      return;
    }
    const otherLots = (props.siblingFieldKeys ?? []).reduce((total, key) => {
      if (!fieldValue(form, `batchNumber:${key}`)) return total;
      const packs = Number(fieldValue(form, `receivedPacks:${key}`));
      return total + (Number.isSafeInteger(packs) && packs > 0 ? packs : 0);
    }, 0);
    const check = checkPackPhotoLot({
      batch: draft.batch,
      expiryDate: draft.expiryDate,
      precision: draft.precision,
      packs: draft.packs,
      confirmedSameLot: draft.confirmed,
      serialPrinted,
      serialLocked:
        Boolean(props.serialLocked) || fieldValue(form, `serialNumber:${props.fieldKey}`) !== '',
      unitsPerPack: props.unitsPerPack,
      mrp: draft.mrp,
      priceChoiceRequired: priceConflict(proposal),
      outstandingPacks:
        props.outstandingPacks === null ? null : Math.max(0, props.outstandingPacks - otherLots),
    });
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }
    setErrors({});
    const key = props.fieldKey;
    const filled =
      fill(form, `batchNumber:${key}`, check.lot.batchNumber) &&
      fill(form, `printedExpiry:${key}`, check.lot.printedExpiry) &&
      fill(form, `expiryPrecision:${key}`, check.lot.expiryPrecision) &&
      fill(form, `receivedPacks:${key}`, String(check.lot.receivedPacks)) &&
      (check.lot.printedMrpMinor === null ||
        fill(form, `printedMrp:${key}`, minorToRupees(check.lot.printedMrpMinor)));
    // An untouched shelf keeps whatever the line already had (the branch default).
    if (filled && shelfTouched && draft.shelf) fill(form, `stockLocation:${key}`, draft.shelf);
    if (!filled) {
      setFailure('This line could not be filled. Enter the values in the fields below.');
      return;
    }
    setNotes(check.notes);
    setApplied(
      `${props.lotLabel}: batch ${check.lot.batchNumber}, expiry ${check.lot.printedExpiry}${
        check.lot.printedMrpMinor === null
          ? ''
          : `, MRP Rs ${minorToRupees(check.lot.printedMrpMinor)}`
      }, ${check.lot.receivedPacks} ${props.packLevel} (${check.lot.canonicalUnits} units). Check the rest of the line, then file the receipt. Nothing is in stock yet.`
    );
    setPreview(null);
    setProposal(null);
    setOpen(false);
    // The panel holding the focused button unmounts; keep focus on the filled line.
    const batchField = form.elements.namedItem(`batchNumber:${key}`);
    if (batchField instanceof HTMLInputElement) batchField.focus();
  }

  // Mounted for the component's whole life so screen readers announce updates.
  const liveRegion = (
    <div aria-live="polite" className="space-y-1" role="status">
      {applied ? <p className="text-sm text-success">{applied}</p> : null}
      {notes.map((note) => (
        <p className="text-sm text-warning" key={note}>
          {note}
        </p>
      ))}
    </div>
  );

  const trigger = (
    <Button
      className="h-auto min-h-11 max-w-full py-2 text-left whitespace-normal"
      onClick={() => setOpen(true)}
      size="touch"
      type="button"
      variant="outline"
    >
      <Camera aria-hidden="true" />
      Read batch and expiry, plus printed MRP, from a pack photo
    </Button>
  );

  const conversion =
    packsNumber && packsNumber > 0
      ? `${packsNumber} ${props.packLevel} × ${props.unitsPerPack} = ${packsNumber * props.unitsPerPack} units`
      : `1 ${props.packLevel} = ${props.unitsPerPack} units`;
  const describe = (field: PackPhotoLotField) =>
    errors[field] ? `${id}-${field}-error` : undefined;

  return (
    <div ref={root} className="mt-3 space-y-2">
      {open
        ? createPortal(
            <form
              hidden
              id={formId}
              noValidate
              onSubmit={(event) => {
                // React bubbles portal events through the component tree; stop it here.
                event.preventDefault();
                event.stopPropagation();
              }}
            />,
            document.body
          )
        : null}
      {open ? (
        <div
          className="rounded-[var(--radius-sm)] border border-border-default bg-surface-sunken p-4"
          role="group"
          aria-labelledby={`${id}-title`}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-strong" id={`${id}-title`}>
                Pack photo — {props.lotLabel}
              </p>
              <p className="text-xs text-text-muted">
                {props.medicineName} · {props.packLevel}. From the order line; a photo never changes
                the medicine, pack or order.
              </p>
            </div>
            <Button type="button" size="touch" variant="ghost" onClick={close}>
              <X aria-hidden="true" />
              Close
            </Button>
          </div>

          <div className="mt-3 space-y-1">
            <label className="block text-sm font-medium text-text-body" htmlFor={`${id}-photo`}>
              Photo of one pack
            </label>
            <input
              form={formId}
              accept={PHOTO_TYPES.join(',')}
              capture="environment"
              className={cn(CONTROL, 'py-2')}
              disabled={read.isPending}
              id={`${id}-photo`}
              onChange={(event) => {
                void onPhoto(event.currentTarget.files?.[0]);
                event.currentTarget.value = '';
              }}
              type="file"
            />
            <p className="text-xs text-text-muted">
              Frame the printed batch, expiry and MRP. The photo is read once and is not stored.
            </p>
          </div>

          {read.isPending ? (
            <p className="mt-3 text-sm text-text-muted" role="status">
              Reading the pack…
            </p>
          ) : null}
          {failure ? (
            <div className="mt-3 flex flex-wrap items-center gap-3" role="alert">
              <p className="text-sm text-destructive">{failure}</p>
              <p className="text-sm text-text-muted">The line fields below still work by hand.</p>
            </div>
          ) : null}

          {proposal ? (
            <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
              {preview ? (
                // eslint-disable-next-line @next/next/no-img-element -- local object URL, never uploaded
                <img
                  alt="The photographed pack"
                  className="max-h-64 w-full rounded-[var(--radius-sm)] border border-border-subtle bg-surface-raised object-contain"
                  src={preview}
                />
              ) : null}
              <div className="min-w-0 space-y-3">
                {proposal.warnings.length ? (
                  <ul className="space-y-1" role="status">
                    {proposal.warnings.map((warning) => (
                      <li className="text-sm text-warning" key={warning.code}>
                        {warning.message}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-text-muted" role="status">
                    Suggested from the photo. Check each value against the pack before using it.
                  </p>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="min-w-0 space-y-1">
                    <label
                      className="block text-sm font-medium text-text-body"
                      htmlFor={`${id}-batch`}
                    >
                      Batch number
                    </label>
                    <input
                      form={formId}
                      aria-describedby={describe('batch') ?? `${id}-batch-hint`}
                      aria-invalid={Boolean(errors.batch)}
                      autoComplete="off"
                      className={CONTROL}
                      id={`${id}-batch`}
                      onChange={(event) => update({ batch: event.currentTarget.value })}
                      value={draft.batch}
                    />
                    {errors.batch ? (
                      <p className="text-sm text-destructive" id={`${id}-batch-error`}>
                        {errors.batch}
                      </p>
                    ) : (
                      <p className="text-xs text-text-muted" id={`${id}-batch-hint`}>
                        {proposal.batch.value
                          ? `Read from the photo (${sureness(proposal.batch.confidence)}). Correct it if the pack differs.`
                          : 'Not readable on the photo. Type it from the pack.'}
                      </p>
                    )}
                  </div>

                  <div className="min-w-0 space-y-1">
                    <label
                      className="block text-sm font-medium text-text-body"
                      htmlFor={`${id}-expiry`}
                    >
                      Printed expiry
                    </label>
                    <input
                      form={formId}
                      aria-describedby={describe('expiry') ?? `${id}-expiry-hint`}
                      aria-invalid={Boolean(errors.expiry)}
                      className={CONTROL}
                      id={`${id}-expiry`}
                      onChange={(event) => update({ expiryDate: event.currentTarget.value })}
                      type="date"
                      value={draft.expiryDate}
                    />
                    {errors.expiry ? (
                      <p className="text-sm text-destructive" id={`${id}-expiry-error`}>
                        {errors.expiry}
                      </p>
                    ) : (
                      <p className="text-xs text-text-muted" id={`${id}-expiry-hint`}>
                        {proposal.expiry.printed
                          ? `Printed: “${proposal.expiry.printed}”${
                              proposal.expiry.kind === 'read'
                                ? ` (${sureness(proposal.expiry.confidence)})`
                                : ''
                            }.`
                          : 'No expiry was readable. Type it from the pack.'}{' '}
                        Month-only prints use the last day of that month.
                      </p>
                    )}
                  </div>
                </div>

                {proposal.expiry.kind === 'ambiguous' ? (
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium text-text-body">
                      Which date is printed? “{proposal.expiry.printed}” can be read two ways.
                    </legend>
                    <div className="flex flex-wrap gap-3">
                      {proposal.expiry.candidates.map((candidate) => (
                        <label
                          className="flex min-h-11 items-center gap-2 text-sm text-text-body"
                          key={candidate.date}
                        >
                          <input
                            form={formId}
                            checked={draft.expiryDate === candidate.date}
                            name={`${id}-candidate`}
                            onChange={() =>
                              update({ expiryDate: candidate.date, precision: candidate.precision })
                            }
                            type="radio"
                          />
                          {candidate.date}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ) : null}

                <div className="min-w-0 space-y-1">
                  <label className="block text-sm font-medium text-text-body" htmlFor={`${id}-mrp`}>
                    Printed MRP per pack (PKR)
                  </label>
                  <input
                    form={formId}
                    aria-describedby={describe('price') ?? `${id}-mrp-hint`}
                    aria-invalid={Boolean(errors.price)}
                    autoComplete="off"
                    className={cn(CONTROL, 'font-mono tabular-nums')}
                    id={`${id}-mrp`}
                    inputMode="decimal"
                    onChange={(event) => update({ mrp: event.currentTarget.value })}
                    value={draft.mrp}
                  />
                  {errors.price ? (
                    <p className="text-sm text-destructive" id={`${id}-price-error`}>
                      {errors.price}
                    </p>
                  ) : (
                    <p className="text-xs text-text-muted" id={`${id}-mrp-hint`}>
                      {proposal.price?.kind === 'read'
                        ? `Printed: “${proposal.price.printed}” (${sureness(proposal.price.confidence)}). Correct it if the pack differs.`
                        : proposal.price?.kind === 'ambiguous'
                          ? `More than one price on the label (“${proposal.price.printed}”). Type the MRP printed on the pack.`
                          : 'No price was readable. Type the MRP from the pack, or leave it blank to fill it on the line.'}
                    </p>
                  )}
                </div>

                {priceConflict(proposal) && proposal?.price?.kind === 'read' ? (
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium text-text-body">
                      The printed price differs from the current price. Which one applies?
                    </legend>
                    <div className="flex flex-wrap gap-3">
                      {[
                        {
                          key: 'printed',
                          label: `Printed on the pack: Rs ${minorToRupees(proposal.price.amountMinor)}`,
                          value: minorToRupees(proposal.price.amountMinor),
                        },
                        {
                          key: 'current',
                          label: `Current price: Rs ${minorToRupees(proposal.currentMrpMinor!)}`,
                          value: minorToRupees(proposal.currentMrpMinor!),
                        },
                      ].map((option) => (
                        <label
                          className="flex min-h-11 items-center gap-2 font-mono text-sm tabular-nums text-text-body"
                          key={option.key}
                        >
                          <input
                            form={formId}
                            checked={draft.mrp === option.value}
                            name={`${id}-price-choice`}
                            onChange={() => update({ mrp: option.value })}
                            type="radio"
                          />
                          {option.label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ) : null}

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="min-w-0 space-y-1">
                    <label
                      className="block text-sm font-medium text-text-body"
                      htmlFor={`${id}-precision`}
                    >
                      Expiry precision
                    </label>
                    <StudioSelect
                      form={formId}
                      className={CONTROL}
                      id={`${id}-precision`}
                      onChange={(event) =>
                        update({ precision: event.currentTarget.value as Draft['precision'] })
                      }
                      value={draft.precision}
                    >
                      <option value="">Choose…</option>
                      <option value="MONTH">Month printed (e.g. 06/2027)</option>
                      <option value="DAY">Exact day printed</option>
                    </StudioSelect>
                  </div>

                  <div className="min-w-0 space-y-1">
                    <label
                      className="block text-sm font-medium text-text-body"
                      htmlFor={`${id}-packs`}
                    >
                      Packs with this exact batch and expiry
                    </label>
                    <input
                      form={formId}
                      aria-describedby={describe('packs') ?? `${id}-packs-hint`}
                      aria-invalid={Boolean(errors.packs)}
                      className={CONTROL}
                      id={`${id}-packs`}
                      inputMode="numeric"
                      max={serialPrinted || props.serialLocked ? 1 : undefined}
                      min={1}
                      onChange={(event) => update({ packs: event.currentTarget.value })}
                      step={1}
                      type="number"
                      value={draft.packs}
                    />
                    {errors.packs ? (
                      <p className="text-sm text-destructive" id={`${id}-packs-error`}>
                        {errors.packs}
                      </p>
                    ) : (
                      <p
                        className="font-mono text-xs tabular-nums text-text-muted"
                        id={`${id}-packs-hint`}
                      >
                        {conversion}
                        {props.outstandingPacks !== null
                          ? ` · ${props.outstandingPacks} ${props.packLevel} outstanding`
                          : ''}
                      </p>
                    )}
                  </div>
                </div>

                {props.locations.length ? (
                  <div className="min-w-0 space-y-1">
                    <label
                      className="block text-sm font-medium text-text-body"
                      htmlFor={`${id}-shelf`}
                    >
                      Receive into (optional)
                    </label>
                    <StudioSelect
                      form={formId}
                      className={CONTROL}
                      id={`${id}-shelf`}
                      onChange={(event) => {
                        setShelfTouched(true);
                        update({ shelf: event.currentTarget.value });
                      }}
                      value={draft.shelf}
                    >
                      <option value="">Keep the line’s location</option>
                      {props.locations.map((location) => (
                        <option key={location.id} value={location.id}>
                          {location.label}
                        </option>
                      ))}
                    </StudioSelect>
                    <p className="text-xs text-text-muted">
                      Changes this receipt line only. The branch and medicine defaults stay as they
                      are.
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-text-muted">
                    This branch has no active stock location. Create one before receiving; none is
                    chosen for you.
                  </p>
                )}

                <div className="space-y-1">
                  <label className="flex min-h-11 items-start gap-2 text-sm text-text-body">
                    <input
                      form={formId}
                      aria-describedby={describe('confirm')}
                      aria-invalid={Boolean(errors.confirm)}
                      checked={draft.confirmed}
                      className="mt-1"
                      onChange={(event) => update({ confirmed: event.currentTarget.checked })}
                      type="checkbox"
                    />
                    I checked this batch and expiry against the pack, and the MRP shown, and every
                    pack I counted carries this same batch and expiry.
                  </label>
                  {errors.confirm ? (
                    <p className="text-sm text-destructive" id={`${id}-confirm-error`}>
                      {errors.confirm}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-3">
                  <Button type="button" size="touch" onClick={apply}>
                    Use for {props.lotLabel.toLowerCase()}
                  </Button>
                  <Button type="button" size="touch" variant="outline" onClick={reset}>
                    <RotateCcw aria-hidden="true" />
                    Discard photo
                  </Button>
                </div>
                <p className="text-xs text-text-muted">
                  A different batch or expiry is a separate lot. Using these values fills the line
                  below; the receipt is still filed as a draft and posted after review.
                </p>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        trigger
      )}
      {liveRegion}
    </div>
  );
}
