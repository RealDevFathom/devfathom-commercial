import type { Metadata } from 'next';
import Link from 'next/link';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import { can, subjectFromSession, type Action } from '@/lib/abac';
import { businessDateToUtcDate } from '@/lib/restaurant/business-date';
import { MAX_EXPORT_ROWS, MAX_INTERACTIVE_ROWS } from '@/lib/restaurant/reports';
import { hasModule } from '@/lib/entitlements';
import { restaurantReportsRouter } from '@/server/routers/restaurant-reports';
import { createTRPCContext } from '@/server/trpc';

import { ExportLink } from './export-link';
import { StockReportTabs } from './stock-report-tabs';

export const metadata: Metadata = { title: 'Restaurant reports' };

type SearchParams = Promise<
  Record<'branch' | 'stockLocation' | 'from' | 'to', string | string[] | undefined>
>;

const selectClass =
  'mt-1 min-h-11 w-full rounded-md border border-input bg-surface-raised px-2.5 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

function queryValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function validDate(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  try {
    businessDateToUtcDate(value);
    return value;
  } catch {
    return fallback;
  }
}

function displayNumber(value: string | number): string {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number)
    ? number.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : String(value);
}

function freshnessCopy(status: 'CURRENT' | 'STALE' | 'PARTIAL' | 'NO_CLOSED_DAYS') {
  return {
    CURRENT: { label: 'Current', tone: 'success' as const },
    STALE: { label: 'Stale projection', tone: 'warning' as const },
    PARTIAL: { label: 'Partial', tone: 'warning' as const },
    NO_CLOSED_DAYS: { label: 'No closed days', tone: 'neutral' as const },
  }[status];
}

function SectionNotice({
  kind,
  detail,
}: {
  kind: 'permission' | 'module' | 'error' | 'empty';
  detail: string;
}) {
  const title = {
    permission: 'Permission required',
    module: 'Source module not enabled',
    error: 'Section could not load',
    empty: 'No matching data',
  }[kind];
  return (
    <div
      className="rounded-md border border-dashed border-border-default px-5 py-8 text-center"
      role={kind === 'error' ? 'alert' : undefined}
    >
      <p className="font-medium text-text-strong">{title}</p>
      <p className="mt-1 text-sm text-text-muted">{detail}</p>
    </div>
  );
}

function DetailLimitNotice({ detail }: { detail: string }) {
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-sm border border-border-default bg-surface-sunken px-4 py-3 text-sm text-text-muted"
      role="status"
    >
      <StatusPill status="Detail limited" tone="warning" />
      <span>{detail}</span>
    </div>
  );
}

function TableFrame({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div
      aria-label={label}
      className="max-w-full overflow-x-auto rounded-sm border border-border-subtle"
      role="region"
      tabIndex={0}
    >
      {children}
    </div>
  );
}

async function settled<T>(work: () => Promise<T>): Promise<{ data: T | null; failed: boolean }> {
  try {
    return { data: await work(), failed: false };
  } catch {
    return { data: null, failed: true };
  }
}

export default async function RestaurantReportsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const query = await searchParams;
  const ctx = await createTRPCContext();
  const user = ctx.session?.user;
  if (!user) {
    return <SectionNotice kind="permission" detail="Sign in to open Restaurant reports." />;
  }
  const subject = subjectFromSession(user);
  const canCheck = (action: Action) =>
    can(subject, action, undefined, { db: ctx.db, source: 'TRPC', ip: ctx.requestMeta.ip });
  const [canOperational, canFinancial, canWorkforceRates] = await Promise.all([
    canCheck('reports:operational'),
    canCheck('reports:financial'),
    canCheck('workforce:rates'),
  ]);
  if (!canOperational && !canFinancial) {
    return (
      <div className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Restaurant operations"
          heading="Reports"
          description="Essentials-grade, closed-day Restaurant reporting."
        />
        <SectionCard title="Reports unavailable">
          <SectionNotice
            kind="permission"
            detail="reports:operational or reports:financial is required."
          />
        </SectionCard>
      </div>
    );
  }

  const caller = restaurantReportsRouter.createCaller(ctx);
  const branchResult = await settled(() => caller.branches());
  const branches = branchResult.data?.branches ?? [];
  if (branchResult.failed || branches.length === 0) {
    return (
      <div className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Restaurant operations"
          heading="Reports"
          description="Essentials-grade, closed-day Restaurant reporting."
        />
        <SectionCard title="No reportable branches">
          <SectionNotice
            kind={branchResult.failed ? 'error' : 'empty'}
            detail="An active primary branch or explicit Restaurant branch assignment is required."
          />
        </SectionCard>
      </div>
    );
  }

  const today = isoDate(new Date());
  const weekAgo = new Date(`${today}T00:00:00.000Z`);
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 6);
  const from = validDate(queryValue(query.from), isoDate(weekAgo));
  const to = validDate(queryValue(query.to), today);
  const requestedBranch = queryValue(query.branch);
  const canAllBranches = branchResult.data?.canAllBranches ?? false;
  const branch =
    requestedBranch === 'all' && canAllBranches
      ? 'all'
      : (branches.find((item) => item.id === requestedBranch)?.id ?? branches[0]!.id);
  const rangeInput = { ...(branch === 'all' ? {} : { branchId: branch }), from, to };
  const posEnabled = hasModule(ctx.entitlements, 'restaurant-pos');
  const inventoryEnabled = hasModule(ctx.entitlements, 'restaurant-inventory');
  const stockLocationsResult =
    canOperational && inventoryEnabled
      ? await settled(() => caller.stockLocations(branch === 'all' ? {} : { branchId: branch }))
      : { data: null, failed: false };
  const stockLocations = stockLocationsResult.data ?? [];
  const requestedStockLocation = queryValue(query.stockLocation);
  const stockLocationId = stockLocations.find(
    (location) => location.id === requestedStockLocation
  )?.id;
  const stockRangeInput = {
    ...rangeInput,
    ...(stockLocationId ? { stockLocationId } : {}),
  };

  const [overview, payments, inventory, wastage, stockMovements, purchasing, workforce, sop] =
    await Promise.all([
      canOperational && posEnabled
        ? settled(() => caller.overview(rangeInput))
        : Promise.resolve({ data: null, failed: false }),
      canFinancial && posEnabled
        ? settled(() => caller.payments(rangeInput))
        : Promise.resolve({ data: null, failed: false }),
      canOperational && inventoryEnabled
        ? settled(() => caller.inventory(rangeInput))
        : Promise.resolve({ data: null, failed: false }),
      canOperational && inventoryEnabled
        ? settled(() => caller.wastage(stockRangeInput))
        : Promise.resolve({ data: null, failed: false }),
      canOperational && inventoryEnabled
        ? settled(() => caller.stockMovements(stockRangeInput))
        : Promise.resolve({ data: null, failed: false }),
      canOperational && hasModule(ctx.entitlements, 'restaurant-purchasing')
        ? settled(() => caller.purchasing(rangeInput))
        : Promise.resolve({ data: null, failed: false }),
      canOperational && hasModule(ctx.entitlements, 'restaurant-workforce')
        ? settled(() =>
            canFinancial && canWorkforceRates
              ? caller.workforceFinancial(rangeInput)
              : caller.workforce(rangeInput)
          )
        : Promise.resolve({ data: null, failed: false }),
      canOperational && hasModule(ctx.entitlements, 'restaurant-sop')
        ? settled(() => caller.sop(rangeInput))
        : Promise.resolve({ data: null, failed: false }),
    ]);
  const exportBranch = branch;
  const freshness = overview.data?.freshness ?? payments.data?.freshness;
  const freshnessDisplay = freshness ? freshnessCopy(freshness.status) : null;

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Reports"
        description="Closed-day operational ledgers for Essentials. Advanced Insights remains a separately licensed workspace."
        actions={
          hasModule(ctx.entitlements, 'restaurant-insights') ? (
            <Link className={buttonVariants({ variant: 'secondary' })} href="/restaurant/insights">
              Open Advanced Insights
            </Link>
          ) : undefined
        }
      />

      <SectionCard eyebrow="Maximum 90 days" title="Report filters" titleLevel={2}>
        <form className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" method="get">
          <label className="text-sm text-text-body">
            Branch
            <select className={selectClass} defaultValue={branch} name="branch">
              {canAllBranches ? <option value="all">All active branches</option> : null}
              {branches.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {canOperational && inventoryEnabled ? (
            <label className="text-sm text-text-body">
              Stock location
              <select
                className={selectClass}
                defaultValue={stockLocationId ?? 'all'}
                name="stockLocation"
              >
                <option value="all">All stock locations</option>
                {stockLocations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {branch === 'all' ? `${location.branch.name} — ` : ''}
                    {location.name}
                    {location.isActive ? '' : ' (inactive)'}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="text-sm text-text-body">
            From closed day
            <Input className="mt-1 min-h-11" defaultValue={from} name="from" type="date" />
          </label>
          <label className="text-sm text-text-body">
            To closed day
            <Input className="mt-1 min-h-11" defaultValue={to} name="to" type="date" />
          </label>
          <Button className="min-h-11 self-end" type="submit">
            Apply filters
          </Button>
        </form>
        {freshness && freshnessDisplay ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border-subtle pt-4 text-sm text-text-muted">
            <StatusPill status={freshnessDisplay.label} tone={freshnessDisplay.tone} />
            <span>
              {freshness.closedDayCount}/{freshness.expectedDayCount} branch-days closed
            </span>
            {freshness.staleDayCount ? (
              <span>{freshness.staleDayCount} stale projections</span>
            ) : null}
            {freshness.correctedDayCount ? (
              <span>{freshness.correctedDayCount} corrected chain tips</span>
            ) : null}
          </div>
        ) : null}
      </SectionCard>

      <SectionCard
        actions={
          canOperational && overview.data ? (
            <ExportLink section="overview" branch={exportBranch} from={from} to={to} />
          ) : undefined
        }
        eyebrow="Closed-day chain tips"
        title="Overview"
        titleLevel={2}
      >
        {!posEnabled ? (
          <SectionNotice
            kind="module"
            detail="Restaurant POS is required for closed-day orders, covers and item mix."
          />
        ) : !canOperational ? (
          <SectionNotice
            kind="permission"
            detail="reports:operational is required for orders, covers and item mix."
          />
        ) : overview.failed ? (
          <SectionNotice
            kind="error"
            detail="Check the date range and branch access, then try again."
          />
        ) : overview.data ? (
          <>
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
              <Stat label="Orders" value={displayNumber(overview.data.orderCount)} />
              <Stat label="Covers" value={displayNumber(overview.data.coverCount)} />
              <Stat
                label="Gross sales"
                value={
                  canFinancial && payments.data
                    ? displayNumber(payments.data.grossSales)
                    : 'Restricted'
                }
                sub={!canFinancial ? 'reports:financial required' : undefined}
              />
              <Stat
                label="Net sales"
                value={
                  canFinancial && payments.data
                    ? displayNumber(payments.data.netSales)
                    : 'Restricted'
                }
                sub={!canFinancial ? 'reports:financial required' : undefined}
              />
              <Stat
                label="Average check"
                value={
                  canFinancial && payments.data
                    ? displayNumber(payments.data.averageCheck)
                    : 'Restricted'
                }
              />
              <Stat
                label="Comps"
                value={
                  canFinancial && payments.data
                    ? displayNumber(payments.data.compTotal)
                    : 'Restricted'
                }
              />
              <Stat
                label="Refunds"
                value={
                  canFinancial && payments.data
                    ? displayNumber(payments.data.refundTotal)
                    : 'Restricted'
                }
              />
              <Stat
                label="Voids"
                value={
                  canFinancial && payments.data
                    ? displayNumber(payments.data.voidTotal)
                    : 'Restricted'
                }
              />
            </div>
            <div className="mt-6 border-t border-border-subtle pt-5">
              <h3 className="mb-3 font-semibold text-text-strong">Top items</h3>
              {overview.data.topItems.length ? (
                <TableFrame label="Top Restaurant items">
                  <table className="w-full min-w-[32rem] text-left text-sm">
                    <thead className="bg-surface-sunken font-mono text-xs uppercase tracking-wider text-text-muted">
                      <tr>
                        <th className="p-3">Item</th>
                        <th className="p-3 text-right">Quantity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.data.topItems.map((item) => (
                        <tr className="border-t border-border-subtle" key={item.productId}>
                          <td className="p-3 text-text-strong">{item.productName}</td>
                          <td className="p-3 text-right tabular-nums">
                            {displayNumber(item.quantity)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableFrame>
              ) : (
                <SectionNotice
                  kind="empty"
                  detail="No current item-mix projection matches the selected closed days."
                />
              )}
            </div>
          </>
        ) : null}
      </SectionCard>

      <SectionCard
        actions={
          payments.data ? (
            <ExportLink section="payments" branch={exportBranch} from={from} to={to} />
          ) : undefined
        }
        eyebrow="reports:financial"
        title="Payments & tax"
        titleLevel={2}
      >
        {!posEnabled ? (
          <SectionNotice
            kind="module"
            detail="Restaurant POS is required for payment and tax totals."
          />
        ) : !canFinancial ? (
          <SectionNotice
            kind="permission"
            detail="reports:financial is required for money, payment and tax totals."
          />
        ) : payments.failed ? (
          <SectionNotice kind="error" detail="Financial close totals could not be loaded." />
        ) : payments.data ? (
          <>
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
              <Stat label="Tax" value={displayNumber(payments.data.taxTotal)} />
              <Stat label="Service" value={displayNumber(payments.data.serviceChargeTotal)} />
              <Stat
                label="Delivery fee sales"
                value={displayNumber(payments.data.deliveryFeeSales)}
              />
              <Stat
                label="Delivery fee refunds"
                value={displayNumber(payments.data.deliveryFeeRefunds)}
              />
              <Stat label="Tips" value={displayNumber(payments.data.tipTotal)} />
              <Stat label="Discounts" value={displayNumber(payments.data.discountTotal)} />
              <Stat label="Cash expected" value={displayNumber(payments.data.cashExpected)} />
              <Stat label="Cash counted" value={displayNumber(payments.data.cashCounted)} />
              <Stat label="Drawer variance" value={displayNumber(payments.data.cashVariance)} />
            </div>
            {payments.data.tenders.length ? (
              <div className="mt-6">
                <TableFrame label="Tender totals">
                  <table className="w-full min-w-[36rem] text-left text-sm">
                    <thead className="bg-surface-sunken font-mono text-xs uppercase tracking-wider text-text-muted">
                      <tr>
                        <th className="p-3">Tender</th>
                        <th className="p-3 text-right">Count</th>
                        <th className="p-3 text-right">Amount</th>
                        <th className="p-3 text-right">Tips</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.data.tenders.map((tender) => (
                        <tr className="border-t border-border-subtle" key={tender.tenderType}>
                          <td className="p-3 text-text-strong">{tender.tenderType}</td>
                          <td className="p-3 text-right tabular-nums">{tender.count}</td>
                          <td className="p-3 text-right tabular-nums">
                            {displayNumber(tender.amount)}
                          </td>
                          <td className="p-3 text-right tabular-nums">
                            {displayNumber(tender.tipAmount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableFrame>
              </div>
            ) : null}
          </>
        ) : null}
      </SectionCard>

      <SectionCard
        actions={
          inventory.data ? (
            <ExportLink section="inventory" branch={exportBranch} from={from} to={to} />
          ) : undefined
        }
        eyebrow="Immutable stock movements"
        title="Inventory"
        titleLevel={2}
      >
        {!hasModule(ctx.entitlements, 'restaurant-inventory') ? (
          <SectionNotice
            kind="module"
            detail="Enable Restaurant Inventory to expose on-hand and stock-ledger reporting."
          />
        ) : !canOperational ? (
          <SectionNotice kind="permission" detail="reports:operational is required." />
        ) : inventory.failed ? (
          <SectionNotice kind="error" detail="Inventory read models could not be loaded." />
        ) : inventory.data ? (
          <>
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
              <Stat label="Valuation" value={displayNumber(inventory.data.valuation)} />
              <Stat label="Negative stock" value={inventory.data.negativeStockCount} />
              <Stat label="Low stock" value={inventory.data.lowStockCount} />
              <Stat
                label="Wastage movements"
                value={inventory.data.wastage.movementCount}
                sub={`${inventory.data.wastage.quantity} units`}
              />
            </div>
            {inventory.data.truncated ? (
              <div className="mt-5">
                <DetailLimitNotice
                  detail={`Each inventory detail list shows the first ${MAX_INTERACTIVE_ROWS.toLocaleString()} rows in deterministic order; the totals above use the complete filtered ledger.`}
                />
              </div>
            ) : null}
            {inventory.data.onHand.length ? (
              <div className="mt-6">
                <TableFrame label="Inventory on hand">
                  <table className="w-full min-w-[44rem] text-left text-sm">
                    <thead className="bg-surface-sunken font-mono text-xs uppercase tracking-wider text-text-muted">
                      <tr>
                        <th className="p-3">Ingredient</th>
                        <th className="p-3">Location</th>
                        <th className="p-3 text-right">On hand</th>
                        <th className="p-3 text-right">WAC</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inventory.data.onHand.map((row) => (
                        <tr
                          className="border-t border-border-subtle"
                          key={`${row.branchId}:${row.stockItemId}:${row.locationId}`}
                        >
                          <td className="p-3 text-text-strong">{row.ingredientName}</td>
                          <td className="p-3 text-text-muted">{row.locationName}</td>
                          <td className="p-3 text-right tabular-nums">
                            {displayNumber(row.onHand)}
                          </td>
                          <td className="p-3 text-right tabular-nums">
                            {displayNumber(row.weightedAverageCost)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableFrame>
              </div>
            ) : (
              <SectionNotice
                kind="empty"
                detail="No stock movements have established an on-hand balance."
              />
            )}
            <div className="mt-6 border-t border-border-subtle pt-5">
              <h3 className="mb-3 font-semibold text-text-strong">Stock movements</h3>
              {inventory.data.movements.length ? (
                <TableFrame label="Filtered stock movements">
                  <table className="w-full min-w-[44rem] text-left text-sm">
                    <thead className="bg-surface-sunken font-mono text-xs uppercase tracking-wider text-text-muted">
                      <tr>
                        <th className="p-3">Occurred</th>
                        <th className="p-3">Reason</th>
                        <th className="p-3 text-right">Quantity</th>
                        <th className="p-3 text-right">Unit cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inventory.data.movements.map((movement) => (
                        <tr className="border-t border-border-subtle" key={movement.id}>
                          <td className="p-3 font-mono text-xs text-text-muted">
                            {movement.occurredAt.replace('T', ' ').slice(0, 16)} UTC
                          </td>
                          <td className="p-3 text-text-strong">{movement.reason}</td>
                          <td className="p-3 text-right tabular-nums">
                            {displayNumber(movement.quantity)}
                          </td>
                          <td className="p-3 text-right tabular-nums text-text-muted">
                            {movement.unitCost === null ? '—' : displayNumber(movement.unitCost)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableFrame>
              ) : (
                <p className="text-sm text-text-muted">
                  No stock movements match the selected date range.
                </p>
              )}
            </div>
          </>
        ) : null}
      </SectionCard>

      <StockReportTabs
        wastage={
          <SectionCard
            actions={
              wastage.data ? (
                <ExportLink
                  section="wastage"
                  branch={exportBranch}
                  from={from}
                  to={to}
                  stockLocationId={stockLocationId}
                />
              ) : undefined
            }
            eyebrow="Cost-valued stock loss"
            title="Wastage"
            titleLevel={2}
          >
            {!inventoryEnabled ? (
              <SectionNotice
                kind="module"
                detail="Enable Restaurant Inventory to expose wastage reporting."
              />
            ) : !canOperational ? (
              <SectionNotice kind="permission" detail="reports:operational is required." />
            ) : stockLocationsResult.failed || wastage.failed ? (
              <SectionNotice kind="error" detail="Wastage totals could not be loaded." />
            ) : wastage.data && wastage.data.totals.movementCount > 0 ? (
              <>
                <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
                  <Stat label="Movements" value={wastage.data.totals.movementCount} />
                  <Stat label="Canonical quantity" value={wastage.data.totals.quantity} />
                  <Stat label="Wastage cost" value={displayNumber(wastage.data.totals.cost)} />
                  <Stat
                    label="Estimated cost"
                    value={displayNumber(wastage.data.totals.estimatedCost)}
                    sub={`${wastage.data.totals.estimatedMovementCount} movements`}
                  />
                </div>
                {wastage.data.totals.estimatedMovementCount ? (
                  <div className="mt-5 flex flex-wrap items-center gap-3 rounded-sm border border-border-default bg-surface-sunken px-4 py-3 text-sm text-text-muted">
                    <StatusPill status="Estimated valuation" tone="warning" />
                    <span>
                      Missing movement costs use the current weighted-average cost, then the
                      ingredient reference cost.
                    </span>
                    {wastage.data.totals.unvaluedMovementCount ? (
                      <span>
                        {wastage.data.totals.unvaluedMovementCount} movements have no available
                        cost.
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {wastage.data.truncated ? (
                  <div className="mt-5">
                    <DetailLimitNotice
                      detail={`Showing the first ${MAX_INTERACTIVE_ROWS.toLocaleString()} ingredients; totals and reason/day groups use every matching movement.`}
                    />
                  </div>
                ) : null}
                <div className="mt-6 grid gap-6 xl:grid-cols-2">
                  <div>
                    <h3 className="mb-3 font-semibold text-text-strong">By reason</h3>
                    <TableFrame label="Wastage by reason">
                      <table className="w-full min-w-[30rem] text-left text-sm">
                        <thead className="bg-surface-sunken font-mono text-xs uppercase tracking-wider text-text-muted">
                          <tr>
                            <th className="p-3">Reason</th>
                            <th className="p-3 text-right">Quantity</th>
                            <th className="p-3 text-right">Cost</th>
                            <th className="p-3 text-right">Share</th>
                          </tr>
                        </thead>
                        <tbody>
                          {wastage.data.byReason.map((row) => (
                            <tr className="border-t border-border-subtle" key={row.reason}>
                              <td className="p-3 text-text-strong">
                                {row.reason.replaceAll('_', ' ')}
                              </td>
                              <td className="p-3 text-right tabular-nums">{row.quantity}</td>
                              <td className="p-3 text-right tabular-nums">
                                {displayNumber(row.cost)}
                              </td>
                              <td className="p-3 text-right tabular-nums">{row.shareOfTotal}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableFrame>
                  </div>
                  <div>
                    <h3 className="mb-3 font-semibold text-text-strong">By day</h3>
                    <TableFrame label="Wastage by day">
                      <table className="w-full min-w-[30rem] text-left text-sm">
                        <thead className="bg-surface-sunken font-mono text-xs uppercase tracking-wider text-text-muted">
                          <tr>
                            <th className="p-3">Day</th>
                            <th className="p-3 text-right">Quantity</th>
                            <th className="p-3 text-right">Cost</th>
                            <th className="p-3 text-right">Share</th>
                          </tr>
                        </thead>
                        <tbody>
                          {wastage.data.byDay.map((row) => (
                            <tr className="border-t border-border-subtle" key={row.day}>
                              <td className="p-3 font-mono text-xs text-text-muted">{row.day}</td>
                              <td className="p-3 text-right tabular-nums">{row.quantity}</td>
                              <td className="p-3 text-right tabular-nums">
                                {displayNumber(row.cost)}
                              </td>
                              <td className="p-3 text-right tabular-nums">{row.shareOfTotal}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableFrame>
                  </div>
                </div>
                <div className="mt-6 border-t border-border-subtle pt-5">
                  <h3 className="mb-3 font-semibold text-text-strong">By ingredient</h3>
                  <TableFrame label="Wastage by ingredient">
                    <table className="w-full min-w-[44rem] text-left text-sm">
                      <thead className="bg-surface-sunken font-mono text-xs uppercase tracking-wider text-text-muted">
                        <tr>
                          <th className="p-3">Ingredient</th>
                          <th className="p-3">Unit</th>
                          <th className="p-3 text-right">Quantity</th>
                          <th className="p-3 text-right">Cost</th>
                          <th className="p-3 text-right">Share</th>
                          <th className="p-3">Valuation</th>
                        </tr>
                      </thead>
                      <tbody>
                        {wastage.data.byIngredient.map((row) => (
                          <tr className="border-t border-border-subtle" key={row.stockItemId}>
                            <td className="p-3 text-text-strong">{row.ingredientName}</td>
                            <td className="p-3 text-text-muted">{row.canonicalUnit}</td>
                            <td className="p-3 text-right tabular-nums">{row.quantity}</td>
                            <td className="p-3 text-right tabular-nums">
                              {displayNumber(row.cost)}
                            </td>
                            <td className="p-3 text-right tabular-nums">{row.shareOfTotal}%</td>
                            <td className="p-3 text-text-muted">
                              {row.estimated ? 'Includes estimates' : 'Recorded'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableFrame>
                </div>
              </>
            ) : (
              <SectionNotice
                kind="empty"
                detail="No wastage, spoilage, staff meal or negative manual-correction movements match these filters."
              />
            )}
          </SectionCard>
        }
        movements={
          <SectionCard
            actions={
              stockMovements.data ? (
                <ExportLink
                  section="stock-movements"
                  branch={exportBranch}
                  from={from}
                  to={to}
                  stockLocationId={stockLocationId}
                />
              ) : undefined
            }
            eyebrow="Opening, inflow, outflow and closing"
            title="Stock movement"
            titleLevel={2}
          >
            {!inventoryEnabled ? (
              <SectionNotice
                kind="module"
                detail="Enable Restaurant Inventory to expose stock-movement reporting."
              />
            ) : !canOperational ? (
              <SectionNotice kind="permission" detail="reports:operational is required." />
            ) : stockLocationsResult.failed || stockMovements.failed ? (
              <SectionNotice kind="error" detail="Stock-movement totals could not be loaded." />
            ) : stockMovements.data && stockMovements.data.totals.movementCount > 0 ? (
              <>
                <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
                  <Stat label="Movements" value={stockMovements.data.totals.movementCount} />
                  <Stat
                    label="Inflow cost"
                    value={displayNumber(stockMovements.data.totals.inCost)}
                  />
                  <Stat
                    label="Outflow cost"
                    value={displayNumber(stockMovements.data.totals.outCost)}
                  />
                  <Stat
                    label="Net cost"
                    value={displayNumber(stockMovements.data.totals.netCost)}
                  />
                </div>
                {stockMovements.data.totals.estimatedMovementCount ? (
                  <div className="mt-5 flex flex-wrap items-center gap-3 rounded-sm border border-border-default bg-surface-sunken px-4 py-3 text-sm text-text-muted">
                    <StatusPill status="Estimated valuation" tone="warning" />
                    <span>
                      {stockMovements.data.totals.estimatedMovementCount} movements use current
                      weighted-average or reference cost.
                    </span>
                    {stockMovements.data.totals.unvaluedMovementCount ? (
                      <span>
                        {stockMovements.data.totals.unvaluedMovementCount} movements have no
                        available cost.
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {stockMovements.data.truncated ? (
                  <div className="mt-5">
                    <DetailLimitNotice
                      detail={`Showing the first ${MAX_INTERACTIVE_ROWS.toLocaleString()} ingredients; totals use the complete filtered ledger.`}
                    />
                  </div>
                ) : null}
                <div className="mt-6">
                  <TableFrame label="Stock movement by ingredient">
                    <table className="w-full min-w-[80rem] text-left text-sm">
                      <thead className="bg-surface-sunken font-mono text-xs uppercase tracking-wider text-text-muted">
                        <tr>
                          <th className="p-3">Ingredient</th>
                          <th className="p-3">Unit</th>
                          <th className="p-3 text-right">Opening</th>
                          <th className="p-3 text-right">In</th>
                          <th className="p-3 text-right">Out</th>
                          <th className="p-3 text-right">Net</th>
                          <th className="p-3 text-right">Closing</th>
                          <th className="p-3 text-right">In cost</th>
                          <th className="p-3 text-right">Out cost</th>
                          <th className="p-3 text-right">Share</th>
                          <th className="p-3">Valuation</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stockMovements.data.ingredients.map((row) => (
                          <tr className="border-t border-border-subtle" key={row.stockItemId}>
                            <td className="p-3 text-text-strong">{row.ingredientName}</td>
                            <td className="p-3 text-text-muted">{row.canonicalUnit}</td>
                            <td className="p-3 text-right tabular-nums">{row.openingQuantity}</td>
                            <td className="p-3 text-right tabular-nums">{row.inQuantity}</td>
                            <td className="p-3 text-right tabular-nums">{row.outQuantity}</td>
                            <td className="p-3 text-right tabular-nums">{row.netQuantity}</td>
                            <td className="p-3 text-right tabular-nums">{row.closingQuantity}</td>
                            <td className="p-3 text-right tabular-nums">
                              {displayNumber(row.inCost)}
                            </td>
                            <td className="p-3 text-right tabular-nums">
                              {displayNumber(row.outCost)}
                            </td>
                            <td className="p-3 text-right tabular-nums">{row.shareOfTotal}%</td>
                            <td className="p-3 text-text-muted">
                              {row.estimated ? 'Includes estimates' : 'Recorded'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableFrame>
                </div>
              </>
            ) : (
              <SectionNotice
                kind="empty"
                detail="No stock movements match the selected period and location."
              />
            )}
          </SectionCard>
        }
      />

      <SectionCard
        actions={
          purchasing.data ? (
            <ExportLink section="purchasing" branch={exportBranch} from={from} to={to} />
          ) : undefined
        }
        eyebrow="PO and receipt ledgers"
        title="Purchasing"
        titleLevel={2}
      >
        {!hasModule(ctx.entitlements, 'restaurant-purchasing') ? (
          <SectionNotice
            kind="module"
            detail="Restaurant Purchasing is not included in this organization’s current package."
          />
        ) : !canOperational ? (
          <SectionNotice kind="permission" detail="reports:operational is required." />
        ) : purchasing.failed ? (
          <SectionNotice kind="error" detail="Purchasing read models could not be loaded." />
        ) : purchasing.data ? (
          <>
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-5">
              <Stat label="Purchase orders" value={purchasing.data.purchaseOrderCount} />
              <Stat label="PO value" value={displayNumber(purchasing.data.purchaseOrderValue)} />
              <Stat label="Receipts" value={purchasing.data.receiptCount} />
              <Stat
                label="Supplier spend"
                value={displayNumber(purchasing.data.receivedSupplierSpend)}
              />
              <Stat label="Discrepancies" value={purchasing.data.discrepancyCount} />
            </div>
            <div className="mt-6 grid gap-6 xl:grid-cols-2">
              <div>
                <h3 className="mb-3 font-semibold text-text-strong">Purchase order status</h3>
                {Object.keys(purchasing.data.statusCounts).length ? (
                  <TableFrame label="Purchase order status counts">
                    <table className="w-full min-w-[22rem] text-left text-sm">
                      <thead className="bg-surface-sunken font-mono text-xs uppercase tracking-wider text-text-muted">
                        <tr>
                          <th className="p-3">Status</th>
                          <th className="p-3 text-right">Orders</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(purchasing.data.statusCounts).map(([status, count]) => (
                          <tr className="border-t border-border-subtle" key={status}>
                            <td className="p-3 text-text-strong">{status.replaceAll('_', ' ')}</td>
                            <td className="p-3 text-right tabular-nums">{count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableFrame>
                ) : (
                  <p className="text-sm text-text-muted">No purchase orders match this range.</p>
                )}
              </div>
              <div>
                <h3 className="mb-3 font-semibold text-text-strong">Receiving discrepancies</h3>
                {purchasing.data.truncated ? (
                  <div className="mb-3">
                    <DetailLimitNotice
                      detail={`Showing the first ${MAX_INTERACTIVE_ROWS.toLocaleString()} discrepancies; the count above uses every matching receipt.`}
                    />
                  </div>
                ) : null}
                {purchasing.data.discrepancies.length ? (
                  <TableFrame label="Receiving discrepancies">
                    <table className="w-full min-w-[32rem] text-left text-sm">
                      <thead className="bg-surface-sunken font-mono text-xs uppercase tracking-wider text-text-muted">
                        <tr>
                          <th className="p-3">Received</th>
                          <th className="p-3">Supplier</th>
                          <th className="p-3">Kind</th>
                        </tr>
                      </thead>
                      <tbody>
                        {purchasing.data.discrepancies.map((item) => (
                          <tr className="border-t border-border-subtle" key={item.id}>
                            <td className="p-3 font-mono text-xs text-text-muted">
                              {item.receivedAt.slice(0, 10)}
                            </td>
                            <td className="p-3 text-text-strong">{item.supplierName}</td>
                            <td className="p-3 text-text-muted">
                              {item.kind.replaceAll('_', ' ')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableFrame>
                ) : (
                  <p className="text-sm text-text-muted">
                    No receiving discrepancies match this range.
                  </p>
                )}
              </div>
            </div>
          </>
        ) : null}
      </SectionCard>

      <SectionCard
        actions={
          workforce.data ? (
            <ExportLink section="workforce" branch={exportBranch} from={from} to={to} />
          ) : undefined
        }
        eyebrow="Roster only"
        title="Workforce"
        titleLevel={2}
      >
        {!hasModule(ctx.entitlements, 'restaurant-workforce') ? (
          <SectionNotice
            kind="module"
            detail="Enable Restaurant Workforce to expose scheduled roster reporting."
          />
        ) : !canOperational ? (
          <SectionNotice kind="permission" detail="reports:operational is required." />
        ) : workforce.failed ? (
          <SectionNotice kind="error" detail="Scheduled roster data could not be loaded." />
        ) : workforce.data ? (
          <>
            <div className="mb-5">
              <StatusPill status="Scheduled — not attendance" tone="info" />
            </div>
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
              <Stat label="Scheduled shifts" value={workforce.data.scheduledShiftCount} />
              <Stat label="Scheduled hours" value={workforce.data.scheduledHours} />
              <Stat
                label="Labour hours"
                value={
                  workforce.data.labourCostsVisible ? workforce.data.labourHours : 'Restricted'
                }
                sub={
                  !workforce.data.labourCostsVisible
                    ? 'reports:financial + workforce:rates required'
                    : undefined
                }
              />
              <Stat
                label="Labour cost"
                value={
                  workforce.data.labourCostsVisible
                    ? displayNumber(workforce.data.labourCost ?? '0')
                    : 'Restricted'
                }
              />
            </div>
          </>
        ) : null}
      </SectionCard>

      <SectionCard
        actions={
          sop.data ? (
            <ExportLink section="sop" branch={exportBranch} from={from} to={to} />
          ) : undefined
        }
        eyebrow="Existing performance summary"
        title="SOP"
        titleLevel={2}
      >
        {!hasModule(ctx.entitlements, 'restaurant-sop') ? (
          <SectionNotice
            kind="module"
            detail="Enable Restaurant SOP to expose performance reporting."
          />
        ) : !canOperational ? (
          <SectionNotice kind="permission" detail="reports:operational is required." />
        ) : sop.failed ? (
          <SectionNotice kind="error" detail="SOP performance summary could not be loaded." />
        ) : sop.data && sop.data.total > 0 ? (
          <>
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-6">
              <Stat label="Occurrences" value={sop.data.total} />
              <Stat label="On time" value={sop.data.onTime} />
              <Stat label="With proof" value={sop.data.withProof} />
              <Stat label="Verified" value={sop.data.verified} />
              <Stat label="Escalated" value={sop.data.escalated} />
              <Stat label="Performance" value={`${sop.data.performanceScore}%`} />
            </div>
            {sop.data.truncated ? (
              <div className="mt-5">
                <DetailLimitNotice
                  detail={`SOP staff attribution export is limited to ${MAX_EXPORT_ROWS.toLocaleString()} rows; the summary above uses every matching occurrence.`}
                />
              </div>
            ) : null}
          </>
        ) : (
          <SectionNotice
            kind="empty"
            detail="No SOP occurrences match the selected branch and closed-day range."
          />
        )}
      </SectionCard>
    </div>
  );
}
