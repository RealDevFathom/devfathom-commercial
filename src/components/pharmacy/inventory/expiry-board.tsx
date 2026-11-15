'use client';

import Link from 'next/link';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import { csvCell } from '@/lib/csv';
import { EXPIRY_CLAIM_MAX_POSITIONS } from '@/lib/pharmacy/expiry-claim';
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

export type ExpiryRiskBand = 'expired' | '30' | '60' | '90' | 'later';

/** DEV-728: amber steps at 90/60/30 days; red is reserved for stock already expired. */
export function expiryRiskBand(row: Pick<ExpiryBoardRow, 'expired' | 'daysLeft'>): ExpiryRiskBand {
  if (row.expired) return 'expired';
  if (row.daysLeft <= 30) return '30';
  if (row.daysLeft <= 60) return '60';
  if (row.daysLeft <= 90) return '90';
  return 'later';
}

const RISK_STEP: Record<
  ExpiryRiskBand,
  { label: string; tone: 'danger' | 'warning' | 'neutral'; className?: string }
> = {
  expired: { label: 'Expired', tone: 'danger' },
  // The amber tint deepens as expiry nears; the text and dot stay `--warning`,
  // whose contrast the design contract checks up to a 20% tint.
  '30': { label: 'Within 30 days', tone: 'warning', className: 'bg-warning/20' },
  '60': { label: 'Within 60 days', tone: 'warning', className: 'bg-warning/15' },
  '90': { label: 'Within 90 days', tone: 'warning', className: 'bg-warning/10' },
  later: { label: 'Beyond 90 days', tone: 'neutral' },
};

/** Units of a position that a new return could still take. */
const returnableUnits = (row: Pick<ExpiryBoardRow, 'onHandUnits' | 'reservedUnits'>) =>
  Math.max(0, Math.min(row.onHandUnits, row.onHandUnits - row.reservedUnits));

export type DistributorGroup = {
  key: string;
  supplierId: string | null;
  supplierName: string;
  rows: ExpiryBoardRow[];
};

/**
 * DEV-728: the board's lots grouped by the distributor they came from — the
 * matched supplier record when there is one, otherwise the name on the lot.
 */
export function groupExpiryRows(rows: readonly ExpiryBoardRow[]): DistributorGroup[] {
  const groups = new Map<string, DistributorGroup>();
  for (const row of rows) {
    const key = row.suggestedSupplierId
      ? `supplier:${row.suggestedSupplierId}`
      : `name:${row.supplierName.trim().toLowerCase()}`;
    const group = groups.get(key) ?? {
      key,
      supplierId: row.suggestedSupplierId,
      supplierName: row.supplierName,
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (left, right) =>
      left.supplierName.localeCompare(right.supplierName) || left.key.localeCompare(right.key)
  );
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
  const returnable = returnableUnits(row);
  const risk = RISK_STEP[expiryRiskBand(row)];
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
          className={risk.className}
          label={`${risk.label} · ${expiryText(row)}`}
          status={risk.label}
          tone={risk.tone}
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

function DistributorSection({
  group,
  headingId,
  props,
}: {
  group: DistributorGroup;
  headingId: string;
  props: ExpiryBoardProps;
}) {
  // Expired lots stay off the claim: their return window has closed, and one
  // closed line would stop the whole claim from being submitted.
  const claimable = group.rows.filter(
    (row) => !row.expired && !row.returnDraft && returnableUnits(row) > 0
  );
  // Rows arrive soonest-expiry first, so a capped claim takes the most urgent lots.
  const batch = claimable.slice(0, EXPIRY_CLAIM_MAX_POSITIONS);
  const value = group.rows.reduce((total, row) => total + row.valueAtRiskMinor, 0);
  const open = group.rows.find((row) => row.returnDraft)?.returnDraft ?? null;
  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 rounded-[var(--radius-md)] border border-border-default bg-surface-raised p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-text-strong" id={headingId}>
            {group.supplierName}
          </h3>
          <p className="mt-1 text-xs text-text-muted">
            {group.rows.length} stock position{group.rows.length === 1 ? '' : 's'} · value at risk{' '}
            {money(value)}
          </p>
        </div>
        {group.supplierId && claimable.length > 0 ? (
          <form action={props.action}>
            <input name="action" type="hidden" value="claim" />
            <input name="branchId" type="hidden" value={props.branchId} />
            <input name="within" type="hidden" value={props.withinDays} />
            <input name="supplierId" type="hidden" value={group.supplierId} />
            <input name="reason" type="hidden" value="Near-expiry return claim" />
            {batch.map((row) => (
              <input
                key={row.key}
                name="position"
                type="hidden"
                value={`${row.inventoryLotId}|${row.stockLocationId}`}
              />
            ))}
            <Button size="sm" type="submit" variant="secondary">
              Draft return claim
            </Button>
          </form>
        ) : null}
      </div>
      {!group.supplierId ? (
        <p className="text-xs text-warning" role="note">
          This distributor is not matched to a supplier record, so a claim cannot be drafted for the
          group. Add the supplier in Purchasing, or draft each lot&apos;s return below.
        </p>
      ) : claimable.length === 0 ? (
        <p className="text-xs text-text-muted" role="note">
          No lot here can go on a claim: expired lots are past the supplier return window, and the
          rest are already on a return or reserved.
          {open ? (
            <>
              {' '}
              <Link
                className="underline"
                href={`${props.returnsHref}&return=${encodeURIComponent(open.id)}`}
              >
                Open {open.reference} in Purchasing → Returns
              </Link>
            </>
          ) : null}
        </p>
      ) : (
        <p className="text-xs text-text-muted">
          Draft return claim puts {batch.length} lot{batch.length === 1 ? '' : 's'} on one expiry
          claim draft
          {claimable.length > batch.length
            ? ` (the ${batch.length} expiring soonest; draft again for the other ${claimable.length - batch.length})`
            : ''}
          . Expired lots are left off because their return window has closed. A draft reserves
          nothing until it is submitted.
        </p>
      )}
      <div className="space-y-3">
        {group.rows.map((row) => (
          <LotCard key={row.key} props={props} row={row} />
        ))}
      </div>
    </section>
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
        eyebrow={`Expiring within ${props.withinDays} days, plus expired stock still on the shelf`}
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
          <div className="space-y-5">
            {groupExpiryRows(props.rows).map((group, index) => (
              <DistributorSection
                group={group}
                headingId={`expiry-distributor-${index}`}
                key={group.key}
                props={props}
              />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
