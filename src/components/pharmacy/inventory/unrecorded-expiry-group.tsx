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
 * DEV-853 — stock whose expiry and/or batch number was never recorded (legacy
 * opening stock). An unknown expiry is never treated as expired and the stock
 * stays on sale; these lots are listed in their own group so staff can record
 * the real batch and expiry from the pack when they have it.
 */

export type UnrecordedExpiryRow = {
  key: string;
  inventoryLotId: string;
  stockLocationId: string;
  locationName: string;
  medicineName: string;
  batchNumber: string | null;
  /** `YYYY-MM` or `YYYY-MM-DD`; null when the expiry was never recorded. */
  printedExpiry: string | null;
  onHandUnits: number;
  unitsPerPack: number;
};

export const UNRECORDED_GROUP_TITLE = 'Batch or expiry not recorded';

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
      eyebrow="On sale · record from the pack"
      title={UNRECORDED_GROUP_TITLE}
      actions={
        <StatusPill
          status="warning"
          tone="warning"
          label={`${rows.length} lot${rows.length === 1 ? '' : 's'}`}
        />
      }
    >
      <p className="text-sm text-text-muted">
        These lots came in without a recorded expiry or batch number. They can still be sold, and
        the counter sells stock with a known expiry first. Record what is missing from the pack when
        you have it. Enter the expiry exactly as printed: YYYY-MM, or YYYY-MM-DD when the pack shows
        a day.
      </p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">
          Every lot on hand has a recorded batch number and expiry.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <Table aria-label="Lots with no recorded batch or expiry">
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
                      {row.printedExpiry === null
                        ? EXPIRY_NOT_RECORDED
                        : `Exp ${row.printedExpiry}`}
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
                      {row.printedExpiry === null ? (
                        <label className="text-xs text-text-body">
                          Expiry as printed
                          <Input
                            className="mt-1 min-h-10"
                            inputMode="numeric"
                            maxLength={10}
                            name="expiry"
                            pattern="\d{4}-\d{2}(-\d{2})?"
                            placeholder="YYYY-MM or YYYY-MM-DD"
                          />
                        </label>
                      ) : null}
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
