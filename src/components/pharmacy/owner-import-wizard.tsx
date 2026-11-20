'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { useState } from 'react';
import Link from 'next/link';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { trpc } from '@/lib/trpc';
import { IMPORT_FIELDS, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, OPENING_TEMPLATE, type ImportMapping } from '@/lib/pharmacy/migration/owner-import-input';
import { BATCH_NOT_RECORDED, EXPIRY_NOT_RECORDED } from '@/lib/pharmacy/unrecorded-batch';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Outputs = inferRouterOutputs<AppRouter>['pharmacyOwnerImport'];
const control = 'min-h-11 w-full min-w-0 rounded-sm border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
const money = (minor: string) => {
  const value = BigInt(minor);
  return `PKR ${value / BigInt(100)}.${(value % BigInt(100)).toString().padStart(2, '0')}`;
};

export function OwnerImportWizard() {
  const options = trpc.pharmacyOwnerImport.options.useQuery(undefined, { retry: false });
  const upload = trpc.pharmacyOwnerImport.upload.useMutation();
  const dryRun = trpc.pharmacyOwnerImport.preview.useMutation();
  const commit = trpc.pharmacyOwnerImport.commit.useMutation();
  const [source, setSource] = useState<{ fileName: string; content: string } | null>(null);
  const [sheet, setSheet] = useState<Outputs['upload'] | null>(null);
  const [mapping, setMapping] = useState<ImportMapping>({});
  const [branchId, setBranchId] = useState('');
  const [stockLocationId, setStockLocationId] = useState('');
  const [preview, setPreview] = useState<Outputs['preview'] | null>(null);
  const [receipt, setReceipt] = useState<Outputs['commit'] | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const hasCostWarnings = preview?.lines.some((line) => Boolean(line.warnings?.length)) ?? false;
  const busy = reading || upload.isPending || dryRun.isPending || commit.isPending;
  const clearPreview = () => { setPreview(null); setConfirmed(false); setError(''); };
  const denied = options.error?.data?.code === 'FORBIDDEN' || options.error?.data?.code === 'UNAUTHORIZED';

  async function chooseFile(file?: File) {
    setSource(null); setSheet(null); setMapping({}); clearPreview();
    if (!file) return;
    if (!/\.(csv|xlsx)$/i.test(file.name) || file.size === 0 || file.size > IMPORT_MAX_BYTES) {
      setError('Choose a nonempty CSV or XLSX file up to 1 MiB.'); return;
    }
    setReading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const next = { fileName: file.name, content: btoa(binary) };
      const result = await upload.mutateAsync(next);
      setSource(next); setSheet(result); setMapping(result.mapping);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The upload could not be read. Choose the file again.'); }
    finally { setReading(false); }
  }

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader eyebrow="Pharmacy inventory · Owner setup" heading="Import opening stock"
        description="Upload your stock file from the previous system, map its columns, and review the physical opening position before posting."
        actions={<Link href="/pharmacy/inventory" className={buttonVariants({ variant: 'secondary' })}>Back to Inventory</Link>} />
      {options.isPending ? <SectionCard title="Loading import access" titleLevel={2}><p role="status">Loading your branches and stock locations…</p></SectionCard> :
        options.error ? <SectionCard title={denied ? 'Owner access required' : 'Could not load import setup'} titleLevel={2}>
          <p role="alert" className="text-sm text-text-muted">{denied ? 'A workspace administrator with Pharmacy Inventory enabled must import opening stock.' : 'Your setup could not be loaded. Try again.'}</p>
          {!denied && <Button variant="secondary" className="mt-4" onClick={() => void options.refetch()}>Retry setup</Button>}
        </SectionCard> : receipt ? <SectionCard title="Opening stock committed" titleLevel={2}>
          <div role="status" className="space-y-3 text-sm text-text-body">
            <StatusPill status="success" label={receipt.replayed ? 'Already committed · receipt recovered' : 'Committed'} />
            <p>{receipt.totalUnits} single units posted · Opening valuation {money(receipt.totalValueMinor)}.</p>
            <p className="break-all font-mono text-xs">Session: {receipt.sessionId}</p>
            <p>The counted quantities are now in inventory. Variance explanations were recorded with each row; independent sign-off of this opening session is not yet available in this screen.</p>
          </div>
          <Link href="/pharmacy/inventory" className={buttonVariants({ className: 'mt-5' })}>View inventory</Link>
        </SectionCard> : !options.data?.branches.length || !options.data.locations.length ?
          <SectionCard title="Set up a branch and stock location first" titleLevel={2}>
            <p className="text-sm text-text-muted">Opening stock needs an active branch and an active stock location. Complete these in Pharmacy setup and Inventory, then return here.</p>
            <Link href="/pharmacy" className={buttonVariants({ variant: 'secondary', className: 'mt-4' })}>Pharmacy setup</Link>
          </SectionCard> : <>
          <nav aria-label="Import progress"><ol className="flex flex-wrap gap-3 text-sm text-text-muted">
            {['Upload', 'Map columns', 'Review and commit'].map((step, index) => <li key={step} aria-current={index === (preview ? 2 : sheet ? 1 : 0) ? 'step' : undefined} className={index === (preview ? 2 : sheet ? 1 : 0) ? 'font-semibold text-text-strong' : ''}>{index + 1}. {step}</li>)}
          </ol></nav>
          {error && <div role="alert" id="import-error" className="space-y-3 rounded-sm border border-destructive p-4 text-sm text-destructive">
            <p>{error}</p>
            <p className="text-text-body">{preview
              ? 'If the connection failed, retry Commit opening stock with the same reviewed file to recover its receipt safely. If validation refused the commit, run the dry-run diff again and review the rows.'
              : sheet
                ? 'No inventory has changed. Review the column mapping or choose a corrected file, then run the dry-run diff again.'
                : 'No inventory has changed. Check the file format against the CSV template, then choose the corrected file.'}</p>
            {!preview && <ImportCorrectionLinks hasMapping={Boolean(sheet)} />}
          </div>}
          <SectionCard id="import-upload" tabIndex={-1} title="1. Upload the opening count" titleLevel={2}>
            <p className="mb-4 text-sm text-text-muted">Complete opening imports before sales or receiving begin. Publish your medicines and configure their packs first. Counts and costs use single units (tablets, capsules, ml); printed MRP is per selected pack. Physical counts are entered separately from the old system’s quantities. Large stock files may use several files with distinct medicine/batch/pack rows.</p>
            <div className="mb-5 flex flex-wrap gap-3">
              <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(OPENING_TEMPLATE)}`} download="pharmacy-opening-stock.csv" className={buttonVariants({ variant: 'secondary' })}>Download CSV template</a>
              <Link href="/pharmacy/medicines" className={buttonVariants({ variant: 'ghost' })}>Medicine catalogue and packs</Link>
            </div>
            <div className="grid min-w-0 gap-4 md:grid-cols-2">
              <label className="space-y-2 text-sm text-text-body"><span>Branch</span>
                <StudioSelect className={control} value={branchId} disabled={busy} onChange={(event) => { setBranchId(event.target.value); setStockLocationId(''); clearPreview(); }}>
                  <option value="">Choose branch</option>{options.data.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                </StudioSelect>
              </label>
              <label className="space-y-2 text-sm text-text-body"><span>Stock location</span>
                <StudioSelect className={control} value={stockLocationId} disabled={busy || !branchId} onChange={(event) => { setStockLocationId(event.target.value); clearPreview(); }}>
                  <option value="">Choose stock location</option>{options.data.locations.filter((location) => location.branchId === branchId).map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                </StudioSelect>
              </label>
              <label className="space-y-2 text-sm text-text-body md:col-span-2"><span>CSV or XLSX file</span>
                <Input type="file" accept=".csv,.xlsx" disabled={busy} className="min-h-11" aria-describedby="upload-help" aria-invalid={Boolean(error && !sheet)} onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.currentTarget.value = '';
                  void chooseFile(file);
                }} />
              </label>
            </div>
            <p id="upload-help" className="mt-3 text-sm text-text-muted">Up to 1 MiB, {IMPORT_MAX_ROWS} stock rows and 40 columns. XLSX: one populated worksheet with plain values. Preserve barcode leading zeroes using text cells. CSV: UTF-8, comma separated.</p>
            {busy && <p role="status" className="mt-3 text-sm text-text-muted">{commit.isPending ? 'Posting stock and valuation…' : dryRun.isPending ? 'Checking the dry-run diff…' : 'Reading and checking your upload…'}</p>}
          </SectionCard>
          {sheet && source && <SectionCard id="import-mapping" tabIndex={-1} title="2. Map your columns" titleLevel={2}>
            <p className="mb-5 break-words text-sm text-text-muted">{source.fileName} · {sheet.rowCount} stock rows. Review every suggested mapping. Unmapped extra columns do not affect stock.</p>
            <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {IMPORT_FIELDS.map(([field, label, required]) => <label key={field} className="min-w-0 space-y-2 text-sm text-text-body"><span id={`import-label-${field}`}>{label}{required ? ' *' : ' (optional)'}</span>
                <StudioSelect aria-labelledby={`import-label-${field}`} className={control} value={mapping[field] ?? ''} disabled={busy} onChange={(event) => { setMapping({ ...mapping, [field]: event.target.value === '' ? undefined : Number(event.target.value) }); clearPreview(); }}>
                  <option value="">Choose column</option>{sheet.headers.map((header, index) => <option value={index} key={index}>{header}</option>)}
                </StudioSelect>
                {mapping[field] !== undefined && <span className="block break-words text-xs text-text-muted">Sample: {sheet.sample[0]?.[mapping[field]!] || '(empty)'}</span>}
              </label>)}
            </div>
            <p className="mt-4 text-sm text-text-muted">* Required. Use plain numbers without currency symbols or thousands separators. PKR amounts allow up to two decimal places. Exported and counted units must be whole numbers, including an explicit 0. Explain every count difference.</p>
            <Button className="mt-5 min-h-11" disabled={busy || !branchId || !stockLocationId || IMPORT_FIELDS.some(([field, , required]) => required && mapping[field] === undefined)} onClick={async () => {
              clearPreview();
              try { setPreview(await dryRun.mutateAsync({ ...source, branchId, stockLocationId, mapping })); }
              catch (failure) { setError(failure instanceof Error ? failure.message : 'Dry run failed. Your stock has not changed.'); }
            }}>Run dry-run diff</Button>
          </SectionCard>}
          {preview && source && <SectionCard title="3. Review the opening-stock diff" titleLevel={2}>
            <div role="status" className="mb-4 space-y-2 text-sm text-text-body">
              <StatusPill status={preview.canCommit ? hasCostWarnings ? 'warning' : 'success' : 'blocked'} tone={preview.canCommit && hasCostWarnings ? 'warning' : undefined} label={preview.canCommit ? hasCostWarnings ? 'Review cost warnings' : 'Ready for review' : 'Commit blocked'} />
              <p>{preview.lines.filter((line) => line.errors.length === 0).length} of {preview.lines.length} valid rows · {preview.totalUnits} counted single units · {money(preview.totalValueMinor)} opening valuation.</p>
              <p>No inventory has changed during this dry run. Rejected rows are excluded from these totals. Each valid row adds its physical count as a new opening lot. The export is comparison evidence. Previously imported lots cannot be imported again.</p>
            </div>
            {preview.blockers.length > 0 && <ul className="mb-4 list-disc space-y-2 pl-5 text-sm text-destructive">{preview.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
            {!preview.canCommit && <div className="mb-5 space-y-3 text-sm text-text-body">
              <p>Fix the listed errors in your source file or column mapping, then run the dry-run diff again. For an unmatched pack, check Medicine catalogue and packs above. Nothing can be committed until every blocker is resolved.</p>
              <ImportCorrectionLinks hasMapping />
            </div>}
            <Table><caption className="sr-only">Opening stock rows, count differences, cost warnings and blocking validation errors</caption>
              <TableHeader><TableRow>
                <TableHead>Row / source</TableHead><TableHead>Medicine / pack / batch</TableHead><TableHead>Expiry</TableHead><TableHead numeric>Current</TableHead><TableHead numeric>Exported</TableHead><TableHead numeric>Counted / added</TableHead><TableHead numeric>Proposed total</TableHead><TableHead numeric>Variance</TableHead><TableHead>Validation</TableHead>
              </TableRow></TableHeader>
              <TableBody>{preview.lines.map((line) => <TableRow key={line.rowNumber}>
                <TableCell className="max-w-48 whitespace-normal break-words">{line.rowNumber} · {line.sourceRef || 'Missing reference'}</TableCell>
                <TableCell className="min-w-48 max-w-72 whitespace-normal break-words">{line.medicineName || 'Unmatched medicine'}<br />{line.packReference} · {line.batchNumber || BATCH_NOT_RECORDED}<br />{line.unitsPerPack === null ? 'Unknown conversion' : `${line.unitsPerPack} single units per pack`}</TableCell>
                <TableCell>{line.expiryDate ? new Date(line.expiryDate).toISOString().slice(0, line.expiryPrecision === 'MONTH' ? 7 : 10) : EXPIRY_NOT_RECORDED}</TableCell>
                <TableCell numeric>{line.currentUnits}</TableCell><TableCell numeric>{line.expectedUnits ?? 'Invalid'}</TableCell><TableCell numeric>{line.countedUnits ?? 'Invalid'}</TableCell><TableCell numeric>{line.proposedUnits ?? 'Unknown'}</TableCell><TableCell numeric>{line.varianceUnits ?? 'Unknown'}</TableCell>
                <TableCell className="min-w-64 max-w-96 whitespace-normal">
                  {line.errors.length ? <ul className="list-disc space-y-1 pl-4 text-destructive">{line.errors.map((message) => <li key={message}>{message}</li>)}</ul> : <><StatusPill status={line.warnings?.length ? "warning" : "success"} tone={line.warnings?.length ? "warning" : undefined} label={line.warnings?.length ? "Review cost basis" : "Ready"} /><p className="mt-2 text-xs">MRP {money(String(line.printedMrpMinor))} per pack · Cost {money(String(line.unitCostMinor))} per tablet/unit</p></>}
                  {Boolean(line.warnings?.length) && <ul className="mt-2 list-disc space-y-1 pl-4 text-warning">{line.warnings.map((message) => <li key={message}>{message}</li>)}</ul>}
                  {line.varianceNote && <p className="mt-2 break-words text-xs text-text-muted">Variance note: {line.varianceNote}</p>}
                </TableCell>
              </TableRow>)}</TableBody>
            </Table>
            <label className="mt-5 flex min-h-11 items-start gap-3 text-sm text-text-body">
              <input type="checkbox" className="mt-1 size-5 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-ring" checked={confirmed} disabled={busy || !preview.canCommit} onChange={(event) => setConfirmed(event.target.checked)} />
              <span>I verified the physical counts, unit costs, printed pack MRPs, pack conversions, batches, expiry dates and destination, and reviewed every cost warning. Commit all rows as opening stock and record their valuation.</span>
            </label>
            <Button className="mt-4 min-h-11" disabled={busy || !preview.canCommit || !confirmed} onClick={async () => {
              setError('');
              try { setReceipt(await commit.mutateAsync({ ...source, branchId, stockLocationId, mapping, previewHash: preview.previewHash, confirmed: true })); }
              catch (failure) { setError(failure instanceof Error ? failure.message : 'Commit failed. Retry to recover its receipt safely.'); }
            }}>{commit.isPending ? 'Committing opening stock…' : 'Commit opening stock'}</Button>
            <p className="mt-3 text-sm text-text-muted">This posts the entire reviewed file once. A retry recovers the same receipt. Every count difference must carry a variance explanation; independent sign-off is not performed by this import.</p>
          </SectionCard>}
        </>}
    </div>
  );
}

function ImportCorrectionLinks({ hasMapping }: { hasMapping: boolean }) {
  return <div className="flex flex-wrap gap-3">
    {hasMapping && <a href="#import-mapping" className={buttonVariants({ variant: 'secondary', size: 'touch' })}>Review column mapping</a>}
    <a href="#import-upload" className={buttonVariants({ variant: 'secondary', size: 'touch' })}>Choose a corrected file</a>
  </div>;
}
