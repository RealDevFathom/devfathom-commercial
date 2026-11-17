'use client';

import { browserUuid } from '@/lib/browser-uuid';

import { useState } from 'react';
import Link from 'next/link';

import { Button, buttonVariants } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { packConversions, describePackConversion } from '@/lib/pharmacy/pack-conversion';
import { trpc } from '@/lib/trpc';

const control =
  'min-h-11 w-full min-w-0 rounded-sm border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
const packTypes = ['UNIT', 'STRIP', 'BOX', 'CARTON'] as const;

export function MedicinePackSetup() {
  const [searchText, setSearchText] = useState('');
  const [query, setQuery] = useState('');
  const [medicineId, setMedicineId] = useState('');
  const [presentationId, setPresentationId] = useState('');
  const [level, setLevel] = useState<(typeof packTypes)[number] | ''>('');
  const [units, setUnits] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [message, setMessage] = useState('');
  const [validation, setValidation] = useState('');
  const utils = trpc.useUtils();
  const search = trpc.pharmacyMedicine.search.useQuery(
    { query, limit: 25 },
    { enabled: Boolean(query), retry: false }
  );
  const medicine = trpc.pharmacyMedicine.get.useQuery(
    { id: medicineId },
    { enabled: Boolean(medicineId), retry: false }
  );
  const presentation = medicine.data?.presentations.find((item) => item.id === presentationId);
  const create = trpc.pharmacyMedicine.createPackLevel.useMutation({
    onSuccess: async (result) => {
      setMessage(
        'status' in result
          ? 'Pack submitted for catalogue approval.'
          : 'Pack created. Return to Pharmacy setup to continue with opening stock.'
      );
      setLevel('');
      setUnits('');
      await utils.pharmacyMedicine.get.invalidate({ id: medicineId });
    },
  });
  const error = create.error ?? medicine.error ?? search.error;
  const denied = error?.data?.code === 'FORBIDDEN' || error?.data?.code === 'UNAUTHORIZED';
  const busy = create.isPending;
  const conversions = presentation ? packConversions(presentation.packLevels) : [];

  return (
    <SectionCard title="Packs for receiving" titleLevel={2}>
      <p className="mb-4 text-sm text-text-muted">
        Publishing a medicine creates its default pack from the reviewed pack size. Find the
        medicine to check that pack, attach the barcode printed on it, or add another pack you
        receive differently. Use the quantity printed on the pack; each pack here is counted
        directly in individual units. Opening stock is imported by matching a pack barcode or pack
        ID.
      </p>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (query === searchText.trim()) void search.refetch();
          else setQuery(searchText.trim());
          setMedicineId('');
          setPresentationId('');
          setMessage('');
          create.reset();
        }}
      >
        <label className="min-w-0 flex-1 space-y-2 text-sm text-text-body">
          <span>Medicine name</span>
          <input
            className={control}
            required
            maxLength={200}
            value={searchText}
            disabled={busy}
            onChange={(event) => setSearchText(event.target.value)}
          />
        </label>
        <Button
          type="submit"
          className="min-h-11"
          variant="outline"
          disabled={busy || search.isFetching || !searchText.trim()}
        >
          Find medicine
        </Button>
      </form>
      {search.isFetching || medicine.isFetching ? (
        <p role="status" className="mt-4 text-sm text-text-muted">
          Loading medicine details…
        </p>
      ) : null}
      {query && search.data?.length === 0 ? (
        <p className="mt-4 text-sm text-text-muted">
          No saleable medicines match. Review and publish the medicine above, then search again.
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="mt-4 text-sm text-destructive">
          {denied
            ? 'Your account cannot complete this step. Ask your workspace administrator to check access. Your entries are preserved.'
            : `Could not complete this step: ${error.message} Your entries are preserved. Correct them or retry.`}
          {!denied && (search.error || medicine.error) ? (
            <Button
              type="button"
              variant="outline"
              className="ml-3 min-h-11"
              onClick={() => void (medicine.error ? medicine.refetch() : search.refetch())}
            >
              Retry loading
            </Button>
          ) : null}
        </div>
      ) : null}
      {search.data && search.data.length > 0 ? (
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const quantity = Number(units);
            const effectiveFrom = new Date(`${effectiveDate}T00:00:00+05:00`);
            if (
              !Number.isSafeInteger(quantity) ||
              quantity <= 0 ||
              (level === 'UNIT' && quantity !== 1)
            ) {
              setValidation(
                'Enter a positive whole number of individual units. A single unit must contain exactly 1.'
              );
              return;
            }
            if (!presentation || !level || !Number.isFinite(effectiveFrom.getTime())) return;
            setValidation('');
            setMessage('');
            create.mutate({
              presentationId: presentation.id,
              level,
              unitsPerParent: quantity,
              effectiveFrom,
              versionGroupId: browserUuid(),
            });
          }}
        >
          <fieldset disabled={busy} className="grid min-w-0 gap-4 md:grid-cols-2">
            <legend className="sr-only">Medicine and pack details</legend>
            <label className="space-y-2 text-sm text-text-body">
              <span>Medicine</span>
              <select
                className={control}
                required
                value={medicineId}
                onChange={(event) => {
                  setMedicineId(event.target.value);
                  setPresentationId('');
                  setMessage('');
                  create.reset();
                }}
              >
                <option value="">Choose a medicine</option>
                {search.data.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.productName}
                    {item.brandName ? ` — ${item.brandName}` : ''}
                    {item.strengths
                      .map((strength) => ` — ${strength.value} ${strength.unit}`)
                      .join('')}
                    {item.manufacturer ? ` — ${item.manufacturer}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-2 text-sm text-text-body">
              <span>Presentation</span>
              <select
                className={control}
                required
                value={presentationId}
                disabled={!medicine.data || medicine.isFetching || Boolean(medicine.error)}
                onChange={(event) => {
                  setPresentationId(event.target.value);
                  setMessage('');
                }}
              >
                <option value="">Choose a presentation</option>
                {medicine.data?.presentations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.dosageForm} — {item.presentation}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-2 text-sm text-text-body">
              <span>Pack type</span>
              <select
                className={control}
                required
                value={level}
                onChange={(event) => {
                  const selected = packTypes.find((item) => item === event.target.value);
                  setLevel(selected ?? '');
                  setValidation('');
                }}
              >
                <option value="">Choose a pack type</option>
                {packTypes.map((item) => (
                  <option key={item} value={item}>
                    {item[0] + item.slice(1).toLowerCase()}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-2 text-sm text-text-body">
              <span>Individual units per pack</span>
              <input
                className={control}
                type="number"
                required
                min={1}
                step={1}
                value={units}
                aria-invalid={Boolean(validation)}
                aria-describedby="pack-units-help"
                onChange={(event) => {
                  setUnits(event.target.value);
                  setValidation('');
                }}
              />
              <span id="pack-units-help" className="block text-sm text-text-muted">
                For example, a strip of 10 tablets contains 10 individual units.
              </span>
            </label>
            <label className="space-y-2 text-sm text-text-body">
              <span>Effective from</span>
              <input
                className={control}
                type="date"
                required
                value={effectiveDate}
                onChange={(event) => setEffectiveDate(event.target.value)}
              />
              <span className="block text-sm text-text-muted">
                Available from this date at midnight Pakistan time. Future packs cannot be received
                yet.
              </span>
            </label>
          </fieldset>
          {medicine.data?.presentations.length === 0 ? (
            <p className="text-sm text-text-muted">
              No presentation is available. Complete reviewed publication above before creating a
              pack.
            </p>
          ) : null}
          {validation ? (
            <p role="alert" className="text-sm text-destructive">
              {validation}
            </p>
          ) : null}
          <Button
            type="submit"
            className="min-h-11"
            disabled={
              busy ||
              !presentation ||
              !level ||
              !units ||
              !effectiveDate ||
              medicine.isFetching ||
              Boolean(medicine.error) ||
              denied
            }
          >
            {busy ? 'Creating pack…' : 'Create pack'}
          </Button>
        </form>
      ) : null}
      {message ? (
        <p role="status" className="mt-4 text-sm text-text-body">
          {message}
        </p>
      ) : null}
      {presentation ? (
        <div className="mt-4 text-sm text-text-body">
          <p className="font-medium">Packs available now</p>
          {conversions.length ? (
            <ul className="mt-2 space-y-3">
              {conversions.map((pack) => (
                <PackBarcodeEditor
                  key={pack.packLevelId}
                  packLevelId={pack.packLevelId}
                  label={describePackConversion(pack)}
                  barcodes={
                    presentation.packLevels
                      .find((level) => level.id === pack.packLevelId)
                      ?.barcodes.map((item) => item.code) ?? []
                  }
                  onSaved={() => utils.pharmacyMedicine.get.invalidate({ id: medicineId })}
                />
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-text-muted">
              No effective packs yet. Create a pack or check its effective date.
            </p>
          )}
        </div>
      ) : null}
      <Link
        className={buttonVariants({ variant: 'outline', className: 'mt-5 min-h-11' })}
        href="/pharmacy"
      >
        Return to Pharmacy setup
      </Link>
    </SectionCard>
  );
}

/**
 * Barcode rows are append-only in the database, so a pack that already carries
 * a code shows it read-only; only a pack without one offers the attach form.
 */
function PackBarcodeEditor({
  packLevelId,
  label,
  barcodes,
  onSaved,
}: {
  packLevelId: string;
  label: string;
  barcodes: readonly string[];
  onSaved: () => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const save = trpc.pharmacyMedicine.setPackBarcode.useMutation({
    onSuccess: async (row) => {
      if ('status' in row) setMessage('Barcode submitted for catalogue approval.');
      else {
        setCode(row.code);
        setMessage(`Barcode ${row.code} saved on this pack.`);
      }
      await onSaved();
    },
  });
  const denied =
    save.error?.data?.code === 'FORBIDDEN' || save.error?.data?.code === 'UNAUTHORIZED';
  const trimmed = code.trim();
  const inputId = `pack-barcode-${packLevelId}`;

  return (
    <li className="space-y-2 rounded-sm border border-border-subtle p-3">
      <p>{label}</p>
      <p className="text-text-muted">
        Pack ID:{' '}
        <code className="break-all font-mono text-xs text-text-body select-all">{packLevelId}</code>
      </p>
      <p className="text-text-muted">
        {barcodes.length
          ? `Barcode${barcodes.length === 1 ? '' : 's'}: ${barcodes.join(', ')}`
          : 'No barcode yet. Opening stock cannot be imported against this pack until one is attached.'}
      </p>
      {barcodes.length ? (
        <p className="text-sm text-text-muted">
          Pack barcodes are permanent once attached and cannot be edited here.
        </p>
      ) : (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!trimmed) return;
            setMessage('');
            save.mutate({ packLevelId, code: trimmed });
          }}
        >
          <label htmlFor={inputId} className="min-w-0 flex-1 space-y-2 text-sm text-text-body">
            <span>Barcode for {label}</span>
            <input
              id={inputId}
              className={control}
              required
              maxLength={200}
              autoComplete="off"
              inputMode="text"
              value={code}
              disabled={save.isPending}
              onChange={(event) => {
                setCode(event.target.value);
                setMessage('');
                save.reset();
              }}
            />
          </label>
          <Button
            type="submit"
            variant="outline"
            className="min-h-11"
            disabled={save.isPending || !trimmed || denied}
          >
            {save.isPending ? 'Saving barcode…' : 'Attach barcode'}
          </Button>
        </form>
      )}
      {save.error ? (
        <p role="alert" className="text-sm text-destructive">
          {denied
            ? 'Your account cannot attach pack barcodes. Ask your workspace administrator to check access.'
            : `Barcode not saved: ${save.error.message}`}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-sm text-text-body">
          {message}
        </p>
      ) : null}
    </li>
  );
}
