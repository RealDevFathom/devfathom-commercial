import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button';
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
    <main className="space-y-6">
      <PageHeader eyebrow="Restaurant operations" heading="Inventory" description={description} />
      <SectionCard>
        <h2 className="text-lg font-semibold text-text-strong">
          {moduleEnabled ? 'Permission denied' : 'Module disabled'}
        </h2>
        <p className="mt-2 text-sm text-text-muted">
          {moduleEnabled
            ? 'Inventory read permission is required to open the inventory console.'
            : 'Enable the Restaurant POS module to use inventory.'}
        </p>
      </SectionCard>
    </main>
  );
}

export default async function InventoryPage() {
  const ctx = await tenantContext();
  // Tenancy did not resolve. Entitlements are unknowable here, so show the
  // permission surface rather than let a missing workspace reach the user as an
  // unhandled Server Component crash.
  if (!ctx) return <AccessState moduleEnabled />;

  const user = ctx.session?.user;
  const moduleEnabled = hasModule(ctx.entitlements, 'restaurant-pos');

  if (!user) return <AccessState moduleEnabled={moduleEnabled} />;

  const subject = subjectFromSession(user);
  const readable = await can(subject, 'inventory:read', undefined, {
    db: ctx.db,
    source: 'TRPC',
  });

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
    loaded = { onHand, lowStock, movements, counts, transfers, locations, stockItems };
  } catch {
    return (
      <main className="space-y-6">
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
      </main>
    );
  }

  const locationNames = new Map(loaded.locations.map((l) => [l.id, l.name] as const));
  const stockItemNames = new Map(loaded.stockItems.map((i) => [i.id, i.ingredient.name] as const));
  const itemName = (id: string) => stockItemNames.get(id) ?? id;
  const locationName = (id: string) => locationNames.get(id) ?? id;

  const negativePositions = loaded.onHand.filter((row) => row.isNegative).length;
  const triggeredAlerts = loaded.lowStock.filter((flag) => flag.isTriggered).length;
  const openTransfers = loaded.transfers.items.filter((transfer) =>
    ['DRAFT', 'DISPATCHED'].includes(transfer.status)
  ).length;

  return (
    <main className="space-y-6">
      <PageHeader eyebrow="Restaurant operations" heading="Inventory" description={description} />

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

        <SectionCard>
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

      <div className="grid gap-6 xl:grid-cols-2">
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
                  <TableHead>Reference</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead className="text-right">Lines</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loaded.counts.items.length ? (
                  loaded.counts.items.map((count) => (
                    <TableRow key={count.id}>
                      <TableCell className="font-mono text-xs">
                        {count.reference || count.id}
                      </TableCell>
                      <TableCell>{locationName(count.locationId)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {count._count.lines}
                      </TableCell>
                      <TableCell>
                        <StatusPill status={count.status} />
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={4} className="py-10 text-center text-text-muted">
                      No physical counts recorded yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
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
        </SectionCard>
      </div>
    </main>
  );
}
