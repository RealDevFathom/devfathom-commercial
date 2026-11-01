'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { trpc } from '@/lib/trpc';
import { IMPORT_FIELDS, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, OPENING_TEMPLATE, type ImportMapping } from '@/lib/pharmacy/migration/owner-import-input';
import { Button, buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  IMPORTED_STOCK_ROUTE,
  defaultImportTarget,
  explainImportRow,
} from '@/components/pharmacy/inventory/opening-import';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Outputs = inferRouterOutputs<AppRouter>['pharmacyOwnerImport'];
const control = 'min-h-11 w-full min-w-0 rounded-sm border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
const money = (minor: string) => {
  const value = BigInt(minor);
  return `PKR ${value / BigInt(100)}.${(value % BigInt(100)).toString().padStart(2, '0')}`;
};

const fileInput = 'block w-full min-w-0 rounded-sm border border-border-default bg-surface-raised p-2 text-sm text-text-body file:mr-3 file:min-h-10 file:cursor-pointer file:rounded-sm file:border-0 file:bg-primary file:px-4 file:text-sm file:font-semibold file:text-primary-foreground hover:file:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
const newTab = { target: '_blank', rel: 'noopener noreferrer' } as const;

/** `initialBranchId` is the working branch the owner arrived from; it only seeds the form. */
export function OwnerImportWizard({ initialBranchId }: { initialBranchId?: string } = {}) {
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
  const [prefilled, setPrefilled] = useState(false);
  if (!prefilled && options.data) {
    // Seed branch and location once from the working branch; later edits are the owner's own.
    const target = defaultImportTarget(options.data, initialBranchId);
    setPrefilled(true);
    setBranchId(target.branchId);
    setStockLocationId(target.stockLocationId);
  }
  const problemRows = preview?.lines.filter((line) => line.errors.length > 0).length ?? 0;
  const onlyBranch = options.data?.branches.length === 1 ? options.data.branches[0] : undefined;
  const inventoryHref = branchId ? `/pharmacy/inventory?${new URLSearchParams({ branch: branchId })}` : '/pharmacy/inventory';
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
    <main className="min-w-0 space-y-6">
      <PageHeader eyebrow="Pharmacy inventory · Owner setup" heading="Import opening stock"
        description="Load the stock you already have on the shelf: upload your stock list, match its columns, and check every row before anything is saved."
        actions={<Link href={inventoryHref} className={buttonVariants({ variant: 'secondary' })}>Back to Inventory</Link>} />
      {options.isPending ? <SectionCard title="Loading import access" titleLevel={2}><p role="status">Loading your branches and stock locations…</p></SectionCard> :
        options.error ? <SectionCard title={denied ? 'Owner access required' : 'Could not load import setup'} titleLevel={2}>
          <p role="alert" className="text-sm text-text-muted">{denied ? 'A workspace administrator with Pharmacy Inventory enabled must import opening stock.' : 'Your setup could not be loaded. Try again.'}</p>
          {!denied && <Button variant="secondary" className="mt-4" onClick={() => void options.refetch()}>Retry setup</Button>}
        </SectionCard> : receipt ? <SectionCard title="Opening stock imported" titleLevel={2}>
          <div role="status" className="space-y-3 text-sm text-text-body">
            <StatusPill status="success" label={receipt.replayed ? 'Already imported · receipt recovered' : 'Imported'} />
            <p>{receipt.totalUnits} units added · Opening stock value {money(receipt.totalValueMinor)}.</p>
            <p className="break-all font-mono text-xs">Session: {receipt.sessionId}</p>
            <p>The counted quantities are now in inventory. The reason for each count difference was saved with its row; a second person’s sign-off is not yet available on this screen.</p>
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link href={inventoryHref} className={buttonVariants()}>View inventory</Link>
            <Link href={IMPORTED_STOCK_ROUTE} className={buttonVariants({ variant: 'secondary' })}>Review imported stock</Link>
          </div>
        </SectionCard> : !options.data?.branches.length || !options.data.locations.length ?
          <SectionCard title="Set up a branch and stock location first" titleLevel={2}>
            <p className="text-sm text-text-muted">Opening stock needs an active branch and an active stock location. Complete these in Pharmacy setup and Inventory, then return here.</p>
            <Link href="/pharmacy" className={buttonVariants({ variant: 'secondary', className: 'mt-4' })}>Pharmacy setup</Link>
          </SectionCard> : <>
          <nav aria-label="Import progress"><ol className="flex flex-wrap gap-3 text-sm text-text-muted">
            {['Upload', 'Match columns', 'Review and import'].map((step, index) => <li key={step} aria-current={index === (preview ? 2 : sheet ? 1 : 0) ? 'step' : undefined} className={index === (preview ? 2 : sheet ? 1 : 0) ? 'font-semibold text-text-strong' : ''}>{index + 1}. {step}</li>)}
          </ol></nav>
          {error && <div role="alert" id="import-error" className="rounded-sm border border-destructive p-4 text-sm text-destructive">{error}</div>}
          <SectionCard title="1. Upload the opening count" titleLevel={2}>
            <p className="mb-4 text-sm text-text-muted">Do this once, before the branch starts selling or receiving deliveries. Each medicine must already be in your catalogue with its pack size. Count quantities in single units (tablets, capsules, bottles); the MRP is the price printed on one pack. Your old system’s quantity and your own shelf count go in separate columns. A large stock list can be split across several files.</p>
            <div className="mb-5 flex flex-wrap gap-3">
              <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(OPENING_TEMPLATE)}`} download="pharmacy-opening-stock.csv" className={buttonVariants({ variant: 'secondary' })}>Download CSV template</a>
              <Link href="/pharmacy/medicines" className={buttonVariants({ variant: 'ghost' })}>Medicine catalogue and packs</Link>
              <Link href={IMPORTED_STOCK_ROUTE} className={buttonVariants({ variant: 'ghost' })}>Imported stock awaiting verification</Link>
            </div>
            <div className="grid min-w-0 gap-4 md:grid-cols-2">
              {onlyBranch ? <div className="space-y-2 text-sm text-text-body"><span>Branch</span>
                <p className="flex min-h-11 items-center font-medium text-text-strong">{onlyBranch.name}</p>
              </div> : <label className="space-y-2 text-sm text-text-body"><span>Branch</span>
                <select className={control} value={branchId} disabled={busy} onChange={(event) => {
                  const next = defaultImportTarget(options.data!, event.target.value);
                  setBranchId(event.target.value); setStockLocationId(event.target.value ? next.stockLocationId : ''); clearPreview();
                }}>
                  <option value="">Choose branch</option>{options.data.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                </select>
              </label>}
              <label className="space-y-2 text-sm text-text-body"><span>Stock location</span>
                <select className={control} value={stockLocationId} disabled={busy || !branchId} onChange={(event) => { setStockLocationId(event.target.value); clearPreview(); }}>
                  <option value="">Choose stock location</option>{options.data.locations.filter((location) => location.branchId === branchId).map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                </select>
              </label>
              <label className="space-y-2 text-sm text-text-body md:col-span-2"><span>CSV or XLSX file</span>
                <input type="file" accept=".csv,.xlsx" disabled={busy} className={fileInput} aria-describedby="upload-help" aria-invalid={Boolean(error && !sheet)} onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.currentTarget.value = '';
                  void chooseFile(file);
                }} />
              </label>
            </div>
            <p id="upload-help" className="mt-3 text-sm text-text-muted">Up to 1 MiB, {IMPORT_MAX_ROWS} stock rows and 40 columns. XLSX: one populated worksheet with plain values. Preserve barcode leading zeroes using text cells. CSV: UTF-8, comma separated.</p>
            {busy && <p role="status" className="mt-3 text-sm text-text-muted">{commit.isPending ? 'Saving opening stock and its value…' : dryRun.isPending ? 'Checking every row…' : 'Reading and checking your file…'}</p>}
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
            <p className="mt-4 text-sm text-text-muted">* Required. Use plain numbers without currency symbols or thousands separators. PKR amounts allow up to two decimal places. Exported and counted units must be whole numbers, including an explicit 0. Explain every count difference.</p>
            <Button className="mt-5 min-h-11" disabled={busy || !branchId || !stockLocationId || IMPORT_FIELDS.some(([field, , required]) => required && mapping[field] === undefined)} onClick={async () => {
              clearPreview();
              try { setPreview(await dryRun.mutateAsync({ ...source, branchId, stockLocationId, mapping })); }
              catch (failure) { setError(failure instanceof Error ? failure.message : 'The preview failed. Your stock has not changed.'); }
            }}>Preview import</Button>
            <p className="mt-3 text-sm text-text-muted">The preview checks every row. Nothing is saved until you confirm in step 3.</p>
          </SectionCard>}
          {preview && source && <SectionCard title="3. Review and import" titleLevel={2}>
            <div role="status" className="mb-4 space-y-2 text-sm text-text-body">
              <StatusPill status={preview.canCommit ? 'success' : 'blocked'} label={preview.canCommit ? 'Ready to import' : problemRows ? `${problemRows} ${problemRows === 1 ? 'row needs' : 'rows need'} a fix` : 'Import blocked'} />
              <p>{preview.lines.length} rows · {preview.totalUnits} counted units · {money(preview.totalValueMinor)} opening stock value.</p>
              <p>Nothing has been saved yet. Each row that passes adds your shelf count as new stock; the old system’s quantity is only shown for comparison. Stock that was imported before cannot be imported again.</p>
              {!preview.canCommit && problemRows > 0 && <p>Each row marked below says what is wrong and what to do. Fix your file or your catalogue, then choose Preview import again. Catalogue links open in a new tab so this import stays open.</p>}
            </div>
            {preview.blockers.length > 0 && <ul className="mb-4 list-disc space-y-2 pl-5 text-sm text-destructive">{preview.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
            <Table><caption className="sr-only">Opening stock rows, count differences, and blocking validation errors</caption>
              <TableHeader><TableRow>
                <TableHead>Row / reference</TableHead><TableHead>Medicine / pack / batch</TableHead><TableHead>Expiry</TableHead><TableHead numeric>Now in stock</TableHead><TableHead numeric>Old system</TableHead><TableHead numeric>Counted / added</TableHead><TableHead numeric>New total</TableHead><TableHead numeric>Difference</TableHead><TableHead>Check</TableHead>
              </TableRow></TableHeader>
              <TableBody>{preview.lines.map((line) => <TableRow key={line.rowNumber}>
                <TableCell className="max-w-48 whitespace-normal break-words">{line.rowNumber} · {line.sourceRef || 'Missing reference'}</TableCell>
                <TableCell className="min-w-48 max-w-72 whitespace-normal break-words">{line.medicineName || 'No matching medicine'}<br />{line.packReference} · {line.batchNumber}<br />{line.unitsPerPack === null ? 'Pack size unknown' : `${line.unitsPerPack} units per pack`}</TableCell>
                <TableCell>{line.expiryDate ? new Date(line.expiryDate).toISOString().slice(0, line.expiryPrecision === 'MONTH' ? 7 : 10) : 'Missing'}</TableCell>
                <TableCell numeric>{line.currentUnits}</TableCell><TableCell numeric>{line.expectedUnits ?? 'Invalid'}</TableCell><TableCell numeric>{line.countedUnits ?? 'Invalid'}</TableCell><TableCell numeric>{line.proposedUnits ?? 'Unknown'}</TableCell><TableCell numeric>{line.varianceUnits ?? 'Unknown'}</TableCell>
                <TableCell className="min-w-64 max-w-96 whitespace-normal">
                  {line.errors.length ? <ul className="space-y-3">{explainImportRow(line).map((problem, index) => <li key={`${index}:${problem.title}`} className="text-sm">
                    <p className="font-medium text-destructive">{problem.title}</p>
                    <p className="mt-1 text-xs text-text-body">{problem.detail}</p>
                    {problem.medicine && <div className="mt-2 flex flex-wrap gap-2">
                      <a href={problem.medicine.pickHref} {...newTab} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>Pick the matching medicine<span className="sr-only"> (opens in a new tab)</span></a>
                      <a href={problem.medicine.reviewHref} {...newTab} className={buttonVariants({ variant: 'outline', size: 'sm' })}>Request a new medicine for review<span className="sr-only"> (opens in a new tab)</span></a>
                    </div>}
                  </li>)}</ul> : <><StatusPill status="success" label="Ready" /><p className="mt-2 text-xs">MRP {money(String(line.printedMrpMinor))} per pack · Cost {money(String(line.unitCostMinor))} per unit</p></>}
                  {line.varianceNote && <p className="mt-2 break-words text-xs text-text-muted">Reason for difference: {line.varianceNote}</p>}
                </TableCell>
              </TableRow>)}</TableBody>
            </Table>
            <label className="mt-5 flex min-h-11 items-start gap-3 text-sm text-text-body">
              <input type="checkbox" className="mt-1 size-5 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-ring" checked={confirmed} disabled={busy || !preview.canCommit} onChange={(event) => setConfirmed(event.target.checked)} />
              <span>I checked the shelf counts, unit costs, printed MRPs, pack sizes, batches, expiry dates and stock location. Import every row as opening stock and record its value.</span>
            </label>
            <Button className="mt-4 min-h-11" disabled={busy || !preview.canCommit || !confirmed} onClick={async () => {
              setError('');
              try { setReceipt(await commit.mutateAsync({ ...source, branchId, stockLocationId, mapping, previewHash: preview.previewHash, confirmed: true })); }
              catch (failure) { setError(failure instanceof Error ? failure.message : 'The import failed. Try again; it will not add the stock twice.'); }
            }}>{commit.isPending ? 'Importing opening stock…' : 'Import opening stock'}</Button>
            <p className="mt-3 text-sm text-text-muted">The whole file is imported once. Trying again after a failure returns the same receipt instead of adding the stock twice. Every count difference needs a reason; this import does not include a second person’s sign-off.</p>
          </SectionCard>}
        </>}
    </main>
  );
}
