'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { trpc } from '@/lib/trpc';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { MAX_SHELF_LABELS, reserveShelfLabelPrint, type ShelfLabelFormat, type ShelfLabelSource } from '@/lib/pharmacy/shelf-label';

export function ShelfLabelPrintPanel({ branchId, goodsReceiptId, rows }: {
  branchId: string;
  goodsReceiptId?: string;
  rows: ShelfLabelSource[];
}) {
  const [counts, setCounts] = useState<Record<string, string>>(() => Object.fromEntries(rows.map((row) => [row.inventoryLotId, String(row.unavailableReason ? 0 : row.count)])));
  const [format, setFormat] = useState<ShelfLabelFormat>('38x25');
  const [notice, setNotice] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const print = trpc.pharmacyInventory.printShelfLabels.useMutation();
  const items = rows.map((row) => ({ inventoryLotId: row.inventoryLotId, count: row.unavailableReason ? 0 : Number(counts[row.inventoryLotId]) }));
  const total = items.reduce((sum, item) => sum + item.count, 0);
  const invalid = items.some((item) => !Number.isSafeInteger(item.count) || item.count < 0 || item.count > MAX_SHELF_LABELS) || total > MAX_SHELF_LABELS;

  async function submit() {
    setNotice(null);
    setFailed(false);
    let reservation: ReturnType<typeof reserveShelfLabelPrint> | undefined;
    try {
      reservation = reserveShelfLabelPrint();
      const result = await print.mutateAsync({ branchId, goodsReceiptId, format, items: items.filter((item) => item.count > 0) });
      reservation.print(result.html);
      setNotice('Print dialog opened. Check the selected stock size and use 100% scale. Physical printing is not confirmed.');
    } catch (error) {
      reservation?.cancel();
      setFailed(true);
      setNotice(error instanceof Error ? error.message : 'Labels could not be prepared. Retry printing.');
    }
  }

  return (
    <SectionCard title="Choose labels and counts">
      <p className="mb-4 text-sm text-text-muted">
        {goodsReceiptId ? 'One label per received pack, including bonus packs, is selected by default.' : 'Choose lots from this medicine list, or narrow it with search.'} Set a count to zero to omit a lot. Each label shows the lot MRP the counter charges, refreshed when printing.
      </p>
      {rows.length === 0 ? <p className="text-sm text-text-muted">No received lots match. Change the search, select another branch, or post a GRN in Goods in.</p> : (
        <div className="max-w-full overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="font-mono text-xs uppercase text-text-muted"><tr>
              <th scope="col" className="p-3 text-left">Medicine / lot</th>
              <th scope="col" className="p-3 text-left">Expiry</th>
              <th scope="col" className="p-3 text-right">MRP/pack (PKR)</th>
              <th scope="col" className="p-3 text-right">MRP/strip (PKR)</th>
              <th scope="col" className="p-3 text-right">Labels</th>
            </tr></thead>
            <tbody>{rows.map((row) => {
              const count = row.unavailableReason ? 0 : Number(counts[row.inventoryLotId]);
              const countInvalid = !Number.isSafeInteger(count) || count < 0 || count > MAX_SHELF_LABELS;
              const unavailableId = `shelf-label-unavailable-${row.inventoryLotId}`;
              return <tr key={row.inventoryLotId} className="border-t border-border-subtle hover:bg-surface-sunken">
                <td className="p-3"><span className="font-medium text-text-strong">{row.name}</span><div className="text-xs text-text-muted">{row.strength ?? 'Strength not applicable'} · Batch {row.batchNumber}</div><div className="font-mono text-xs text-text-muted">{row.code}</div>{row.unavailableReason ? <p id={unavailableId} className="mt-1 text-xs text-warning">Unavailable: {row.unavailableReason}</p> : null}</td>
                <td className="whitespace-nowrap p-3 font-mono tabular-nums">{row.expiry}</td>
                <td className="p-3 text-right font-mono tabular-nums">{formatMinor(row.packMrpMinor)}{row.priceRecordMrpMinor != null ? <div className="font-sans text-xs text-warning">Price record says {formatMinor(row.priceRecordMrpMinor)}. The label and the counter use the lot MRP.</div> : null}</td>
                <td className="p-3 text-right font-mono tabular-nums">{row.stripMrpMinor === null ? 'N/A' : formatMinor(row.stripMrpMinor)}</td>
                <td className="p-3"><label className="block min-w-24"><span className="sr-only">Label count for {row.name}, batch {row.batchNumber}, lot {row.code}</span><Input type="number" min={0} max={5000} step={1} value={row.unavailableReason ? '0' : counts[row.inventoryLotId]} disabled={print.isPending || !!row.unavailableReason} aria-invalid={countInvalid} aria-describedby={row.unavailableReason ? unavailableId : countInvalid ? 'shelf-label-count-error' : undefined} className="min-h-11 text-right" onChange={(event) => setCounts((previous) => ({ ...previous, [row.inventoryLotId]: event.target.value }))} /></label></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="text-sm font-medium text-text-body">Paper size
          <select className="mt-1 block min-h-11 rounded-md border border-input bg-surface-raised px-3 text-text-strong focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50" value={format} disabled={print.isPending} onChange={(event) => setFormat(event.target.value as ShelfLabelFormat)}>
            <option value="38x25">Thermal 38 × 25 mm</option><option value="50x25">Thermal 50 × 25 mm</option><option value="A4">A4 sheet · 50 × 25 mm labels</option>
          </select>
        </label>
        <Button size="touch" disabled={print.isPending || invalid || total < 1} onClick={() => void submit()}>{print.isPending ? 'Preparing labels…' : `Print ${Number.isFinite(total) ? total : 0} labels`}</Button>
      </div>
      {invalid ? <p id="shelf-label-count-error" role="alert" className="mt-3 text-sm text-destructive">Use whole counts from 0 to 5,000, with at most 5,000 labels per print request.</p> : null}
      {notice ? <p role={failed ? 'alert' : 'status'} className={`mt-3 text-sm ${failed ? 'text-destructive' : 'text-text-muted'}`}>{notice}</p> : null}
    </SectionCard>
  );
}
