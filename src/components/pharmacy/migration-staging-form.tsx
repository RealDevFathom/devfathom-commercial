'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { IMPORT_MAX_ROWS } from '@/lib/pharmacy/migration/owner-import-input';
import {
  STAGING_FIELDS,
  STAGING_MAX_BYTES,
  type StagingInput,
} from '@/lib/pharmacy/migration/staging-input';
import type { ColumnMap, QuantityUnit } from '@/lib/pharmacy/migration/profiler';
import { readStagingUpload, stageMigrationBatch } from './migration-staging-actions';

const control =
  'mt-1 min-h-11 w-full min-w-0 rounded-sm border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function MigrationStagingForm({ branchId, route }: { branchId: string; route: string }) {
  const router = useRouter();
  const [source, setSource] = useState<{ fileName: string; content: string } | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<ColumnMap>({});
  const [quantityUnit, setQuantityUnit] = useState<QuantityUnit | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function chooseFile(file?: File) {
    setSource(null);
    setHeaders([]);
    setMapping({});
    setQuantityUnit('');
    setError('');
    setMessage('');
    if (!file) return;
    if (!file.size || file.size > STAGING_MAX_BYTES) {
      setError('Choose a nonempty file up to 512 KiB.');
      return;
    }
    setBusy(true);
    try {
      let binary = '';
      for (const byte of new Uint8Array(await file.arrayBuffer()))
        binary += String.fromCharCode(byte);
      const next = { fileName: file.name, content: btoa(binary) };
      const result = await readStagingUpload({ ...next, branchId });
      if (!result.data) {
        setError(result.error);
        return;
      }
      setSource(next);
      setHeaders(result.data.headers);
      setMapping(result.data.mapping);
      setMessage(
        `${result.data.rowCount} ${result.data.rowCount === 1 ? 'row' : 'rows'} ready for column mapping.`
      );
    } catch {
      setError('The file could not be read. Choose it again.');
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
        `${result.data.rowCount} rows staged for review with ${result.data.exceptionCount} exceptions. No stock was posted.`
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
        Upload CSV or XLSX with up to {IMPORT_MAX_ROWS} rows. Choose what the quantity column
        counts. Staging creates unverified evidence, not sellable stock.
      </p>
      <fieldset disabled={busy || !branchId} className="mt-4 min-w-0 space-y-4">
        <label className="block text-sm">
          Source file
          <Input
            type="file"
            accept=".csv,.xlsx"
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
