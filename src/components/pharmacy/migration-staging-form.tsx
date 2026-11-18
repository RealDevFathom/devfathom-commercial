'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import {
  STAGING_FIELDS,
  STAGING_MAX_FILE_BYTES,
  STAGING_MAX_ROWS,
  type StagingInput,
} from '@/lib/pharmacy/migration/staging-input';
import type { ColumnMap, QuantityUnit } from '@/lib/pharmacy/migration/profiler';
import { readStagingUpload, stageMigrationBatch } from './migration-staging-actions';
import { encodeStagingFile, type EncodedStagingFile } from './staging-file-encoding';

const MAX_FILE_LABEL = `${STAGING_MAX_FILE_BYTES / (1024 * 1024)} MiB`;
const count = (value: number) => value.toLocaleString('en-US');

const control =
  'mt-1 min-h-11 w-full min-w-0 rounded-sm border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function MigrationStagingForm({ branchId, route }: { branchId: string; route: string }) {
  const router = useRouter();
  const [source, setSource] = useState<({ fileName: string } & EncodedStagingFile) | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<ColumnMap>({});
  const [quantityUnit, setQuantityUnit] = useState<QuantityUnit | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  // Clearing the native value lets the same file be chosen again after a failure.
  const resetFileInput = () => {
    if (fileInput.current) fileInput.current.value = '';
  };

  async function chooseFile(file?: File) {
    setSource(null);
    setHeaders([]);
    setMapping({});
    setQuantityUnit('');
    setError('');
    setMessage('');
    if (!file) return;
    if (!file.size || file.size > STAGING_MAX_FILE_BYTES) {
      setError(`Choose a nonempty file up to ${MAX_FILE_LABEL}.`);
      resetFileInput();
      return;
    }
    setBusy(true);
    try {
      const encoded = await encodeStagingFile(new Uint8Array(await file.arrayBuffer()));
      if (!encoded) {
        setError('This file is too large to send. Export it as CSV, or split it into two files.');
        resetFileInput();
        return;
      }
      const next = { fileName: file.name, ...encoded };
      const result = await readStagingUpload({ ...next, branchId });
      if (!result.data) {
        setError(result.error);
        resetFileInput();
        return;
      }
      setSource(next);
      setHeaders(result.data.headers);
      setMapping(result.data.mapping);
      setMessage(
        `${count(result.data.rowCount)} ${result.data.rowCount === 1 ? 'row' : 'rows'} ready for column mapping.`
      );
    } catch {
      setError('The file could not be read. Choose it again.');
      resetFileInput();
    } finally {
      setBusy(false);
    }
  }

  async function stage() {
    if (!source || !quantityUnit || mapping.product === undefined || mapping.quantity === undefined)
      return;
    setBusy(true);
    setError('');
    try {
      const result = await stageMigrationBatch({
        ...source,
        branchId,
        quantityUnit,
        mapping: mapping as StagingInput['mapping'],
      });
      if (!result.data) {
        setError(result.error);
        return;
      }
      setSource(null);
      setHeaders([]);
      setMessage(
        (result.data.replayed
          ? `This file was already staged with the same columns: ${count(result.data.rowCount)} rows. No duplicate batch was created. `
          : `${count(result.data.rowCount)} rows staged for review with ${count(result.data.exceptionCount)} exceptions. `) +
          `${result.data.controlledFromClass} set as controlled from legacy class NARCOTICS` +
          ` (${result.data.controlledMedicinesFlagged} catalogue ${result.data.controlledMedicinesFlagged === 1 ? 'medicine' : 'medicines'} flagged). No stock was posted.`
      );
      router.push(
        `${route}?${new URLSearchParams({ branchId, sourceId: result.data.sourceId, batchId: result.data.batchId })}`
      );
      router.refresh();
    } catch {
      setError('The batch could not be staged. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard title="Stage a source file" titleLevel={2}>
      <p className="text-sm text-text-muted">
        Upload a CSV or XLSX product list with up to {count(STAGING_MAX_ROWS)} rows (
        {MAX_FILE_LABEL}), such as a full catalogue export from your previous system. Choose what
        the quantity column counts. Staging creates unverified evidence, not sellable stock, and
        staging the same file again with the same columns reuses its batch.
      </p>
      <fieldset disabled={busy || !branchId} className="mt-4 min-w-0 space-y-4">
        <label className="block text-sm">
          Source file
          <Input
            type="file"
            accept=".csv,.xlsx"
            ref={fileInput}
            className="mt-1 min-h-11"
            onChange={(event) => void chooseFile(event.target.files?.[0])}
          />
        </label>
        {source && (
          <>
            <h3 className="text-sm font-semibold">Column mapping</h3>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {STAGING_FIELDS.map(([field, label]) => (
                <label key={field} className="min-w-0 text-sm">
                  {label}
                  <select
                    className={control}
                    value={mapping[field] ?? ''}
                    onChange={(event) => {
                      setMapping((current) => ({
                        ...current,
                        [field]: event.target.value === '' ? undefined : Number(event.target.value),
                      }));
                      setError('');
                    }}
                  >
                    <option value="">
                      {field === 'product' || field === 'quantity'
                        ? 'Choose a column'
                        : 'Not supplied'}
                    </option>
                    {headers.map((header, index) => (
                      <option key={index} value={index}>
                        {header}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <label className="min-w-0 text-sm">
                Quantity column counts
                <select
                  required
                  aria-describedby="quantity-choice-help"
                  className={control}
                  value={quantityUnit}
                  onChange={(event) => {
                    setQuantityUnit(event.target.value as QuantityUnit | '');
                    setError('');
                  }}
                >
                  <option value="">Choose packs or units</option>
                  <option value="PACKS">Packs</option>
                  <option value="UNITS">Units</option>
                </select>
              </label>
            </div>
            <p id="quantity-choice-help" className="text-sm text-text-muted">
              Packs are multiplied by units per pack: 29 packs of 30 stages 870 units. Without a
              countable pack size, the quantity stays unresolved. Confirm the meaning in your
              export; Marg Batch Stock documents Qty as packs.
            </p>
            <Button
              type="button"
              className="min-h-11"
              disabled={
                !quantityUnit || mapping.product === undefined || mapping.quantity === undefined
              }
              onClick={() => void stage()}
            >
              Stage for review
            </Button>
          </>
        )}
      </fieldset>
      {busy && (
        <p role="status" className="mt-3 text-sm">
          Processing source file…
        </p>
      )}
      {!busy && message && (
        <p role="status" className="mt-3 text-sm">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </SectionCard>
  );
}
