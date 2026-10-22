import { browserUuid } from '@/lib/browser-uuid';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
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
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { restaurantInventoryRouter } from '@/server/routers/restaurant-inventory';
import { createTRPCContext } from '@/server/trpc';

const route = '/restaurant/inventory';
const description =
  'Stock on hand, movement ledger, physical counts, transfers, and low-stock alerts.';
const inputClass =
  'mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
const nonNegativeDecimal = /^(?:0|\d+(?:\.\d+)?|\.\d+)$/;
const positiveDecimal = /^(?=.*[1-9])(?:0|\d+(?:\.\d+)?|\.\d+)$/;
const field = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
const optionalField = (form: FormData, name: string) => field(form, name) || undefined;

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function destination(notice: string, kind: 'success' | 'error', selected?: string, fresh = false) {
  const params = new URLSearchParams({ notice, kind });
  if (selected) params.set('selected', selected);
  if (fresh) params.set('fresh', browserUuid());
  return `${route}?${params}`;
}

function formatDate(value: Date | string | null | undefined) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value)
  );
}

/**
 * Resolve the tenant actor first, then hand the resolved session and
 * organization to the context factory.
 *
 * `createTRPCContext()` with no argument cannot stand in for this. It forwards
 * `{ request: undefined, session: undefined }` to `resolveTenantActor`, whose
 * `'session' in options` check reads that explicitly-undefined key as "the
 * caller already resolved the session". Auth.js is then never consulted, the
 * organization is always null, and the factory throws `Workspace not found.`
 * as an unhandled Server Component error on every request and every host.
 */
async function tenantContext() {
  const actor = await resolveTenantActor();
  if (!actor) return null;
  return createTRPCContext({
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
}

function AccessState({ moduleEnabled }: { moduleEnabled: boolean }) {
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Restaurant operations" heading="Inventory" description={description} />
      <SectionCard>
        <h2 className="text-lg font-semibold text-text-strong">
          {moduleEnabled ? 'Permission denied' : 'Module disabled'}
        </h2>
        <p className="mt-2 text-sm text-text-muted">
          {moduleEnabled
            ? 'Inventory read permission is required to open the inventory console.'
            : 'Enable the Restaurant Inventory module to use inventory.'}
        </p>
      </SectionCard>
    </div>
  );
}

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; kind?: string; selected?: string; fresh?: string }>;
}) {
  const query = await searchParams;
  const ctx = await tenantContext();
  // Tenancy did not resolve. Entitlements are unknowable here, so show the
  // permission surface rather than let a missing workspace reach the user as an
  // unhandled Server Component crash.
  if (!ctx) return <AccessState moduleEnabled={false} />;

  const user = ctx.session?.user;
  const moduleEnabled = hasModule(ctx.entitlements, 'restaurant-inventory');

  if (!user) return <AccessState moduleEnabled={moduleEnabled} />;

  const subject = subjectFromSession(user);
  const [readable, countable, adjustable, wasteable] = await Promise.all([
    can(subject, 'inventory:read', undefined, { db: ctx.db, source: 'TRPC' }),
    can(subject, 'inventory:count', undefined, { db: ctx.db, source: 'TRPC' }),
    can(subject, 'inventory:adjust', undefined, { db: ctx.db, source: 'TRPC' }),
    can(subject, 'inventory:waste', undefined, { db: ctx.db, source: 'TRPC' }),
  ]);

  if (!moduleEnabled || !readable) return <AccessState moduleEnabled={moduleEnabled} />;

  const caller = restaurantInventoryRouter.createCaller(ctx);
  let loaded;
  try {
    const [onHand, lowStock, movements, counts, transfers, locations, stockItems] =
      await Promise.all([
        caller.listStockOnHand({}),
        caller.evaluateLowStockRules({}),
        caller.listStockMovements({ limit: 25 }),
        caller.listStockCounts({ limit: 25 }),
        caller.listStockTransfers({ limit: 25 }),
        ctx.db.restaurantStockLocation.findMany({
          where: { isActive: true },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        }),
        ctx.db.restaurantStockItem.findMany({
          where: { isActive: true },
          orderBy: { ingredient: { name: 'asc' } },
          select: { id: true, ingredient: { select: { name: true } } },
        }),
      ]);
    const selectedSummary =
      counts.items.find((count) => count.id === query.selected) ?? counts.items[0] ?? null;
    const selectedCount = selectedSummary
      ? await ctx.db.restaurantStockCount.findFirst({
          where: { id: selectedSummary.id },
          select: {
            id: true,
            locationId: true,
            status: true,
            reference: true,
            countedAt: true,
            submittedAt: true,
            postedAt: true,
            lines: {
              orderBy: { createdAt: 'asc' },
              select: {
                id: true,
                stockItemId: true,
                countedQuantity: true,
                snapshotQuantity: true,
                varianceQuantity: true,
              },
            },
          },
        })
      : null;
    loaded = {
      onHand,
      lowStock,
      movements,
      counts,
      transfers,
      locations,
      stockItems,
      selectedCount,
    };
  } catch {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Restaurant operations" heading="Inventory" description={description} />
        <SectionCard>
          <h2 className="text-lg font-semibold text-text-strong">Inventory could not load</h2>
          <p className="mt-2 text-sm text-text-muted">
            No data was changed. Refresh the page to try again.
          </p>
          <Link className={buttonVariants({ variant: 'secondary' })} href={route}>
            Retry
          </Link>
        </SectionCard>
      </div>
    );
  }

  async function createCount(form: FormData) {
    'use server';
    let next: string;
    try {
      const actionCtx = await tenantContext();
      if (!actionCtx?.session?.user) throw new Error('Your session is no longer active.');
      const locationId = field(form, 'locationId');
      const location = await actionCtx.db.restaurantStockLocation.findFirst({
        where: { id: locationId, isActive: true },
        select: { id: true },
      });
      if (!location) throw new Error('Select a current stock location.');
      const count = await restaurantInventoryRouter.createCaller(actionCtx).createStockCount({
        locationId: location.id,
        reference: optionalField(form, 'reference'),
      });
      next = destination('Physical count created.', 'success', count.id);
    } catch (error) {
      next = destination(message(error, 'Could not create the physical count.'), 'error');
    }
    redirect(next);
  }

  async function addCountLine(form: FormData) {
    'use server';
    const stockCountId = field(form, 'stockCountId');
    let next: string;
    try {
      const actionCtx = await tenantContext();
      if (!actionCtx?.session?.user) throw new Error('Your session is no longer active.');
      const stockItemId = field(form, 'stockItemId');
      const countedQuantity = field(form, 'countedQuantity');
      if (!stockItemId) throw new Error('Select a stock item.');
      if (!nonNegativeDecimal.test(countedQuantity)) {
        throw new Error('Enter a non-negative decimal counted quantity.');
      }
      const stockItem = await actionCtx.db.restaurantStockItem.findFirst({
        where: { id: stockItemId, isActive: true },
        select: { id: true },
      });
      if (!stockItem) throw new Error('Select a current stock item.');
      await restaurantInventoryRouter.createCaller(actionCtx).addStockCountLine({
        stockCountId,
        stockItemId: stockItem.id,
        countedQuantity,
      });
      next = destination('Count line added.', 'success', stockCountId, true);
    } catch (error) {
      next = destination(message(error, 'Could not add the count line.'), 'error', stockCountId);
    }
    redirect(next);
  }

  async function submitCount(form: FormData) {
    'use server';
    const stockCountId = field(form, 'stockCountId');
    let next: string;
    try {
      const actionCtx = await tenantContext();
      if (!actionCtx?.session?.user) throw new Error('Your session is no longer active.');
      await restaurantInventoryRouter.createCaller(actionCtx).submitStockCount({ stockCountId });
      next = destination('Count submitted and quantities frozen.', 'success', stockCountId);
    } catch (error) {
      next = destination(message(error, 'Could not submit the count.'), 'error', stockCountId);
    }
    redirect(next);
  }

  async function postCount(form: FormData) {
    'use server';
    const stockCountId = field(form, 'stockCountId');
    let next: string;
    try {
      const actionCtx = await tenantContext();
      if (!actionCtx?.session?.user) throw new Error('Your session is no longer active.');
      await restaurantInventoryRouter.createCaller(actionCtx).postStockCount({ stockCountId });
      next = destination('Reconciliation posted to inventory.', 'success', stockCountId);
    } catch (error) {
      next = destination(
        message(error, 'Could not post the reconciliation.'),
        'error',
        stockCountId
      );
    }
    redirect(next);
  }

  async function recordWastage(form: FormData) {
    'use server';
    let next: string;
    try {
      const actionCtx = await tenantContext();
      if (!actionCtx?.session?.user) throw new Error('Your session is no longer active.');
      await restaurantInventoryRouter.createCaller(actionCtx).postWastage({
        stockItemId: field(form, 'stockItemId'),
        locationId: field(form, 'locationId'),
        reason: field(form, 'reason') as 'WASTAGE' | 'SPOILAGE' | 'STAFF_MEAL',
        quantity: field(form, 'quantity'),
      });
      next = destination('Wastage movement recorded.', 'success');
    } catch (error) {
      next = destination(message(error, 'Could not record wastage.'), 'error');
    }
    redirect(next);
  }

  async function createTransfer(form: FormData) {
    'use server';
    let next: string;
    try {
      const actionCtx = await tenantContext();
      if (!actionCtx?.session?.user) throw new Error('Your session is no longer active.');
      await restaurantInventoryRouter.createCaller(actionCtx).createStockTransfer({
        sourceLocationId: field(form, 'sourceLocationId'),
        destinationLocationId: field(form, 'destinationLocationId'),
        reference: optionalField(form, 'reference'),
      });
      next = destination('Stock transfer created.', 'success');
    } catch (error) {
      next = destination(message(error, 'Could not create the stock transfer.'), 'error');
    }
    redirect(next);
  }

  async function recordSaleReversal(form: FormData) {
    'use server';
    let next: string;
    try {
      const actionCtx = await tenantContext();
      if (!actionCtx?.session?.user) throw new Error('Your session is no longer active.');
      await restaurantInventoryRouter.createCaller(actionCtx).postSaleReversal({
        stockItemId: field(form, 'stockItemId'),
        locationId: field(form, 'locationId'),
        quantity: field(form, 'quantity'),
        orderId: optionalField(form, 'orderId'),
      });
      next = destination('Sale reversal recorded.', 'success');
    } catch (error) {
      next = destination(message(error, 'Could not record the sale reversal.'), 'error');
    }
    redirect(next);
  }

  async function addTransferLine(form: FormData) {
    'use server';
    let next: string;
    try {
      const actionCtx = await tenantContext();
      if (!actionCtx?.session?.user) throw new Error('Your session is no longer active.');
      await restaurantInventoryRouter.createCaller(actionCtx).addStockTransferLine({
        stockTransferId: field(form, 'stockTransferId'),
        stockItemId: field(form, 'stockItemId'),
        quantity: field(form, 'quantity'),
      });
      next = destination('Transfer line added.', 'success');
    } catch (error) {
      next = destination(message(error, 'Could not add the transfer line.'), 'error');
    }
    redirect(next);
  }

  async function completeTransfer(form: FormData) {
    'use server';
    let next: string;
    try {
      const actionCtx = await tenantContext();
      if (!actionCtx?.session?.user) throw new Error('Your session is no longer active.');
      await restaurantInventoryRouter.createCaller(actionCtx).completeStockTransfer({
        stockTransferId: field(form, 'stockTransferId'),
      });
      next = destination('Stock transfer completed.', 'success');
    } catch (error) {
      next = destination(message(error, 'Could not complete the stock transfer.'), 'error');
    }
    redirect(next);
  }

  const locationNames = new Map(loaded.locations.map((l) => [l.id, l.name] as const));
  const stockItemNames = new Map(loaded.stockItems.map((i) => [i.id, i.ingredient.name] as const));
  const itemName = (id: string) => stockItemNames.get(id) ?? 'Unknown stock item';
  const locationName = (id: string) => locationNames.get(id) ?? 'Unknown location';

  const negativePositions = loaded.onHand.filter((row) => row.isNegative).length;
  const triggeredAlerts = loaded.lowStock.filter((flag) => flag.isTriggered).length;
  const openTransfers = loaded.transfers.items.filter((transfer) =>
    ['DRAFT', 'DISPATCHED'].includes(transfer.status)
  ).length;

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Restaurant operations" heading="Inventory" description={description} />

      {query.notice && (
        <div
          className={`rounded-[var(--radius-sm)] border p-3 text-sm ${
            query.kind === 'error'
              ? 'border-destructive bg-destructive-background text-destructive-foreground'
              : 'border-success bg-success-background text-success-foreground'
          }`}
          role={query.kind === 'error' ? 'alert' : 'status'}
        >
          {query.notice}
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Inventory summary">
        <Stat label="Tracked positions" value={loaded.onHand.length} />
        <Stat label="Negative stock" value={negativePositions} />
        <Stat label="Low-stock alerts" value={triggeredAlerts} />
        <Stat label="In-flight transfers" value={openTransfers} />
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <SectionCard>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-text-strong">Stock on hand</h2>
            <span className="font-mono text-xs text-text-muted">
              {loaded.onHand.length} positions
            </span>
          </div>
          <div className="mt-4 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead className="text-right">On hand</TableHead>
                  <TableHead className="text-right">Flag</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loaded.onHand.length ? (
                  loaded.onHand.map((row) => (
                    <TableRow key={`${row.stockItemId}:${row.locationId}`}>
                      <TableCell>{row.ingredientName}</TableCell>
                      <TableCell>{row.locationName}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.onHand}</TableCell>
                      <TableCell className="text-right">
                        {row.isNegative ? (
                          <StatusPill status="Negative" tone="danger" />
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={4} className="py-10 text-center text-text-muted">
                      No stock positions recorded yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </SectionCard>

        <SectionCard data-tour="inventory-low-stock">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-text-strong">Low-stock rules</h2>
            <span className="font-mono text-xs text-text-muted">
              {loaded.lowStock.length} rules
            </span>
          </div>
          <div className="mt-4 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead className="text-right">Threshold</TableHead>
                  <TableHead className="text-right">On hand</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loaded.lowStock.length ? (
                  loaded.lowStock.map((flag) => (
                    <TableRow key={flag.ruleId}>
                      <TableCell>{itemName(flag.stockItemId)}</TableCell>
                      <TableCell>{locationName(flag.locationId)}</TableCell>
                      <TableCell className="text-right tabular-nums">{flag.threshold}</TableCell>
                      <TableCell className="text-right tabular-nums">{flag.onHand}</TableCell>
                      <TableCell className="text-right">
                        <StatusPill
                          status={flag.isTriggered ? 'Low' : 'OK'}
                          tone={flag.isTriggered ? 'warning' : 'success'}
                        />
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10 text-center text-text-muted">
                      No low-stock rules configured.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      </div>

      <SectionCard>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-text-strong">Movement ledger</h2>
          <span className="font-mono text-xs text-text-muted">
            {loaded.movements.items.length} recent
          </span>
        </div>
        <div className="mt-4 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loaded.movements.items.length ? (
                loaded.movements.items.map((movement) => (
                  <TableRow key={movement.id}>
                    <TableCell className="whitespace-nowrap text-text-muted">
                      {formatDate(movement.occurredAt)}
                    </TableCell>
                    <TableCell>{itemName(movement.stockItemId)}</TableCell>
                    <TableCell>{locationName(movement.locationId)}</TableCell>
                    <TableCell>
                      <StatusPill status={movement.reason} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{movement.quantity}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-text-muted">
                    No stock movements recorded yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <SectionCard>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-text-strong">Record wastage</h2>
            <p className="mt-1 text-sm text-text-muted">
              Record wastage, spoilage, or staff meals as an auditable stock movement.
            </p>
          </div>
          <StatusPill
            status={wasteable ? 'Wastage access' : 'Read only'}
            tone={wasteable ? 'success' : 'neutral'}
          />
        </div>
        <form action={recordWastage} className="mt-5 grid gap-3 md:grid-cols-4">
          <label className="text-sm text-text-body">
            Stock item
            <select name="stockItemId" required disabled={!wasteable} className={inputClass}>
              <option value="">Select stock item</option>
              {loaded.stockItems.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.ingredient.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-text-body">
            Location
            <select name="locationId" required disabled={!wasteable} className={inputClass}>
              <option value="">Select location</option>
              {loaded.locations.map((location) => (
                <option value={location.id} key={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-text-body">
            Reason
            <select name="reason" required disabled={!wasteable} className={inputClass}>
              <option value="WASTAGE">Wastage</option>
              <option value="SPOILAGE">Spoilage</option>
              <option value="STAFF_MEAL">Staff meal</option>
            </select>
          </label>
          <label className="text-sm text-text-body">
            Quantity
            <Input
              name="quantity"
              inputMode="decimal"
              pattern={positiveDecimal.source}
              required
              disabled={!wasteable}
              className="mt-1 min-h-11"
            />
          </label>
          <Button
            type="submit"
            disabled={!wasteable || !loaded.stockItems.length || !loaded.locations.length}
            className="min-h-11 md:col-span-4"
          >
            Record wastage movement
          </Button>
        </form>
        <div className="mt-6 border-t border-border-subtle pt-5">
          <h3 className="font-semibold text-text-strong">Record sale reversal</h3>
          <p className="mt-1 text-sm text-text-muted">
            Return sold stock to a location without editing ledger history.
          </p>
          <form action={recordSaleReversal} className="mt-4 grid gap-3 md:grid-cols-4">
            <label className="text-sm text-text-body">
              Stock item
              <select name="stockItemId" required disabled={!adjustable} className={inputClass}>
                <option value="">Select stock item</option>
                {loaded.stockItems.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.ingredient.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-text-body">
              Location
              <select name="locationId" required disabled={!adjustable} className={inputClass}>
                <option value="">Select location</option>
                {loaded.locations.map((location) => (
                  <option value={location.id} key={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-text-body">
              Quantity
              <Input
                name="quantity"
                inputMode="decimal"
                pattern={positiveDecimal.source}
                required
                disabled={!adjustable}
                className="mt-1 min-h-11"
              />
            </label>
            <label className="text-sm text-text-body">
              Order ID (optional)
              <Input name="orderId" disabled={!adjustable} className="mt-1 min-h-11" />
            </label>
            <Button
              type="submit"
              disabled={!adjustable || !loaded.stockItems.length || !loaded.locations.length}
              variant="secondary"
              className="min-h-11 md:col-span-4"
            >
              Record sale reversal
            </Button>
          </form>
        </div>
      </SectionCard>

      <SectionCard>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-text-strong">Start a physical count</h2>
            <p className="mt-1 text-sm text-text-muted">
              Choose a named stock location, then record each item you physically count.
            </p>
          </div>
          <StatusPill
            status={countable ? 'Count access' : 'Read only'}
            tone={countable ? 'success' : 'neutral'}
          />
        </div>
        <form
          action={createCount}
          className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
        >
          <label className="text-sm text-text-body">
            Location
            <select name="locationId" required disabled={!countable} className={inputClass}>
              <option value="">Select location</option>
              {loaded.locations.map((location) => (
                <option value={location.id} key={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-text-body">
            Reference (optional)
            <Input name="reference" disabled={!countable} className="mt-1 min-h-11" />
          </label>
          <Button
            type="submit"
            disabled={!countable || !loaded.locations.length}
            className="min-h-11 self-end"
          >
            Create count
          </Button>
        </form>
        {!countable && (
          <p className="mt-3 text-sm text-text-muted">
            You can review inventory and existing counts, but inventory count permission is required
            to create, submit, or post a count.
          </p>
        )}
        {countable && !loaded.locations.length && (
          <p className="mt-3 text-sm text-text-muted">No active stock locations are available.</p>
        )}
      </SectionCard>

      <div
        key={query.fresh ?? loaded.selectedCount?.id ?? 'count-detail'}
        className="grid gap-6 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]"
      >
        <SectionCard>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-text-strong">Physical counts</h2>
            <span className="font-mono text-xs text-text-muted">
              {loaded.counts.items.length} recent
            </span>
          </div>
          <div className="mt-4 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Count</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Review</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loaded.counts.items.length ? (
                  loaded.counts.items.map((count) => (
                    <TableRow
                      data-state={count.id === loaded.selectedCount?.id ? 'selected' : undefined}
                      key={count.id}
                    >
                      <TableCell>
                        <p className="font-medium text-text-strong">
                          {count.reference || 'Unreferenced count'}
                        </p>
                        <p className="font-mono text-xs text-text-muted">
                          {count._count.lines} line{count._count.lines === 1 ? '' : 's'}
                        </p>
                      </TableCell>
                      <TableCell>{locationName(count.locationId)}</TableCell>
                      <TableCell>
                        <StatusPill status={count.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Link
                          aria-current={count.id === loaded.selectedCount?.id ? 'true' : undefined}
                          className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                          href={`${route}?selected=${count.id}`}
                        >
                          {count.id === loaded.selectedCount?.id ? 'Selected' : 'Review'}
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={4} className="py-10 text-center text-text-muted">
                      No physical counts yet. Create one above to begin.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </SectionCard>

        <SectionCard>
          {loaded.selectedCount ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="font-mono text-xs uppercase tracking-wider text-text-muted">
                    Selected count
                  </p>
                  <h2 className="mt-1 text-lg font-semibold text-text-strong">
                    {loaded.selectedCount.reference || 'Unreferenced count'}
                  </h2>
                  <p className="mt-1 text-sm text-text-muted">
                    {locationName(loaded.selectedCount.locationId)} · created{' '}
                    {formatDate(loaded.selectedCount.countedAt)}
                  </p>
                </div>
                <StatusPill status={loaded.selectedCount.status} />
              </div>

              {loaded.selectedCount.status === 'DRAFT' && (
                <>
                  <form action={addCountLine} className="mt-5 grid gap-3 sm:grid-cols-2">
                    <input type="hidden" name="stockCountId" value={loaded.selectedCount.id} />
                    <label className="text-sm text-text-body">
                      Stock item
                      <select
                        name="stockItemId"
                        required
                        disabled={!countable}
                        className={inputClass}
                      >
                        <option value="">Select stock item</option>
                        {loaded.stockItems.map((item) => (
                          <option value={item.id} key={item.id}>
                            {item.ingredient.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-sm text-text-body">
                      Counted quantity
                      <Input
                        name="countedQuantity"
                        inputMode="decimal"
                        pattern="(?:0|\d+(?:\.\d+)?|\.\d+)"
                        required
                        disabled={!countable}
                        aria-describedby="counted-quantity-help"
                        className="mt-1 min-h-11"
                      />
                    </label>
                    <p id="counted-quantity-help" className="text-xs text-text-muted sm:col-span-2">
                      Use zero or a positive decimal value.
                    </p>
                    <Button
                      type="submit"
                      disabled={!countable || !loaded.stockItems.length}
                      className="min-h-11 sm:col-span-2"
                    >
                      Add count line
                    </Button>
                  </form>
                  <form action={submitCount} className="mt-3 border-t border-border-subtle pt-4">
                    <input type="hidden" name="stockCountId" value={loaded.selectedCount.id} />
                    <Button
                      type="submit"
                      disabled={!countable || !loaded.selectedCount.lines.length}
                      variant="secondary"
                      className="min-h-11"
                    >
                      Submit and freeze count
                    </Button>
                    {!loaded.selectedCount.lines.length && (
                      <p className="mt-2 text-xs text-text-muted">
                        Add at least one count line before submitting.
                      </p>
                    )}
                  </form>
                </>
              )}

              <div className="mt-5 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead className="text-right">Expected</TableHead>
                      <TableHead className="text-right">Counted</TableHead>
                      <TableHead className="text-right">Variance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loaded.selectedCount.lines.length ? (
                      loaded.selectedCount.lines.map((line) => (
                        <TableRow key={line.id}>
                          <TableCell>{itemName(line.stockItemId)}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {loaded.selectedCount!.status === 'DRAFT'
                              ? 'Pending freeze'
                              : String(line.snapshotQuantity)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {String(line.countedQuantity)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {loaded.selectedCount!.status === 'DRAFT'
                              ? 'Pending freeze'
                              : String(line.varianceQuantity)}
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={4} className="py-8 text-center text-text-muted">
                          No items counted yet.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>

              {loaded.selectedCount.status === 'SUBMITTED' && (
                <form action={postCount} className="mt-4 border-t border-border-subtle pt-4">
                  <input type="hidden" name="stockCountId" value={loaded.selectedCount.id} />
                  <Button type="submit" disabled={!countable} className="min-h-11">
                    Post reconciliation
                  </Button>
                  <p className="mt-2 text-xs text-text-muted">
                    Posting writes each non-zero variance to the inventory ledger and cannot be
                    edited afterward.
                  </p>
                </form>
              )}
              {loaded.selectedCount.status === 'POSTED' && (
                <p className="mt-4 text-sm text-text-muted">
                  Reconciliation posted {formatDate(loaded.selectedCount.postedAt)}. This count is
                  read-only.
                </p>
              )}
            </>
          ) : (
            <div className="py-10 text-center">
              <h2 className="text-lg font-semibold text-text-strong">No count selected</h2>
              <p className="mt-2 text-sm text-text-muted">
                Create a physical count to begin the workflow.
              </p>
            </div>
          )}
        </SectionCard>

        <SectionCard>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-text-strong">Stock transfers</h2>
            <span className="font-mono text-xs text-text-muted">
              {loaded.transfers.items.length} recent
            </span>
          </div>
          <div className="mt-4 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead className="text-right">Lines</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loaded.transfers.items.length ? (
                  loaded.transfers.items.map((transfer) => (
                    <TableRow key={transfer.id}>
                      <TableCell className="font-mono text-xs">
                        {transfer.reference || transfer.id}
                      </TableCell>
                      <TableCell className="text-sm text-text-muted">
                        {locationName(transfer.sourceLocationId)} →{' '}
                        {locationName(transfer.destinationLocationId)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {transfer._count.lines}
                      </TableCell>
                      <TableCell>
                        <StatusPill status={transfer.status} />
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={4} className="py-10 text-center text-text-muted">
                      No stock transfers recorded yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <form
            action={createTransfer}
            className="mt-5 grid gap-3 border-t border-border-subtle pt-5 sm:grid-cols-2"
          >
            <label className="text-sm text-text-body">
              From
              <select
                name="sourceLocationId"
                required
                disabled={!adjustable}
                className={inputClass}
              >
                <option value="">Select source</option>
                {loaded.locations.map((location) => (
                  <option value={location.id} key={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-text-body">
              To
              <select
                name="destinationLocationId"
                required
                disabled={!adjustable}
                className={inputClass}
              >
                <option value="">Select destination</option>
                {loaded.locations.map((location) => (
                  <option value={location.id} key={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-text-body sm:col-span-2">
              Reference (optional)
              <Input name="reference" disabled={!adjustable} className="mt-1 min-h-11" />
            </label>
            <Button
              type="submit"
              disabled={!adjustable || loaded.locations.length < 2}
              className="min-h-11 sm:col-span-2"
            >
              Create transfer
            </Button>
          </form>

          {loaded.transfers.items
            .filter((transfer) => transfer.status === 'DRAFT')
            .map((transfer) => (
              <div
                key={`${transfer.id}:actions`}
                className="mt-5 border-t border-border-subtle pt-5"
              >
                <p className="text-sm font-semibold text-text-strong">
                  Add to {transfer.reference || transfer.id}
                </p>
                <form action={addTransferLine} className="mt-3 grid gap-3 sm:grid-cols-2">
                  <input type="hidden" name="stockTransferId" value={transfer.id} />
                  <label className="text-sm text-text-body">
                    Stock item
                    <select
                      name="stockItemId"
                      required
                      disabled={!adjustable}
                      className={inputClass}
                    >
                      <option value="">Select stock item</option>
                      {loaded.stockItems.map((item) => (
                        <option value={item.id} key={item.id}>
                          {item.ingredient.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm text-text-body">
                    Quantity
                    <Input
                      name="quantity"
                      inputMode="decimal"
                      pattern={positiveDecimal.source}
                      required
                      disabled={!adjustable}
                      className="mt-1 min-h-11"
                    />
                  </label>
                  <Button
                    type="submit"
                    variant="secondary"
                    disabled={!adjustable || !loaded.stockItems.length}
                    className="min-h-11"
                  >
                    Add line
                  </Button>
                </form>
                <form action={completeTransfer} className="mt-3">
                  <input type="hidden" name="stockTransferId" value={transfer.id} />
                  <Button
                    type="submit"
                    disabled={!adjustable || transfer._count.lines < 1}
                    className="min-h-11"
                  >
                    Complete transfer
                  </Button>
                </form>
              </div>
            ))}
        </SectionCard>
      </div>
    </div>
  );
}
