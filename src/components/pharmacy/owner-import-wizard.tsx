'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { trpc } from '@/lib/trpc';
import { IMPORT_FIELDS, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, OPENING_TEMPLATE, type ImportMapping } from '@/lib/pharmacy/migration/owner-import-input';
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
  const busy = reading || upload.isPending || dryRun.isPending || commit.isPending;
  const clearPreview = () => { setPreview(null); setConfirmed(false); setError(''); };
  const denied = options.error?.data?.code === 'FORBIDDEN' || options.error?.data?.code === 'UNAUTHORIZED';

  async function chooseFile(file?: File) {
    setSource(null); setSheet(null); setMapping({}); clearPreview();
    if (!file) return;
    if (!/\.(csv|xlsx)$/i.test(file.name) || file.size === 0 || file.size > IMPORT_MAX_BYTES) {
      setError('Choose a CSV or XLSX file that is not empty and is 1 MB or smaller.'); return;
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
    <main className="min-w-0 space-y-6">
      <PageHeader eyebrow="Pharmacy inventory · Owner setup" heading="Import opening stock"
        description="Upload the stock list from your old system, match its columns, and check the counts before saving."
        actions={<Link href="/pharmacy/inventory" className={buttonVariants({ variant: 'secondary' })}>Back to Inventory</Link>} />
      {options.isPending ? <SectionCard title="Loading import access" titleLevel={2}><p role="status">Loading your branches and stock locations…</p></SectionCard> :
        options.error ? <SectionCard title={denied ? 'Owner access required' : 'Could not load import setup'} titleLevel={2}>
          <p role="alert" className="text-sm text-text-muted">{denied ? 'A workspace administrator with Pharmacy Inventory enabled must import opening stock.' : 'Your setup could not be loaded. Try again.'}</p>
          {!denied && <Button variant="secondary" className="mt-4" onClick={() => void options.refetch()}>Retry setup</Button>}
        </SectionCard> : receipt ? <SectionCard title="Opening stock saved" titleLevel={2}>
          <div role="status" className="space-y-3 text-sm text-text-body">
            <StatusPill status="success" label={receipt.replayed ? 'Already saved · receipt recovered' : 'Saved'} />
            <p>{receipt.totalUnits} single units added (e.g. tablets) · Opening stock value {money(receipt.totalValueMinor)}.</p>
            <p className="break-all font-mono text-xs">Session: {receipt.sessionId}</p>
            <p>Your counted quantities are now in inventory. The reason you gave for each count difference was saved with its row. A second-person sign-off for this import is not available on this screen yet.</p>
          </div>
          <Link href="/pharmacy/inventory" className={buttonVariants({ className: 'mt-5' })}>View inventory</Link>
        </SectionCard> : !options.data?.branches.length || !options.data.locations.length ?
          <SectionCard title="Set up a branch and stock location first" titleLevel={2}>
            <p className="text-sm text-text-muted">No active branch or stock location yet. Create a branch in Pharmacy setup and a stock location in Inventory, then come back to import.</p>
            <Link href="/pharmacy" className={buttonVariants({ variant: 'secondary', className: 'mt-4' })}>Pharmacy setup</Link>
          </SectionCard> : <>
          <nav aria-label="Import progress"><ol className="flex flex-wrap gap-3 text-sm text-text-muted">
            {['Upload', 'Match columns', 'Review and save'].map((step, index) => <li key={step} aria-current={index === (preview ? 2 : sheet ? 1 : 0) ? 'step' : undefined} className={index === (preview ? 2 : sheet ? 1 : 0) ? 'font-semibold text-text-strong' : ''}>{index + 1}. {step}</li>)}
          </ol></nav>
          {error && <div role="alert" id="import-error" className="rounded-sm border border-destructive p-4 text-sm text-destructive">{error}</div>}
          <SectionCard title="1. Upload your stock list" titleLevel={2}>
            <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-text-muted">
              <li>Import before you start selling or receiving deliveries.</li>
              <li>Add your medicines and their pack sizes first.</li>
              <li>Enter quantities and costs in single units, e.g. tablets. Enter MRP per pack.</li>
              <li>The file has two quantity columns: what your old system shows, and what you counted on the shelf.</li>
              <li>A long list can be split across several files. Put each medicine, batch and pack in only one file.</li>
            </ul>
            <div className="mb-5 flex flex-wrap gap-3">
              <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(OPENING_TEMPLATE)}`} download="pharmacy-opening-stock.csv" className={buttonVariants({ variant: 'secondary' })}>Download CSV template</a>
              <Link href="/pharmacy/medicines" className={buttonVariants({ variant: 'ghost' })}>Medicine catalogue and packs</Link>
            </div>
            <div className="grid min-w-0 gap-4 md:grid-cols-2">
              <label className="space-y-2 text-sm text-text-body"><span>Branch</span>
                <select className={control} value={branchId} disabled={busy} onChange={(event) => { setBranchId(event.target.value); setStockLocationId(''); clearPreview(); }}>
                  <option value="">Choose branch</option>{options.data.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                </select>
              </label>
              <label className="space-y-2 text-sm text-text-body"><span>Stock location</span>
                <select className={control} value={stockLocationId} disabled={busy || !branchId} onChange={(event) => { setStockLocationId(event.target.value); clearPreview(); }}>
                  <option value="">Choose stock location</option>{options.data.locations.filter((location) => location.branchId === branchId).map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                </select>
              </label>
              <label className="space-y-2 text-sm text-text-body md:col-span-2"><span>CSV or XLSX file</span>
                <Input type="file" accept=".csv,.xlsx" disabled={busy} className="min-h-11" aria-describedby="upload-help" aria-invalid={Boolean(error && !sheet)} onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.currentTarget.value = '';
                  void chooseFile(file);
                }} />
              </label>
            </div>
            <p id="upload-help" className="mt-3 text-sm text-text-muted">Up to 1 MB, {IMPORT_MAX_ROWS} stock rows and 40 columns. Excel (XLSX): use one sheet with plain values, and format barcodes as text so leading zeros are kept. CSV: save as UTF-8 with commas.</p>
            {busy && <p role="status" className="mt-3 text-sm text-text-muted">{commit.isPending ? 'Saving opening stock…' : dryRun.isPending ? 'Preparing your preview…' : 'Reading and checking your file…'}</p>}
          </SectionCard>
          {sheet && source && <SectionCard title="2. Match your columns" titleLevel={2}>
            <p className="mb-5 break-words text-sm text-text-muted">{source.fileName} · {sheet.rowCount} stock rows. Check each suggested match. Columns you leave unmatched are ignored.</p>
            <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {IMPORT_FIELDS.map(([field, label, required]) => <label key={field} className="min-w-0 space-y-2 text-sm text-text-body"><span id={`import-label-${field}`}>{label}{required ? ' *' : ' (optional)'}</span>
                <select aria-labelledby={`import-label-${field}`} className={control} value={mapping[field] ?? ''} disabled={busy} onChange={(event) => { setMapping({ ...mapping, [field]: event.target.value === '' ? undefined : Number(event.target.value) }); clearPreview(); }}>
                  <option value="">Choose column</option>{sheet.headers.map((header, index) => <option value={index} key={index}>{header}</option>)}
                </select>
                {mapping[field] !== undefined && <span className="block break-words text-xs text-text-muted">Sample: {sheet.sample[0]?.[mapping[field]!] || '(empty)'}</span>}
              </label>)}
            </div>
            <p className="mt-4 text-sm text-text-muted">* Required. Use plain numbers with no currency symbol or commas. PKR amounts can have up to two decimal places. Quantities must be whole numbers; write 0 rather than leaving a cell blank. Give a reason wherever your count differs from your old system.</p>
            <Button className="mt-5 min-h-11" disabled={busy || !branchId || !stockLocationId || IMPORT_FIELDS.some(([field, , required]) => required && mapping[field] === undefined)} onClick={async () => {
              clearPreview();
              try { setPreview(await dryRun.mutateAsync({ ...source, branchId, stockLocationId, mapping })); }
              catch (failure) { setError(failure instanceof Error ? failure.message : 'The preview could not be prepared. Your stock has not changed.'); }
            }}>Preview changes</Button>
          </SectionCard>}
          {preview && source && <SectionCard title="3. Review and save" titleLevel={2}>
            <div role="status" className="mb-4 space-y-2 text-sm text-text-body">
              <StatusPill status={preview.canCommit ? 'success' : 'blocked'} label={preview.canCommit ? 'Ready to save' : 'Fix errors before saving'} />
              <p>{preview.lines.length} rows · {preview.totalUnits} counted single units · {money(preview.totalValueMinor)} opening stock value.</p>
              <p>Nothing has been saved yet. Each valid row adds the quantity you counted as a new batch. Your old system’s quantity is shown only for comparison. A batch that was already imported cannot be imported again.</p>
            </div>
            {preview.blockers.length > 0 && <ul className="mb-4 list-disc space-y-2 pl-5 text-sm text-destructive">{preview.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
            <Table><caption className="sr-only">Opening stock rows, count differences, and errors to fix</caption>
              <TableHeader><TableRow>
                <TableHead>Row / source</TableHead><TableHead>Medicine / pack / batch</TableHead><TableHead>Expiry</TableHead><TableHead numeric>In stock now</TableHead><TableHead numeric>Old system</TableHead><TableHead numeric>Counted / added</TableHead><TableHead numeric>New total</TableHead><TableHead numeric>Difference</TableHead><TableHead>Check</TableHead>
              </TableRow></TableHeader>
              <TableBody>{preview.lines.map((line) => <TableRow key={line.rowNumber}>
                <TableCell className="max-w-48 whitespace-normal break-words">{line.rowNumber} · {line.sourceRef || 'Missing reference'}</TableCell>
                <TableCell className="min-w-48 max-w-72 whitespace-normal break-words">{line.medicineName || 'Unmatched medicine'}<br />{line.packReference} · {line.batchNumber}<br />{line.unitsPerPack === null ? 'Unknown conversion' : `${line.unitsPerPack} single units per pack`}</TableCell>
                <TableCell>{line.expiryDate ? new Date(line.expiryDate).toISOString().slice(0, line.expiryPrecision === 'MONTH' ? 7 : 10) : 'Missing'}</TableCell>
                <TableCell numeric>{line.currentUnits}</TableCell><TableCell numeric>{line.expectedUnits ?? 'Invalid'}</TableCell><TableCell numeric>{line.countedUnits ?? 'Invalid'}</TableCell><TableCell numeric>{line.proposedUnits ?? 'Unknown'}</TableCell><TableCell numeric>{line.varianceUnits ?? 'Unknown'}</TableCell>
                <TableCell className="min-w-64 max-w-96 whitespace-normal">
                  {line.errors.length ? <ul className="list-disc space-y-1 pl-4 text-destructive">{line.errors.map((message) => <li key={message}>{message}</li>)}</ul> : <><StatusPill status="success" label="Ready" /><p className="mt-2 text-xs">MRP {money(String(line.printedMrpMinor))} per pack · Cost {money(String(line.unitCostMinor))} per single unit</p></>}
                  {line.varianceNote && <p className="mt-2 break-words text-xs text-text-muted">Reason for difference: {line.varianceNote}</p>}
                </TableCell>
              </TableRow>)}</TableBody>
            </Table>
            <label className="mt-5 flex min-h-11 items-start gap-3 text-sm text-text-body">
              <input type="checkbox" className="mt-1 size-5 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-ring" checked={confirmed} disabled={busy || !preview.canCommit} onChange={(event) => setConfirmed(event.target.checked)} />
              <span>I checked the counted quantities, unit costs, pack MRPs, units per pack, batches, expiry dates and stock location. Save all rows as opening stock with their value.</span>
            </label>
            <Button className="mt-4 min-h-11" disabled={busy || !preview.canCommit || !confirmed} onClick={async () => {
              setError('');
              try { setReceipt(await commit.mutateAsync({ ...source, branchId, stockLocationId, mapping, previewHash: preview.previewHash, confirmed: true })); }
              catch (failure) { setError(failure instanceof Error ? failure.message : 'Saving failed. Try again; your stock will not be added twice.'); }
            }}>{commit.isPending ? 'Saving opening stock…' : 'Save opening stock'}</Button>
            <p className="mt-3 text-sm text-text-muted">The whole file is saved once. If you try again, nothing is added twice. Every count difference needs a reason. This import does not ask a second person to sign off.</p>
          </SectionCard>}
        </>}
    </main>
  );
}
