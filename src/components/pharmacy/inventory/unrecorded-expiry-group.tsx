import { Button } from '@/components/ui/button';
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
import { BATCH_NOT_RECORDED, EXPIRY_NOT_RECORDED } from '@/lib/pharmacy/unrecorded-batch';

/**
 * DEV-853 — stock whose expiry was never recorded (legacy opening stock). It is
 * never treated as expired and stays on sale; it is listed in its own group so
 * staff can record the real batch and expiry from the pack when they have it.
 */

export type UnrecordedExpiryRow = {
  key: string;
  inventoryLotId: string;
  stockLocationId: string;
  locationName: string;
  medicineName: string;
  batchNumber: string | null;
  onHandUnits: number;
  unitsPerPack: number;
};

export function UnrecordedExpiryGroup({
  rows,
  branchId,
  withinDays,
  action,
}: {
  rows: readonly UnrecordedExpiryRow[];
  branchId: string;
  withinDays: number;
  action: (data: FormData) => void | Promise<void>;
}) {
  return (
    <SectionCard
      eyebrow="On sale · not on the expiry timeline"
      title={EXPIRY_NOT_RECORDED}
      actions={
        <StatusPill
          status="warning"
          tone="warning"
          label={`${rows.length} lot${rows.length === 1 ? '' : 's'}`}
        />
      }
    >
      <p className="text-sm text-text-muted">
        These lots came in without a recorded expiry. They can still be sold, and the counter sells
        stock with a known expiry first. Record the expiry (and batch, if missing) from the pack
        when you have it.
      </p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">Every lot on hand has a recorded expiry.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <Table aria-label="Lots with no recorded expiry">
            <TableHeader>
              <TableRow>
                <TableHead>Medicine / batch</TableHead>
                <TableHead>Location</TableHead>
                <TableHead className="text-right">Units</TableHead>
                <TableHead className="print:hidden">Record from the pack</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>
                    <span className="font-medium text-text-strong">{row.medicineName}</span>
                    <span className="block text-xs text-text-muted">
                      {row.batchNumber === null ? BATCH_NOT_RECORDED : `Batch ${row.batchNumber}`} ·{' '}
                      {EXPIRY_NOT_RECORDED}
                    </span>
                  </TableCell>
                  <TableCell>{row.locationName}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.onHandUnits}
                    <span className="block text-xs text-text-muted">
                      {row.unitsPerPack} per pack
                    </span>
                  </TableCell>
                  <TableCell className="print:hidden">
                    <form
                      action={action}
                      aria-label={`Record batch and expiry for ${row.medicineName}`}
                      className="flex flex-wrap items-end gap-2"
                    >
                      <input name="action" type="hidden" value="record" />
                      <input name="branchId" type="hidden" value={branchId} />
                      <input name="within" type="hidden" value={withinDays} />
                      <input name="inventoryLotId" type="hidden" value={row.inventoryLotId} />
                      {row.batchNumber === null ? (
                        <label className="text-xs text-text-body">
                          Batch number
                          <Input className="mt-1 min-h-10" maxLength={160} name="batchNumber" />
                        </label>
                      ) : null}
                      <label className="text-xs text-text-body">
                        Expiry month
                        <Input className="mt-1 min-h-10" name="expiryMonth" type="month" />
                      </label>
                      <Button size="sm" type="submit" variant="secondary">
                        Record
                      </Button>
                    </form>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </SectionCard>
  );
}
