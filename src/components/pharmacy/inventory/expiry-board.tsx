'use client';

import Link from 'next/link';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * PH-A5 — the near-expiry board with its three draft actions and the printable,
 * shareable list. Every value arrives already computed by
 * `pharmacyInventory.expiryBoardLots`; this component only presents it and posts
 * the operator's choice back through the page's Server Function.
 */

export type ExpiryBoardRow = {
  key: string;
  inventoryLotId: string;
  stockLocationId: string;
  locationName: string;
  medicineName: string;
  batchNumber: string;
  batchState: string;
  expiresAt: string;
  daysLeft: number;
  expired: boolean;
  onHandUnits: number;
  reservedUnits: number;
  quarantinedUnits: number;
  unitsPerPack: number;
  unitCostMinor: number;
  printedMrpMinor: number;
  valueAtRiskMinor: number;
  supplierName: string;
  suggestedSupplierId: string | null;
  markdownEligible: boolean;
  returnWindowOpensAt: string | null;
  returnDeadlineAt: string | null;
  markdown: {
    markdownPercent: number;
    printedMrpMinor: number;
    proposedPackPriceMinor: number;
    reason: string | null;
    recordedAt: string;
  } | null;
  returnDraft: { id: string; reference: string; status: string } | null;
  /** Minted per render so a double-submitted quarantine replays, never repeats. */
  requestKey: string;
};

export type ExpiryBoardProps = {
  view: 'board' | 'print';
  branchId: string;
  branchName: string;
  withinDays: number;
  generatedAt: string;
  riskBuckets: Array<{ days: number; valueAtRiskMinor: number }>;
  rows: ExpiryBoardRow[];
  suppliers: Array<{ id: string; name: string }>;
  boardHref: string;
  printHref: string;
  /** Purchasing → Returns for this branch; the board appends `&return=<id>`. */
  returnsHref: string;
  action: (data: FormData) => Promise<void>;
};

export const MARKDOWN_PERCENTS = [10, 15, 20, 25, 30, 40, 50] as const;

const INELIGIBLE_MARKDOWN_WARNING =
  'Legacy draft — now ineligible; retain it as audit history and do not advance it.';

const inputClass =
  'mt-1 min-h-10 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

export const money = (minor: number) =>
  `PKR ${(minor / 100).toLocaleString('en-PK', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
const day = (iso: string) =>
  new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso));
const expiryText = (row: Pick<ExpiryBoardRow, 'expired' | 'daysLeft'>) =>
  row.expired
    ? `Expired ${Math.abs(row.daysLeft)} day${Math.abs(row.daysLeft) === 1 ? '' : 's'} ago`
    : `${row.daysLeft} day${row.daysLeft === 1 ? '' : 's'} left`;

/** A leading `=`, `+`, `-` or `@` would run as a formula when the file is opened. */
function csvCell(value: string | number): string {
  const text = String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function nearExpiryCsv(rows: readonly ExpiryBoardRow[]): string {
  const header = [
    'Medicine',
    'Batch',
    'Expiry',
    'Status',
    'Location',
    'Units on hand',
    'Value at risk (PKR)',
    'Supplier',
    'Mark-down draft',
    'Return draft',
  ];
  const lines = rows.map((row) =>
    [
      row.medicineName,
      row.batchNumber,
      row.expiresAt.slice(0, 10),
      expiryText(row),
      row.locationName,
      row.onHandUnits,
      (row.valueAtRiskMinor / 100).toFixed(2),
      row.supplierName,
      row.markdown
        ? `${row.markdown.markdownPercent}% off (${(row.markdown.proposedPackPriceMinor / 100).toFixed(2)} per pack)${row.markdownEligible ? '' : ` · ${INELIGIBLE_MARKDOWN_WARNING}`}`
        : '',
      row.returnDraft ? `${row.returnDraft.reference} (${row.returnDraft.status})` : '',
    ]
      .map(csvCell)
      .join(',')
  );
  return [header.map(csvCell).join(','), ...lines].join('\n');
}

function Totals({
  rows,
  riskBuckets,
  withinDays,
}: Pick<ExpiryBoardProps, 'rows' | 'riskBuckets' | 'withinDays'>) {
  const units = rows.reduce((total, row) => total + row.onHandUnits, 0);
  const value = rows.reduce((total, row) => total + row.valueAtRiskMinor, 0);
  const expired = rows.filter((row) => row.expired).length;
  const drafted = rows.filter((row) => row.markdown || row.returnDraft).length;
  return (
    <section aria-label="Near-expiry summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <Stat
        label="Value at risk"
        value={money(value)}
        sub={`Selected ${withinDays}-day window, plus expired stock`}
      />
      {riskBuckets.map((bucket) => (
        <Stat
          key={bucket.days}
          label={`${bucket.days}-day PKR at risk`}
          value={money(bucket.valueAtRiskMinor)}
          sub="Cumulative units × landed cost"
        />
      ))}
      <Stat label="Units at risk" value={units.toLocaleString('en-PK')} sub="Still saleable" />
      <Stat label="Expired on the shelf" value={expired} sub="Quarantine these first" />
      <Stat label="Positions with a draft" value={drafted} sub="Mark-down or supplier return" />
    </section>
  );
}

function PrintableList(props: ExpiryBoardProps) {
  const csv = nearExpiryCsv(props.rows);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <Button type="button" onClick={() => window.print()}>
          Print list
        </Button>
        <a
          className={buttonVariants({ variant: 'secondary' })}
          download={`near-expiry-${props.generatedAt.slice(0, 10)}.csv`}
          href={`data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`}
        >
          Download CSV
        </a>
        <Link className={buttonVariants({ variant: 'ghost' })} href={props.boardHref}>
          Back to the board
        </Link>
      </div>
      <SectionCard
        eyebrow={`Generated ${day(props.generatedAt)} · expiring within ${props.withinDays} days`}
        title={`Near-expiry list — ${props.branchName}`}
        titleLevel={2}
      >
        {props.rows.length === 0 ? (
          <p className="text-sm text-text-muted">Nothing expires in this window.</p>
        ) : (
          <Table aria-label="Near-expiry list">
            <TableHeader>
              <TableRow>
                <TableHead>Medicine / batch</TableHead>
                <TableHead>Expiry</TableHead>
                <TableHead>Location</TableHead>
                <TableHead className="text-right">Units</TableHead>
                <TableHead className="text-right">Value at risk</TableHead>
                <TableHead>Drafts</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>
                    <span className="font-medium text-text-strong">{row.medicineName}</span>
                    <span className="block text-xs text-text-muted">
                      Batch {row.batchNumber} · {row.supplierName}
                    </span>
                  </TableCell>
                  <TableCell>
                    {day(row.expiresAt)}
                    <span className="block text-xs text-text-muted">{expiryText(row)}</span>
                  </TableCell>
                  <TableCell>{row.locationName}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.onHandUnits}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(row.valueAtRiskMinor)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {row.markdown ? `Mark-down ${row.markdown.markdownPercent}% · ` : ''}
                    {row.markdown && !row.markdownEligible ? (
                      <span className="block max-w-xs whitespace-normal text-warning" role="note">
                        {INELIGIBLE_MARKDOWN_WARNING}
                      </span>
                    ) : null}
                    {row.returnDraft ? `Return ${row.returnDraft.reference}` : ''}
                    {!row.markdown && !row.returnDraft ? '—' : ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}

function Hidden({
  row,
  props,
  kind,
}: {
  row: ExpiryBoardRow;
  props: ExpiryBoardProps;
  kind: string;
}) {
  return (
    <>
      <input name="action" type="hidden" value={kind} />
      <input name="branchId" type="hidden" value={props.branchId} />
      <input name="within" type="hidden" value={props.withinDays} />
      <input name="inventoryLotId" type="hidden" value={row.inventoryLotId} />
      <input name="stockLocationId" type="hidden" value={row.stockLocationId} />
    </>
  );
}

function LotCard({ row, props }: { row: ExpiryBoardRow; props: ExpiryBoardProps }) {
  const returnable = Math.max(0, Math.min(row.onHandUnits, row.onHandUnits - row.reservedUnits));
  const canMarkDown = row.markdownEligible && !row.expired && row.batchState === 'ACTIVE';
  const heading = `${row.medicineName} · batch ${row.batchNumber} · ${row.locationName}`;
  return (
    <article
      aria-label={heading}
      className="rounded-[var(--radius-md)] border border-border-subtle p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-text-strong">{heading}</h3>
          <p className="mt-1 text-sm text-text-body">
            Expires {day(row.expiresAt)} · {row.onHandUnits} units ({row.unitsPerPack} per pack) ·
            value at risk {money(row.valueAtRiskMinor)} · MRP {money(row.printedMrpMinor)} per pack
          </p>
          <p className="mt-1 text-xs text-text-muted">
            Supplier on the lot: {row.supplierName}
            {row.reservedUnits ? ` · ${row.reservedUnits} units already reserved for a claim` : ''}
            {row.quarantinedUnits
              ? ` · ${row.quarantinedUnits} units of this lot in quarantine`
              : ''}
          </p>
          {row.returnDeadlineAt ? (
            <p className="mt-1 text-xs text-text-muted">
              Distributor return calendar: opens {day(row.returnWindowOpensAt!)} · deadline{' '}
              {day(row.returnDeadlineAt)}
            </p>
          ) : (
            <p className="mt-1 text-xs text-text-muted">No distributor return window recorded.</p>
          )}
        </div>
        <StatusPill
          status={expiryText(row)}
          tone={row.expired ? 'danger' : row.daysLeft <= 30 ? 'warning' : 'neutral'}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="rounded-[var(--radius-sm)] bg-surface-sunken p-3">
          <h4 className="text-sm font-medium text-text-strong">Mark down</h4>
          {row.markdown ? (
            <p
              className={`mt-1 text-xs ${row.markdownEligible ? 'text-text-body' : 'text-warning'}`}
              role="note"
            >
              {row.markdownEligible ? 'Draft' : 'Legacy draft — now ineligible'}:{' '}
              {money(row.markdown.printedMrpMinor)} → {money(row.markdown.proposedPackPriceMinor)}{' '}
              per pack ({row.markdown.markdownPercent}% off), recorded{' '}
              {day(row.markdown.recordedAt)}. Not applied at the counter
              {row.markdownEligible
                ? ' yet.'
                : '; retain it as audit history and do not advance it.'}
            </p>
          ) : null}
          {canMarkDown ? (
            <form action={props.action} className="mt-2 space-y-2">
              <Hidden kind="markdown" props={props} row={row} />
              <label className="block text-xs">
                Mark-down %
                <select
                  className={inputClass}
                  defaultValue={row.markdown?.markdownPercent ?? 20}
                  name="markdownPercent"
                >
                  {MARKDOWN_PERCENTS.map((percent) => (
                    <option key={percent} value={percent}>
                      {percent}% off →{' '}
                      {money(Math.round((row.printedMrpMinor * (100 - percent)) / 100))}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs">
                Mark-down reason
                <Input
                  className="mt-1"
                  defaultValue="Clear before expiry"
                  maxLength={500}
                  name="reason"
                  required
                />
              </label>
              <Button size="sm" type="submit" variant="secondary">
                Draft mark-down
              </Button>
            </form>
          ) : (
            <p className="mt-1 text-xs text-text-muted">
              {!row.markdownEligible
                ? 'No mark-down suggestion: prescription/restricted stock is excluded; only OTC and non-drug stock is eligible.'
                : row.expired
                  ? 'Expired stock cannot be sold at any price. Quarantine it.'
                  : 'This batch is blocked, so it cannot be marked down.'}
            </p>
          )}
        </div>

        <div className="rounded-[var(--radius-sm)] bg-surface-sunken p-3">
          <h4 className="text-sm font-medium text-text-strong">Return to supplier</h4>
          {row.returnDraft ? (
            <p className="mt-1 text-xs text-text-body" role="note">
              Return {row.returnDraft.reference} is {row.returnDraft.status.toLowerCase()}.{' '}
              <Link
                className="underline"
                href={`${props.returnsHref}&return=${encodeURIComponent(row.returnDraft.id)}`}
              >
                Open in Purchasing → Returns
              </Link>
            </p>
          ) : props.suppliers.length === 0 ? (
            <p className="mt-1 text-xs text-text-muted">
              Add the supplier in Purchasing before drafting a return.
            </p>
          ) : returnable === 0 ? (
            <p className="mt-1 text-xs text-text-muted">
              Every unit of this lot is already reserved for a claim.
            </p>
          ) : (
            <form action={props.action} className="mt-2 space-y-2">
              <Hidden kind="return" props={props} row={row} />
              <label className="block text-xs">
                Return supplier
                <select
                  className={inputClass}
                  defaultValue={row.suggestedSupplierId ?? props.suppliers[0]!.id}
                  name="supplierId"
                >
                  {props.suppliers.map((supplier) => (
                    <option key={supplier.id} value={supplier.id}>
                      {supplier.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs">
                Return units
                <Input
                  className="mt-1"
                  defaultValue={returnable}
                  max={returnable}
                  min={1}
                  name="units"
                  required
                  type="number"
                />
              </label>
              <label className="block text-xs">
                Return reason
                <Input
                  className="mt-1"
                  defaultValue={row.expired ? 'Expired stock' : 'Near expiry'}
                  maxLength={500}
                  name="reason"
                  required
                />
              </label>
              <Button size="sm" type="submit" variant="secondary">
                Draft supplier return
              </Button>
            </form>
          )}
        </div>

        <div className="rounded-[var(--radius-sm)] bg-surface-sunken p-3">
          <h4 className="text-sm font-medium text-text-strong">Quarantine</h4>
          <form action={props.action} className="mt-2 space-y-2">
            <Hidden kind="quarantine" props={props} row={row} />
            <input name="requestKey" type="hidden" value={row.requestKey} />
            <label className="block text-xs">
              Quarantine units
              <Input
                className="mt-1"
                defaultValue={row.onHandUnits}
                max={row.onHandUnits}
                min={1}
                name="units"
                required
                type="number"
              />
            </label>
            <label className="block text-xs">
              Quarantine reason
              <Input
                className="mt-1"
                defaultValue={
                  row.expired ? 'Expired: pulled from sale' : 'Near expiry: pulled from sale'
                }
                maxLength={500}
                name="reason"
                required
              />
            </label>
            <Button size="sm" type="submit" variant="destructive">
              Quarantine units
            </Button>
          </form>
        </div>
      </div>
    </article>
  );
}

export function ExpiryBoard(props: ExpiryBoardProps) {
  if (props.view === 'print') return <PrintableList {...props} />;
  return (
    <div className="space-y-6">
      <Totals riskBuckets={props.riskBuckets} rows={props.rows} withinDays={props.withinDays} />
      <SectionCard
        actions={
          <Link
            className={buttonVariants({ size: 'sm', variant: 'secondary' })}
            href={props.printHref}
          >
            Printable / shareable list
          </Link>
        }
        eyebrow={`INV-09 · expiring within ${props.withinDays} days, plus expired stock still on the shelf`}
        title="Expiry board"
        titleLevel={2}
      >
        <p className="mb-4 text-sm text-text-muted">
          Mark-downs and supplier returns are drafts: neither changes a price nor reserves stock
          until a person advances them. Quarantine is a real ledger movement that takes the units
          out of sale.
        </p>
        {props.rows.length === 0 ? (
          <p className="rounded-[var(--radius-sm)] bg-surface-sunken p-5 text-sm text-text-muted">
            Nothing saleable expires within {props.withinDays} days at this branch.
          </p>
        ) : (
          <div className="space-y-3">
            {props.rows.map((row) => (
              <LotCard key={row.key} props={props} row={row} />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
