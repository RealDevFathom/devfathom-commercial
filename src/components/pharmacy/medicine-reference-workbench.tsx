'use client';

import { browserUuid } from '@/lib/browser-uuid';

import { useState } from 'react';
import { Download, FileSpreadsheet, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { MedicinePackSetup } from './medicine-pack-setup';

import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  formulaSafeCell,
  ManualFileConnector,
  MEDICINE_REFERENCE_FIELDS,
  type ManualMappingTemplate,
  type NormalizedMedicineReferenceRow,
} from '@/lib/pharmacy/reference-connectors';
import { trpc } from '@/lib/trpc';

type ConnectorHealth = {
  id: string;
  label: string;
  enabled: boolean;
  status: 'READY' | 'DISABLED';
  detail: string;
};

type ParsedFile = { name: string; headers: string[]; rows: Array<Record<string, unknown>> };

function parseCsv(text: string): { headers: string[]; rows: Array<Record<string, unknown>> } {
  const matrix: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => value.length)) matrix.push(row);
      row = [];
      cell = '';
    } else cell += character;
  }
  row.push(cell);
  if (row.some((value) => value.length)) matrix.push(row);
  const headers = (matrix.shift() ?? []).map((value) => value.trim());
  return {
    headers,
    rows: matrix.map((values) =>
      Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
    ),
  };
}

function excelValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'result' in value) {
    return (value as { result?: unknown }).result ?? '';
  }
  return value;
}

async function parseFile(file: File): Promise<ParsedFile> {
  if (file.size > 5 * 1024 * 1024) throw new Error('Reference files are limited to 5 MB.');
  if (file.name.toLowerCase().endsWith('.csv')) {
    const parsed = parseCsv(await file.text());
    if (parsed.rows.length > 500) throw new Error('A reference batch is limited to 500 rows.');
    return { name: file.name, ...parsed };
  }
  if (!file.name.toLowerCase().endsWith('.xlsx')) {
    throw new Error('Choose a CSV or Excel .xlsx file. Legacy .xls files are not accepted.');
  }
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await file.arrayBuffer()) as never);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error('The workbook has no worksheet.');
  if (worksheet.actualRowCount > 501) throw new Error('A reference batch is limited to 500 rows.');
  const matrix: unknown[][] = [];
  worksheet.eachRow({ includeEmpty: false }, (source) => {
    const values = Array.isArray(source.values) ? source.values.slice(1).map(excelValue) : [];
    matrix.push(values);
  });
  const headers = (matrix.shift() ?? []).map((value) => String(value ?? '').trim());
  return {
    name: file.name,
    headers,
    rows: matrix.map((values) =>
      Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
    ),
  };
}

function guessedMapping(headers: string[]): ManualMappingTemplate {
  const aliases: Record<string, string[]> = {
    productName: ['productname', 'product', 'medicine', 'name'],
    brandName: ['brandname', 'brand'],
    manufacturer: ['manufacturer', 'mah'],
    drapRegistrationNumber: ['drapregistrationnumber', 'drapregistration', 'registration'],
    strength: ['strength'],
    dosageForm: ['dosageform', 'form'],
    pack: ['pack', 'packsize', 'presentation'],
    barcode: ['barcode', 'gtin'],
    alias: ['alias', 'genericname', 'generic'],
    rx: ['rx', 'prescriptiononly'],
    restricted: ['restricted'],
    controlled: ['controlled'],
    rowSourceKey: ['rowsourcekey', 'sourcekey', 'id', 'code'],
    targetMedicineId: ['targetmedicineid', 'medicineid'],
  };
  const normalized = headers.map((header) => header.toLowerCase().replace(/[^a-z0-9]/g, ''));
  return Object.fromEntries(
    Object.entries(aliases).flatMap(([field, candidates]) => {
      const index = normalized.findIndex((header) => candidates.includes(header));
      return index < 0 ? [] : [[field, headers[index]!]];
    })
  );
}

function downloadTemplate() {
  const headers = [...MEDICINE_REFERENCE_FIELDS, 'rowSourceKey', 'targetMedicineId'];
  const example = [
    'Paracetamol',
    'Panadol',
    'GSK',
    '01234',
    '500 mg',
    'Tablet',
    '10 x 10',
    '0896000000000',
    'Acetaminophen',
    'false',
    'false',
    'false',
    'catalog-001',
    '',
  ];
  const csv = [headers, example]
    .map((row) => row.map((value) => `"${formulaSafeCell(value).replaceAll('"', '""')}"`).join(','))
    .join('\r\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = 'medicine-reference-mapping-template.csv';
  link.click();
  URL.revokeObjectURL(link.href);
}

function assertionEnvelope(assertedValue: unknown) {
  if (!assertedValue || typeof assertedValue !== 'object' || Array.isArray(assertedValue))
    return null;
  return assertedValue as {
    value?: unknown;
    batchId?: unknown;
    rowSourceKey?: unknown;
    rights?: { acquisition?: unknown };
    blockingIssues?: unknown;
  };
}

function referenceProposalValues(payload: unknown): Record<string, string> {
  if (!payload || typeof payload !== 'object' || !('values' in payload)) return {};
  const values = payload.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) return {};
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

export function MedicineReferenceWorkbench({ health }: { health: ConnectorHealth[] }) {
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [mapping, setMapping] = useState<ManualMappingTemplate>({});
  const [batchId, setBatchId] = useState('');
  const [preview, setPreview] = useState<NormalizedMedicineReferenceRow[]>([]);
  const candidates = trpc.pharmacyMedicine.referenceCandidates.useQuery(undefined, {
    retry: false,
  });
  const proposals = trpc.pharmacyMedicine.referenceConnectorProposals.useQuery(undefined, {
    retry: false,
  });
  const decideProposal = trpc.pharmacyMedicine.decideReferenceConnectorProposal.useMutation({
    onSuccess: async () => {
      toast.success('Reference proposal confirmed. Review its assertions before publication.');
      await Promise.all([proposals.refetch(), candidates.refetch()]);
    },
    onError: (error) => toast.error(error.message),
  });
  const importBatch = trpc.pharmacyMedicine.runReferenceConnectorNow.useMutation({
    onSuccess: async (result) => {
      toast.success(
        result.noOp
          ? `${result.rowsSkipped} rows unchanged; identical input was a no-op.`
          : `${result.proposalRows} rows proposed; ${result.rowsApplied} rows had descriptive fields applied; ${result.rowsRejected} rejected.`
      );
      await Promise.all([proposals.refetch(), candidates.refetch()]);
    },
    onError: (error) => toast.error(error.message),
  });
  const review = trpc.pharmacyMedicine.recordReviewDecision.useMutation({
    onSuccess: async () => {
      toast.success('Review decision recorded.');
      await candidates.refetch();
    },
    onError: (error) => toast.error(error.message),
  });
  const publish = trpc.pharmacyMedicine.publishAssertions.useMutation({
    onSuccess: async () => {
      toast.success('Assertions published in a reversible batch.');
      await candidates.refetch();
    },
    onError: (error) => toast.error(error.message),
  });

  async function chooseFile(file: File | undefined) {
    if (!file) return;
    try {
      const next = await parseFile(file);
      if (!next.headers.length || !next.rows.length) throw new Error('The file has no data rows.');
      setParsed(next);
      setMapping(guessedMapping(next.headers));
      setBatchId(browserUuid());
      setPreview([]);
    } catch (error) {
      setParsed(null);
      toast.error(error instanceof Error ? error.message : 'The file could not be read.');
    }
  }

  async function normalizePreview() {
    if (!parsed) return;
    const connector = new ManualFileConnector();
    const result = await connector.fetch({
      batchId,
      fileName: parsed.name,
      rows: parsed.rows,
      mapping,
    });
    setPreview(result.rows);
  }

  return (
    <div className="space-y-6">
      <section aria-label="Connector health" className="grid gap-3 md:grid-cols-3">
        {health.map((connector) => (
          <SectionCard key={connector.id} title={connector.label} titleLevel={2}>
            <StatusPill
              status={connector.status}
              tone={connector.enabled ? 'success' : 'neutral'}
            />
            <p className="mt-3 text-sm leading-6 text-text-muted">{connector.detail}</p>
          </SectionCard>
        ))}
      </section>

      <SectionCard
        eyebrow="MED-06 / controlled intake"
        title="Upload reference rows"
        titleLevel={2}
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
          <label className="block text-sm font-medium text-text-body">
            CSV or Excel workbook
            <span className="mt-1 flex min-h-11 items-center gap-3 rounded-sm border border-border-default bg-surface-raised px-3 focus-within:ring-2 focus-within:ring-ring">
              <FileSpreadsheet className="size-4 text-text-muted" aria-hidden="true" />
              <input
                className="min-w-0 flex-1 text-sm file:mr-3 file:border-0 file:bg-transparent file:font-semibold"
                type="file"
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(event) => void chooseFile(event.target.files?.[0])}
              />
            </span>
          </label>
          <Button
            className="min-h-11 self-end"
            type="button"
            variant="outline"
            onClick={downloadTemplate}
          >
            <Download data-icon="inline-start" /> Mapping template
          </Button>
        </div>

        {parsed ? (
          <div className="mt-5 space-y-5 border-t border-border-subtle pt-5">
            <label className="block max-w-xl text-sm font-medium text-text-body">
              Batch ID
              <input
                className="mt-1 min-h-11 w-full rounded-sm border border-border-default bg-surface-raised px-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={batchId}
                onChange={(event) => setBatchId(event.target.value)}
                required
              />
            </label>
            <div>
              <h3 className="text-sm font-semibold text-text-strong">Column mapping</h3>
              <p className="mt-1 text-xs text-text-muted">
                Strength, dosage form, and pack have no defaults. Missing values stay blocked in
                review.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                {[
                  ...MEDICINE_REFERENCE_FIELDS,
                  'rowSourceKey' as const,
                  'targetMedicineId' as const,
                ].map((field) => (
                  <label key={field} className="text-xs font-medium text-text-body">
                    {field}
                    <select
                      className="mt-1 min-h-11 w-full rounded-sm border border-border-default bg-surface-raised px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={mapping[field] ?? ''}
                      onChange={(event) =>
                        setMapping((current) => ({
                          ...current,
                          [field]: event.target.value || undefined,
                        }))
                      }
                    >
                      <option value="">Not supplied</option>
                      {parsed.headers.map((header) => (
                        <option key={header} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                className="min-h-11"
                type="button"
                variant="secondary"
                onClick={() => void normalizePreview()}
              >
                Preview normalized rows
              </Button>
              <Button
                className="min-h-11"
                type="button"
                disabled={!preview.length || !batchId.trim() || importBatch.isPending}
                onClick={() =>
                  importBatch.mutate({
                    connectorId: 'manual-file',
                    batchId,
                    fileName: parsed.name,
                    rows: preview,
                  })
                }
              >
                {importBatch.isPending ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" />
                ) : (
                  <Upload data-icon="inline-start" />
                )}
                Run {preview.length || ''} rows now
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-5 rounded-md bg-surface-sunken px-4 py-5 text-sm text-text-muted">
            Choose a file to map its columns. Nothing is imported until you preview and confirm.
          </p>
        )}

        {preview.length ? (
          <div className="mt-5 overflow-x-auto rounded-md border border-border-subtle">
            <table className="w-full min-w-[780px] text-left text-sm">
              <thead className="bg-surface-sunken font-mono text-[10px] uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-3 py-3">Source row</th>
                  <th className="px-3 py-3">Product</th>
                  <th className="px-3 py-3">Strength</th>
                  <th className="px-3 py-3">Form</th>
                  <th className="px-3 py-3">Pack</th>
                  <th className="px-3 py-3">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {preview.map((row) => (
                  <tr key={row.rowSourceKey} className="hover:bg-surface-sunken/60">
                    <td className="px-3 py-3 font-mono text-xs">{row.rowSourceKey}</td>
                    <td className="px-3 py-3">{row.values.productName ?? 'Missing'}</td>
                    <td className="px-3 py-3">{row.values.strength ?? 'Missing'}</td>
                    <td className="px-3 py-3">{row.values.dosageForm ?? 'Missing'}</td>
                    <td className="px-3 py-3">{row.values.pack ?? 'Missing'}</td>
                    <td className="px-3 py-3">
                      <StatusPill
                        status={row.blockingIssues.length ? 'Blocked' : 'Ready'}
                        tone={row.blockingIssues.length ? 'danger' : 'success'}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Connector proposals"
        titleLevel={2}
        role="region"
        aria-label="Connector proposals"
      >
        <p className="mb-4 text-sm text-text-muted">
          Confirm the imported reference values to create a reviewable draft. Confirmation does not
          make a medicine saleable.
        </p>
        {proposals.isPending ? (
          <p role="status" className="text-sm text-text-muted">
            Loading reference proposals…
          </p>
        ) : null}
        {proposals.error ? (
          <div role="alert" className="space-y-3 text-sm text-destructive">
            <p>{proposals.error.message}</p>
            <Button variant="outline" onClick={() => void proposals.refetch()}>
              Retry proposals
            </Button>
          </div>
        ) : null}
        {!proposals.error && proposals.data?.length === 0 ? (
          <p className="text-sm text-text-muted">No reference proposals await confirmation.</p>
        ) : null}
        {decideProposal.error ? (
          <p role="alert" className="mb-3 text-sm text-destructive">
            {decideProposal.error.message}
          </p>
        ) : null}
        <div className="space-y-4">
          {proposals.data?.map((proposal) => {
            const values = referenceProposalValues(proposal.payload);
            const name =
              values.productName ?? proposal.targetMedicine?.productName ?? 'Reference update';
            return (
              <article
                key={proposal.id}
                className="min-w-0 space-y-4 rounded-md border border-border-subtle p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <h3 className="font-semibold text-text-strong">{name}</h3>
                  <StatusPill status="Pending confirmation" tone="warning" />
                </div>
                <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
                  {Object.entries(values).map(([field, value]) => (
                    <div key={field} className="min-w-0 rounded-sm bg-surface-sunken p-3">
                      <dt className="font-mono text-xs uppercase text-text-muted">
                        {field.replace(/([a-z])([A-Z])/g, '$1 $2')}
                      </dt>
                      <dd className="mt-1 break-words text-sm text-text-body">{value}</dd>
                    </div>
                  ))}
                </dl>
                <Button
                  className="min-h-11"
                  disabled={decideProposal.isPending}
                  onClick={() =>
                    decideProposal.mutate({ proposalId: proposal.id, decision: 'CONFIRM' })
                  }
                >
                  {decideProposal.isPending ? 'Confirming…' : 'Confirm reference proposal'}
                </Button>
              </article>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard
        eyebrow="MED-03 / MED-04 / MED-05"
        title="Reference review workbench"
        titleLevel={2}
      >
        {candidates.isPending ? (
          <p className="flex items-center gap-2 text-sm text-text-muted">
            <Loader2 className="size-4 animate-spin" /> Loading review candidates…
          </p>
        ) : null}
        {candidates.isError ? (
          <div role="alert" className="rounded-md bg-destructive/10 p-4 text-sm text-destructive">
            The workbench is unavailable or you do not have catalog administration permission. No
            data was changed.
          </div>
        ) : null}
        {candidates.data?.length === 0 ? (
          <p className="rounded-md bg-surface-sunken p-5 text-sm text-text-muted">
            No confirmed reference rows await publication. Upload a manual batch above; regulated
            changes remain proposals until a pharmacist confirms them.
          </p>
        ) : null}
        <div className="space-y-4">
          {candidates.data?.map((candidate) => {
            const reviewAssertionIds = candidate.provenance
              .filter((item) => item.status === 'UNREVIEWED')
              .map((item) => item.id);
            const publishAssertionIds = candidate.provenance
              .filter((item) => item.status === 'ACCEPTED' || item.status === 'CORRECTED')
              .map((item) => item.id);
            return (
              <article key={candidate.id} className="rounded-md border border-border-subtle p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="font-semibold text-text-strong">{candidate.productName}</h3>
                    <p className="mt-1 text-xs text-text-muted">
                      Non-saleable until reviewed and completed · {candidate.id}
                    </p>
                  </div>
                  <StatusPill status="In review" tone="warning" />
                </div>
                <dl className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                  {candidate.provenance.map((assertion) => {
                    const envelope = assertionEnvelope(assertion.assertedValue);
                    return (
                      <div key={assertion.id} className="rounded-sm bg-surface-sunken p-3">
                        <dt className="font-mono text-[10px] uppercase tracking-wide text-text-muted">
                          {assertion.field}
                        </dt>
                        <dd className="mt-1 text-sm text-text-body">
                          {String(envelope?.value ?? '—')}
                        </dd>
                        <dd className="mt-2 text-[11px] text-text-muted">
                          Batch {String(envelope?.batchId ?? '—')} · row{' '}
                          {String(envelope?.rowSourceKey ?? '—')}
                        </dd>
                        <dd className="mt-1 text-[11px] text-text-muted">
                          Rights: {String(envelope?.rights?.acquisition ?? 'Not recorded')}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
                <div className="mt-4 flex flex-wrap gap-2">
                  {(['ACCEPT', 'REJECT', 'DEFER'] as const).map((action) => (
                    <Button
                      key={action}
                      size="sm"
                      variant={action === 'REJECT' ? 'destructive' : 'outline'}
                      disabled={!reviewAssertionIds.length || review.isPending}
                      onClick={() =>
                        review.mutate({
                          duplicateKey: `reference:${candidate.id}`,
                          action,
                          medicineIds: [candidate.id],
                          payload: { assertionIds: reviewAssertionIds },
                        })
                      }
                    >
                      {action.toLowerCase()}
                    </Button>
                  ))}
                  <Button
                    className="sm:ml-auto"
                    size="sm"
                    disabled={!publishAssertionIds.length || publish.isPending}
                    onClick={() => publish.mutate({ assertionIds: publishAssertionIds })}
                  >
                    Publish assertions
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      </SectionCard>
      <MedicinePackSetup />
    </div>
  );
}
