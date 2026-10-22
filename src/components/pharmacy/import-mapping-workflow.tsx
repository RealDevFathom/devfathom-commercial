'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, Check, RotateCcw, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  IMPORT_TARGET_FIELDS,
  autoMapImportHeaders,
  missingRequiredFields,
  type ImportTargetField,
} from '@/lib/pharmacy/migration/header-synonyms';
import { parseDelimitedText } from '@/lib/pharmacy/migration/source-values';

export type MappingColumn = { name: string; samples: readonly string[] };
export type ImportPreview = {
  errors: number;
  dedupeMatches: number;
  entities: readonly { key: string; count: number }[];
};

export function ImportMappingWorkflow({
  columns = [],
  preview,
  onSavePreset,
}: {
  columns?: readonly MappingColumn[];
  preview?: ImportPreview;
  onSavePreset?: (name: string, mapping: Record<string, ImportTargetField>) => void;
}) {
  const [uploadedColumns, setUploadedColumns] = useState<readonly MappingColumn[]>([]);
  const activeColumns = uploadedColumns.length ? uploadedColumns : columns;
  const initial = useMemo(
    () => autoMapImportHeaders(columns.map((column) => column.name)),
    [columns]
  );
  const [mapping, setMapping] = useState<Record<string, ImportTargetField>>(initial);
  const [presetName, setPresetName] = useState('');
  const [progress, setProgress] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const missing = missingRequiredFields(mapping);

  return (
    <div className="space-y-6">
      <SectionCard title="1. Upload source" titleLevel={2}>
        <label className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-dashed border-border-strong bg-surface-sunken p-6 text-sm text-text-body focus-within:ring-2 focus-within:ring-ring">
          <Upload aria-hidden="true" className="size-5" />
          <span>Choose a UTF-8 CSV or TSV file (up to 20 MB)</span>
          <input
            className="sr-only"
            type="file"
            accept=".csv,.tsv"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file || !/\.(csv|tsv)$/i.test(file.name)) return;
              const table = parseDelimitedText(await file.text());
              const next = table.headers.map((name, index) => ({
                name,
                samples: table.rows
                  .slice(0, 3)
                  .map((row) => row[index] ?? '')
                  .filter(Boolean),
              }));
              setUploadedColumns(next);
              setMapping(autoMapImportHeaders(next.map((column) => column.name)));
            }}
          />
        </label>
      </SectionCard>
      <SectionCard title="2. Map columns" titleLevel={2}>
        {activeColumns.length === 0 ? (
          <p className="text-sm text-text-muted">
            Upload a file to inspect its columns and sample values.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="font-mono text-xs uppercase text-text-muted">
                <tr>
                  <th className="p-3">Source column</th>
                  <th className="p-3">Target field</th>
                  <th className="p-3">Sample values</th>
                </tr>
              </thead>
              <tbody>
                {activeColumns.map((column) => (
                  <tr className="border-t border-border-subtle" key={column.name}>
                    <td className="p-3 font-medium">{column.name}</td>
                    <td className="p-3">
                      <select
                        aria-label={`Target for ${column.name}`}
                        className="min-h-11 rounded-[var(--radius-sm)] border border-border-default bg-surface-card px-3"
                        value={mapping[column.name] ?? ''}
                        onChange={(event) =>
                          setMapping((current) =>
                            event.target.value
                              ? {
                                  ...current,
                                  [column.name]: event.target.value as ImportTargetField,
                                }
                              : (Object.fromEntries(
                                  Object.entries(current).filter(([key]) => key !== column.name)
                                ) as Record<string, ImportTargetField>)
                          )
                        }
                      >
                        <option value="">Do not import</option>
                        {IMPORT_TARGET_FIELDS.map((field) => (
                          <option key={field} value={field}>
                            {field.replaceAll('_', ' ')}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-3 text-text-muted">
                      {column.samples.slice(0, 3).join(' · ') || 'No values'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p
          role="status"
          className={`mt-4 flex items-center gap-2 text-sm ${missing.length ? 'text-destructive' : 'text-success'}`}
        >
          {missing.length ? <AlertTriangle className="size-4" /> : <Check className="size-4" />}
          {missing.length
            ? `Required mapping missing: ${missing.join(', ')}`
            : 'All required fields are mapped.'}
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Input
            aria-label="Preset name"
            placeholder="Preset name"
            value={presetName}
            onChange={(event) => setPresetName(event.target.value)}
            className="max-w-xs"
          />
          <Button
            variant="secondary"
            disabled={!presetName.trim() || missing.length > 0}
            onClick={() => onSavePreset?.(presetName.trim(), mapping)}
          >
            Save mapping preset
          </Button>
        </div>
      </SectionCard>
      <SectionCard title="3. Preview and commit" titleLevel={2}>
        {!preview ? (
          <p className="text-sm text-text-muted">
            Complete the mapping to generate a row-level preview.
          </p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <StatusPill
                status={preview.errors ? 'error' : 'success'}
                tone={preview.errors ? 'danger' : 'success'}
                label={`${preview.errors} errors`}
              />
              <StatusPill
                status={preview.dedupeMatches ? 'warning' : 'success'}
                label={`${preview.dedupeMatches} dedupe matches`}
              />
              <p className="text-sm text-text-body">
                {preview.entities.reduce((sum, entity) => sum + entity.count, 0)} total entities
              </p>
            </div>
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">
              {preview.entities.map((entity) => (
                <li
                  className="rounded-[var(--radius-xs)] bg-surface-sunken p-3 text-sm"
                  key={entity.key}
                >
                  {entity.key}: <strong>{entity.count}</strong>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="mt-5">
          <Progress value={progress}>
            <ProgressLabel>Background commit progress</ProgressLabel>
            <ProgressValue>{progress}%</ProgressValue>
          </Progress>
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button
            disabled={!preview || preview.errors > 0 || progress > 0}
            onClick={() => setProgress(1)}
          >
            Commit in background
          </Button>
          <Button variant="destructive" onClick={() => setConfirming(true)}>
            <RotateCcw /> Roll back import
          </Button>
        </div>
        {confirming ? (
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="rollback-title"
            className="mt-4 rounded-[var(--radius-sm)] border border-destructive bg-destructive/10 p-4"
          >
            <h3 id="rollback-title" className="font-medium">
              Roll back this import?
            </h3>
            <p className="mt-1 text-sm text-text-muted">
              Only entities in this import manifest are reversed. Existing pharmacy data is never
              removed.
            </p>
            <div className="mt-3 flex gap-2">
              <Button variant="destructive" onClick={() => setConfirming(false)}>
                Confirm rollback
              </Button>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}
