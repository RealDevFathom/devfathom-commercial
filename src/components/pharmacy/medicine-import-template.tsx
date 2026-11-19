'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import {
  MEDICINE_IMPORT_TEMPLATE_COLUMNS,
  MEDICINE_IMPORT_TEMPLATE_NOTE,
  medicineImportTemplateCsv,
  medicineImportTemplateXlsx,
} from '@/lib/pharmacy/migration/import-template';

function save(blob: Blob, fileName: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(link.href);
}

/** DEV-912: the one template for a pharmacy's medicines, with what each column means. */
export function MedicineImportTemplate() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function excel() {
    setBusy(true);
    setError('');
    try {
      const bytes = await medicineImportTemplateXlsx();
      save(
        new Blob([bytes as BlobPart], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
        'medicine-import-template.xlsx'
      );
    } catch {
      setError('The Excel template could not be made. Download the CSV template instead.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard title="Medicine import template" titleLevel={2}>
      <p className="text-sm text-text-muted">
        Fill in one row per medicine, with prices, pack size and opening stock, then upload it
        below. {MEDICINE_IMPORT_TEMPLATE_NOTE}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="touch"
          variant="outline"
          onClick={() =>
            save(
              new Blob([medicineImportTemplateCsv()], { type: 'text/csv;charset=utf-8' }),
              'medicine-import-template.csv'
            )
          }
        >
          Download CSV template
        </Button>
        <Button size="touch" variant="outline" disabled={busy} onClick={excel}>
          {busy ? 'Preparing…' : 'Download Excel template'}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <details className="mt-4 text-sm">
        <summary className="min-h-11 cursor-pointer font-semibold focus-visible:outline-2 focus-visible:outline-ring">
          What each column means
        </summary>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          {MEDICINE_IMPORT_TEMPLATE_COLUMNS.map((column) => (
            <div key={column.header} className="min-w-0">
              <dt className="font-semibold">
                {column.header} {column.required ? '(required)' : '(optional)'}
              </dt>
              <dd className="break-words text-text-muted">{column.meaning}</dd>
            </div>
          ))}
        </dl>
      </details>
    </SectionCard>
  );
}
