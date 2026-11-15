'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS } from '@/lib/pharmacy/migration/owner-import-input';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const control =
  'min-h-11 w-full min-w-0 rounded-sm border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
const TEMPLATE = 'Product,Pack,Barcode,TP,MRP\nExample Tablets 500mg,BOX,,850.00,1000.00\n';

/** Display only: every figure shown here was computed by the server's SQL. */
export function pkr(minor: number | null) {
  if (minor === null) return '—';
  const sign = minor < 0 ? '−' : '';
  const value = Math.abs(minor);
  return `${sign}PKR ${Math.trunc(value / 100).toLocaleString('en-PK')}.${String(value % 100).padStart(2, '0')}`;
}

function change(minor: number | null, bps: number | null) {
  if (minor === null || minor === 0) return minor === 0 ? 'No change' : '—';
  const sign = minor > 0 ? '+' : '';
  return `${sign}${pkr(minor)}${bps === null ? '' : ` (${sign}${(bps / 100).toFixed(2)}%)`}`;
}

const MATCH_LABEL = { MATCHED: 'Matched', NO_MATCH: 'Not in catalogue', AMBIGUOUS: 'Needs mapping' };

export function SupplierPriceListsConsole({
  canApprove,
  actorId,
  soloOwner,
}: {
  /** Owner or administrator: the server's `admin:access`, as for setting a pack price. */
  canApprove: boolean;
  actorId: string;
  /** The only active member, who may approve a list they imported with a fresh PIN. */
  soloOwner: boolean;
}) {
  const utils = trpc.useUtils();
  const options = trpc.pharmacySupplierPriceLists.options.useQuery(undefined, { retry: false });
  const lists = trpc.pharmacySupplierPriceLists.list.useQuery(undefined, { retry: false });
  const [selected, setSelected] = useState<string | null>(null);
  const review = trpc.pharmacySupplierPriceLists.review.useQuery(
    { priceListId: selected ?? '' },
    { enabled: Boolean(selected), retry: false }
  );
  const upload = trpc.pharmacySupplierPriceLists.import.useMutation();
  const decide = trpc.pharmacySupplierPriceLists.decide.useMutation();
  const [supplierId, setSupplierId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reading, setReading] = useState(false);
  const [pin, setPin] = useState('');
  const busy = reading || upload.isPending || decide.isPending;
  const denied =
    options.error?.data?.code === 'FORBIDDEN' || options.error?.data?.code === 'UNAUTHORIZED';

  async function chooseFile(file?: File) {
    setError('');
    setNotice('');
    if (!file) return;
    if (!/\.(csv|xlsx)$/i.test(file.name) || file.size === 0 || file.size > IMPORT_MAX_BYTES) {
      setError('Choose a nonempty CSV or XLSX file up to 1 MiB.');
      return;
    }
    setReading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const result = await upload.mutateAsync({
        supplierId,
        fileName: file.name,
        content: btoa(binary),
      });
      setNotice(
        result.replayed
          ? 'This file was already imported for this supplier. Showing the earlier comparison.'
          : 'Price list imported. No price has changed; review the drafts below.'
      );
      setSelected(result.priceListId);
      await utils.pharmacySupplierPriceLists.list.invalidate();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The price list could not be read.');
    } finally {
      setReading(false);
    }
  }

  async function decideLine(lineId: string, decision: 'APPROVE' | 'REJECT') {
    setError('');
    setNotice('');
    try {
      await decide.mutateAsync({
        lineIds: [lineId],
        decision,
        ...(decision === 'APPROVE' && importedByMe ? { pin } : {}),
      });
      setPin('');
      setNotice(decision === 'APPROVE' ? 'Shelf price approved and saved.' : 'Draft rejected. No price changed.');
      await Promise.all([
        utils.pharmacySupplierPriceLists.review.invalidate(),
        utils.pharmacySupplierPriceLists.list.invalidate(),
      ]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The decision was not saved.');
    }
  }

  if (options.isPending)
    return (
      <SectionCard title="Loading price lists" titleLevel={2}>
        <p role="status" className="text-sm text-text-muted">Loading suppliers and imported lists…</p>
      </SectionCard>
    );
  if (options.error)
    return (
      <SectionCard title={denied ? 'Procurement access required' : 'Could not load price lists'} titleLevel={2}>
        <p role="alert" className="text-sm text-text-muted">
          {denied
            ? 'Importing supplier price lists needs the procurement permission.'
            : 'The price lists could not be loaded. Try again.'}
        </p>
        {!denied && (
          <Button variant="secondary" className="mt-4" onClick={() => void options.refetch()}>
            Retry
          </Button>
        )}
      </SectionCard>
    );

  const lines = review.data?.lines ?? [];
  const importedByMe = review.data?.importedById === actorId;
  // Segregation of duties, mirrored from the server: the importer does not
  // approve their own list unless they are a solo owner re-entering a PIN.
  const mayApprove = canApprove && (!importedByMe || soloOwner);
  const pinNeeded = mayApprove && importedByMe;
  return (
    <div className="min-w-0 space-y-6">
      {error && (
        <div role="alert" className="rounded-sm border border-destructive p-4 text-sm text-destructive">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="rounded-sm border border-border-default p-4 text-sm text-text-body">
          {notice}
        </div>
      )}
      <SectionCard title="Import a distributor price list" titleLevel={2}>
        <p className="mb-4 text-sm text-text-muted">
          Prices are per pack in PKR. Rows are matched by pack barcode, or by the exact catalogue
          name or alias. Importing never changes a price: changed MRPs become drafts that an owner
          or administrator other than the importer approves one by one. PDF lists: export or copy them to Excel or CSV first.
        </p>
        <div className="mb-5 flex flex-wrap gap-3">
          <a
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`}
            download="supplier-price-list.csv"
            className={buttonVariants({ variant: 'secondary' })}
          >
            Download CSV template
          </a>
        </div>
        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm text-text-body">
            <span>Supplier</span>
            <select
              className={control}
              value={supplierId}
              disabled={busy}
              onChange={(event) => setSupplierId(event.target.value)}
            >
              <option value="">Choose supplier</option>
              {options.data.suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm text-text-body">
            <span>CSV or XLSX price list</span>
            <Input
              type="file"
              accept=".csv,.xlsx"
              disabled={busy || !supplierId}
              className="min-h-11"
              aria-describedby="price-list-help"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.currentTarget.value = '';
                void chooseFile(file);
              }}
            />
          </label>
        </div>
        <p id="price-list-help" className="mt-3 text-sm text-text-muted">
          Columns: Product (required), Pack (BOX, STRIP or UNIT), Barcode, TP and/or MRP. Up to{' '}
          {IMPORT_MAX_ROWS} rows. Choose the supplier first.
        </p>
        {busy && (
          <p role="status" className="mt-3 text-sm text-text-muted">
            {decide.isPending ? 'Saving your decision…' : 'Reading and comparing the price list…'}
          </p>
        )}
      </SectionCard>

      <SectionCard title="Imported price lists" titleLevel={2}>
        {lists.isPending ? (
          <p role="status" className="text-sm text-text-muted">Loading imported lists…</p>
        ) : lists.error ? (
          <p role="alert" className="text-sm text-destructive">The imported lists could not be loaded.</p>
        ) : !lists.data?.length ? (
          <p className="text-sm text-text-muted">No price lists yet. Import a distributor list above.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <caption className="sr-only">Imported supplier price lists</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Supplier</TableHead>
                  <TableHead>File</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead className="text-right">Matched</TableHead>
                  <TableHead className="text-right">Price alerts</TableHead>
                  <TableHead className="text-right">Open drafts</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lists.data.map((list) => (
                  <TableRow key={list.id} aria-current={list.id === selected ? 'true' : undefined}>
                    <TableCell>{list.supplierName}</TableCell>
                    <TableCell className="break-all">{list.fileName}</TableCell>
                    <TableCell className="text-right tabular-nums">{list.rowCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{list.matched}</TableCell>
                    <TableCell className="text-right tabular-nums">{list.alerts}</TableCell>
                    <TableCell className="text-right tabular-nums">{list.drafts}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="secondary" size="touch" onClick={() => setSelected(list.id)}>
                        Review
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      {selected && (
        <SectionCard
          title={review.data ? `${review.data.supplierName} · ${review.data.fileName}` : 'Price changes'}
          titleLevel={2}
        >
          {review.isPending ? (
            <p role="status" className="text-sm text-text-muted">Comparing with current records…</p>
          ) : review.error ? (
            <p role="alert" className="text-sm text-destructive">This price list could not be loaded.</p>
          ) : (
            <div className="min-w-0 space-y-4">
            {pinNeeded && (
              <label className="block max-w-xs space-y-2 text-sm text-text-body">
                <span>Your approval PIN</span>
                <Input
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  className="min-h-11"
                  value={pin}
                  disabled={busy}
                  aria-describedby="price-pin-help"
                  onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 8))}
                />
                <span id="price-pin-help" className="block text-xs text-text-muted">
                  You imported this list and are the only active member, so re-enter your PIN to
                  approve. The approval is recorded under the solo-owner policy.
                </span>
              </label>
            )}
            <div className="overflow-x-auto">
              <Table>
                <caption className="sr-only">
                  Trade price and MRP changes against current records, with shelf-price drafts
                </caption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Row</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Match</TableHead>
                    <TableHead className="text-right">List TP</TableHead>
                    <TableHead className="text-right">TP change</TableHead>
                    <TableHead className="text-right">List MRP</TableHead>
                    <TableHead className="text-right">MRP change</TableHead>
                    <TableHead className="text-right">Draft shelf price</TableHead>
                    <TableHead className="text-right">Decision</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line) => (
                    <TableRow key={line.id}>
                      <TableCell className="tabular-nums">{line.rowNumber}</TableCell>
                      <TableCell>
                        <span className="block">{line.productText}</span>
                        {line.medicineName && (
                          <span className="block text-xs text-text-muted">
                            {line.medicineName}
                            {line.packLevel ? ` · ${line.packLevel}` : ''}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusPill
                          status={line.matchStatus}
                          tone={line.matchStatus === 'MATCHED' ? 'success' : 'warning'}
                          label={MATCH_LABEL[line.matchStatus]}
                        />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{pkr(line.listTradePriceMinor)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {line.previousTradePriceMinor === null
                          ? 'No earlier invoice'
                          : change(line.tradeChangeMinor, line.tradeChangeBps)}
                        {line.tradeAboveMrp && (
                          <span className="block text-xs text-destructive">TP above list MRP</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{pkr(line.listMrpMinor)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {line.matchStatus !== 'MATCHED'
                          ? '—'
                          : line.currentMrpMinor === null
                            ? 'No current price'
                            : change(line.mrpChangeMinor, line.mrpChangeBps)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {line.draftStatus === 'NONE' ? (
                          '—'
                        ) : (
                          <>
                            <span className="block">MRP {pkr(line.draftMrpMinor)}</span>
                            <span className="block text-xs text-text-muted">
                              Sell {line.draftSellingPriceMinor === null ? 'at MRP' : pkr(line.draftSellingPriceMinor)}
                            </span>
                          </>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {line.draftStatus === 'DRAFT' ? (
                          line.stale ? (
                            <StatusPill status="blocked" label="Price changed · re-import" />
                          ) : !canApprove ? (
                            <StatusPill status="pending" label="Awaiting owner approval" />
                          ) : !mayApprove ? (
                            <StatusPill status="pending" label="Another owner or admin approves" />
                          ) : (
                            <div className="flex justify-end gap-2">
                              <Button
                                size="touch"
                                disabled={busy || (pinNeeded && !/^\d{4,8}$/.test(pin))}
                                aria-label={`Approve shelf price for row ${line.rowNumber}`}
                                onClick={() => void decideLine(line.id, 'APPROVE')}
                              >
                                Approve
                              </Button>
                              <Button
                                size="touch"
                                variant="secondary"
                                disabled={busy}
                                aria-label={`Reject shelf price for row ${line.rowNumber}`}
                                onClick={() => void decideLine(line.id, 'REJECT')}
                              >
                                Reject
                              </Button>
                            </div>
                          )
                        ) : line.draftStatus === 'NONE' ? (
                          <span className="text-xs text-text-muted">Nothing to change</span>
                        ) : (
                          <StatusPill status={line.draftStatus} />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            </div>
          )}
        </SectionCard>
      )}
    </div>
  );
}
