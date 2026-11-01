import { browserUuid } from '@/lib/browser-uuid';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { BranchField, FilterForm } from '@/components/pharmacy/inventory/filter-form';
import { openingImportHref } from '@/components/pharmacy/inventory/opening-import';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { ColdChainCameraSection } from '@/components/camera/cold-chain-camera-section';
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
import { hasModule } from '@/lib/entitlements';
import { evaluateSessionUser } from '@/lib/auth/session-state';
import { DEMO_UNAVAILABLE_MESSAGE, isDemoProcedureBlocked } from '@/lib/demo/isolation';
import { pharmacyActionErrorMessage } from '@/lib/pharmacy/action-error-message';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { pharmacyInventoryRouter } from '@/server/routers/pharmacy-inventory';
import { createTRPCContext } from '@/server/trpc';

import { BreakPackForm } from './break-pack-form';

export const metadata: Metadata = { title: 'Pharmacy inventory' };

const route = '/pharmacy/inventory';
const inputClass =
  'mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
const field = (data: FormData, key: string) => String(data.get(key) ?? '').trim();
const number = (data: FormData, key: string) => Number.parseInt(field(data, key), 10);
const label = (value: string) =>
  value
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/^./, (c) => c.toUpperCase());
const money = (minor: number) =>
  `PKR ${(minor / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const when = (value: Date | string) =>
  new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium' }).format(new Date(value));
const tone = (value: string): 'neutral' | 'success' | 'warning' | 'danger' =>
  ['RECALLED', 'QUARANTINED', 'EXCEPTION', 'STALE'].includes(value)
    ? 'danger'
    : ['AWAITING_COAUTH', 'OPEN', 'PARTIALLY_RECEIVED'].includes(value)
      ? 'warning'
      : ['APPROVED', 'RECEIVED', 'CLOSED', 'ACKNOWLEDGED'].includes(value)
        ? 'success'
        : 'neutral';

async function tenantContext() {
  const actor = await resolveTenantActor();
  if (!actor) return null;
  return createTRPCContext({
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
}

function url(branchId: string, notice: string, kind: 'success' | 'error' = 'success') {
  return `${route}?${new URLSearchParams({ branch: branchId, notice, kind })}`;
}

type NextStep = { href: string; label: string };

/** An empty section that says why it is empty and links to the next useful step. */
function Empty({ children, steps = [] }: { children: React.ReactNode; steps?: NextStep[] }) {
  return (
    <div className="rounded-[var(--radius-sm)] bg-surface-sunken p-5 text-sm text-text-muted">
      <p>{children}</p>
      {steps.length ? (
        <div className="mt-3 flex flex-wrap gap-3">
          {steps.map((step) => (
            <Link
              className={buttonVariants({ variant: 'outline' })}
              href={step.href}
              key={step.href}
            >
              {step.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Submit({
  children,
  destructive = false,
}: {
  children: React.ReactNode;
  destructive?: boolean;
}) {
  return (
    <Button size="sm" type="submit" variant={destructive ? 'destructive' : 'secondary'}>
      {children}
    </Button>
  );
}

export default async function PharmacyInventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string; notice?: string; kind?: string }>;
}) {
  const query = await searchParams;
  const ctx = await tenantContext();
  const moduleEnabled = ctx ? hasModule(ctx.entitlements, 'pharmacy-inventory') : false;
  if (!ctx?.session?.user || !moduleEnabled) {
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy operations"
          heading="Inventory"
          description="Stock by batch and expiry, counts, transfers, recalls and stock to-dos."
        />
        <SectionCard title={moduleEnabled ? 'Permission required' : 'Inventory module unavailable'}>
          <p className="text-sm text-text-muted">
            {moduleEnabled
              ? 'Ask a workspace administrator for pharmacy inventory access.'
              : 'Enable Pharmacy Inventory in workspace modules to use this console.'}
          </p>
        </SectionCard>
      </main>
    );
  }

  const organizationId = ctx.organization!.id;
  // eslint-disable-next-line react-hooks/purity -- Request-time Server Component expiry snapshot; client receives a stable timestamp.
  const observedAt = Date.now();
  const sessionVerdict = evaluateSessionUser(ctx.session.user);
  const breakPackPermission = !sessionVerdict.ok
    ? sessionVerdict.message
    : ctx.organization?.isDemo && isDemoProcedureBlocked('pharmacyInventory.breakPack', 'mutation')
      ? DEMO_UNAVAILABLE_MESSAGE
      : null;
  const branches = await ctx.db.pharmacyBranch.findMany({
    where: { organizationId, active: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, city: true },
  });
  const branch = branches.find((item) => item.id === query.branch) ?? branches[0] ?? null;
  if (!branch) {
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy operations"
          heading="Inventory"
          description="Stock by batch and expiry, counts, transfers, recalls and stock to-dos."
        />
        <SectionCard title="Create an active branch first">
          <p className="text-sm text-text-muted">
            Inventory is branch-scoped. Finish pharmacy onboarding to create the first branch and
            its default stock location.
          </p>
          <Link
            className={buttonVariants({ className: 'mt-4', variant: 'secondary' })}
            href="/settings/modules"
          >
            Review workspace setup
          </Link>
        </SectionCard>
      </main>
    );
  }

  const caller = pharmacyInventoryRouter.createCaller(ctx);
  const [
    organizationLocations,
    lots,
    counts,
    transfers,
    recalls,
    signals,
    users,
    nearExpiry,
    temperatureLogs,
  ] = await Promise.all([
    ctx.db.pharmacyStockLocation.findMany({
      where: { organizationId, active: true },
      orderBy: { name: 'asc' },
    }),
    ctx.db.pharmacyInventoryLot.findMany({
      where: { organizationId, branchId: branch.id },
      orderBy: [{ batch: { expiresAt: 'asc' } }, { createdAt: 'asc' }],
      include: {
        batch: { include: { medicine: { select: { productName: true, brandName: true } } } },
        balances: { include: { location: true } },
      },
    }),
    ctx.db.pharmacyInventoryCount.findMany({
      where: { organizationId, branchId: branch.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { lines: true },
    }),
    ctx.db.pharmacyInterbranchTransfer.findMany({
      where: { organizationId, OR: [{ fromBranchId: branch.id }, { toBranchId: branch.id }] },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { lines: true },
    }),
    ctx.db.pharmacyRecallNotice.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { acknowledgements: true },
    }),
    ctx.db.pharmacyStockSignal.findMany({
      where: {
        organizationId,
        branchId: branch.id,
        status: { in: ['OPEN', 'ACKNOWLEDGED', 'SNOOZED', 'STALE'] },
      },
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
      take: 50,
      include: {
        medicine: { select: { productName: true } },
        location: { select: { name: true } },
      },
    }),
    ctx.db.user.findMany({
      where: { organizationId, status: 'ACTIVE', id: { not: ctx.session.user.id } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, title: true },
    }),
    caller.nearExpiryBoard({ branchId: branch.id }),
    ctx.db.pharmacyTemperatureLog.findMany({
      where: { organizationId, branchId: branch.id },
      orderBy: { recordedAt: 'desc' },
      take: 20,
      include: { location: { select: { name: true } } },
    }),
  ]);
  const branchNames = new Map(branches.map((item) => [item.id, item.name]));
  const locations = organizationLocations.filter((item) => item.branchId === branch.id);
  const destinationLocations = organizationLocations.filter((item) => item.branchId !== branch.id);
  const coldChainLocations = locations.filter((item) => item.coldChain);
  const latestTemperatureByZone = new Map<string, (typeof temperatureLogs)[number]>();
  for (const log of temperatureLogs) {
    if (!latestTemperatureByZone.has(log.stockLocationId)) {
      latestTemperatureByZone.set(log.stockLocationId, log);
    }
  }
  const outOfRangeLogs = [...latestTemperatureByZone.values()].filter((log) => log.outOfRange);
  const zoneStatuses = await caller.temperatureZoneStatuses({ branchId: branch.id });
  const available = lots.flatMap((lot) =>
    lot.balances
      .filter((balance) => balance.disposition === 'AVAILABLE' && balance.onHandUnits > 0)
      .map((balance) => ({ lot, balance }))
  );
  const quarantined = lots.flatMap((lot) =>
    lot.balances
      .filter((balance) => balance.disposition === 'QUARANTINE' && balance.onHandUnits > 0)
      .map((balance) => ({ lot, balance }))
  );
  const releasableQuarantined = quarantined.filter(({ lot }) => lot.batch.state === 'ACTIVE');
  const writeOffPositions = [...available, ...quarantined];
  const totalUnits = available.reduce((sum, row) => sum + row.balance.onHandUnits, 0);
  const draftLotByMedicine = new Map(
    available.map(({ lot }) => [lot.batch.medicineId, lot] as const)
  );
  const heldUnits = lots
    .flatMap((lot) => lot.balances)
    .filter((b) => b.disposition !== 'AVAILABLE')
    .reduce((sum, b) => sum + b.onHandUnits, 0);

  async function perform(data: FormData) {
    'use server';
    const branchId = field(data, 'branchId');
    let destination: string;
    try {
      const actionCtx = await tenantContext();
      if (!actionCtx?.session?.user)
        throw new Error('Your session expired. Sign in and try again.');
      const actionCaller = pharmacyInventoryRouter.createCaller(actionCtx);
      const action = field(data, 'action');
      if (action === 'create-location')
        await actionCaller.createLocation({
          branchId,
          code: field(data, 'code'),
          name: field(data, 'name'),
          kind: field(data, 'kind') as
            'STORE' | 'RACK_BIN' | 'FRIDGE' | 'SAFE' | 'QUARANTINE' | 'TRANSIT' | 'RETURNS',
          coldChain: data.get('coldChain') === 'on',
          minimumTemperatureC:
            data.get('coldChain') === 'on' ? Number(field(data, 'minimumTemperatureC')) : null,
          maximumTemperatureC:
            data.get('coldChain') === 'on' ? Number(field(data, 'maximumTemperatureC')) : null,
        });
      else if (action === 'record-temperature')
        await actionCaller.recordTemperature({
          branchId,
          stockLocationId: field(data, 'stockLocationId'),
          temperatureC: Number(field(data, 'temperatureC')),
          recordedAt: new Date(),
        });
      else if (action === 'create-count')
        await actionCaller.createCount({
          branchId,
          varianceThreshold: number(data, 'threshold'),
          readings: [
            {
              inventoryLotId: field(data, 'position').split(':')[0]!,
              stockLocationId: field(data, 'position').split(':')[1]!,
              countedSealedPacks: number(data, 'sealed'),
              countedLooseUnits: number(data, 'loose'),
            },
          ],
        });
      else if (action === 'approve-count')
        await actionCaller.approveCount({
          branchId,
          countId: field(data, 'countId'),
          idempotencyKeyPrefix: `ui-count:${field(data, 'countId')}`,
        });
      else if (action === 'write-off')
        await actionCaller.writeOff({
          branchId,
          inventoryLotId: field(data, 'position').split(':')[0]!,
          stockLocationId: field(data, 'position').split(':')[1]!,
          units: number(data, 'units'),
          witnessId: field(data, 'witnessId'),
          reason: field(data, 'reason'),
          evidenceRef: field(data, 'evidenceRef'),
          idempotencyKey: `ui-writeoff:${browserUuid()}`,
          disposition: field(data, 'position').split(':')[2] as 'AVAILABLE' | 'QUARANTINE',
        });
      else if (action === 'release-quarantine')
        await actionCaller.releaseQuarantinedPart({
          branchId,
          inventoryLotId: field(data, 'position').split(':')[0]!,
          stockLocationId: field(data, 'position').split(':')[1]!,
          units: number(data, 'units'),
          reason: field(data, 'reason'),
          idempotencyKeyPrefix: `ui-quarantine-release:${browserUuid()}`,
        });
      else if (action === 'allocate-transfer')
        await actionCaller.allocateTransfer({
          branchId,
          toBranchId: field(data, 'destination').split(':')[0]!,
          lines: [
            {
              sourceLotId: field(data, 'position').split(':')[0]!,
              sourceStockLocationId: field(data, 'position').split(':')[1]!,
              destinationStockLocationId: field(data, 'destination').split(':')[1]!,
              quantityUnits: number(data, 'units'),
            },
          ],
        });
      else if (action === 'approve-transfer')
        await actionCaller.approveTransfer({ branchId, transferId: field(data, 'transferId') });
      else if (action === 'dispatch-transfer')
        await actionCaller.dispatchTransfer({
          branchId,
          transferId: field(data, 'transferId'),
          idempotencyKeyPrefix: `ui-dispatch:${field(data, 'transferId')}`,
        });
      else if (action === 'receive-transfer')
        await actionCaller.receiveTransferLine({
          branchId,
          transferId: field(data, 'transferId'),
          lineId: field(data, 'lineId'),
          receivedUnits: number(data, 'units'),
          idempotencyKeyPrefix: `ui-receive:${field(data, 'lineId')}`,
        });
      else if (action === 'create-recall')
        await actionCaller.createRecall({
          batchId: field(data, 'batchId'),
          reference: field(data, 'reference'),
          reason: field(data, 'reason'),
        });
      else if (action === 'ack-recall')
        await actionCaller.acknowledgeRecall({
          branchId,
          recallNoticeId: field(data, 'noticeId'),
        });
      else if (action === 'close-recall')
        await actionCaller.closeRecall({ recallNoticeId: field(data, 'noticeId') });
      else if (action === 'ack-signal')
        await actionCaller.acknowledgeSignal({ branchId, signalId: field(data, 'signalId') });
      else if (action === 'snooze-signal') {
        const until = new Date();
        until.setDate(until.getDate() + 1);
        await actionCaller.snoozeSignal({
          branchId,
          signalId: field(data, 'signalId'),
          until,
          reason: field(data, 'reason'),
        });
      } else if (action === 'dismiss-signal')
        await actionCaller.dismissSignal({
          branchId,
          signalId: field(data, 'signalId'),
          reason: field(data, 'reason'),
        });
      else if (action === 'refresh-signals') await actionCaller.refreshStockSignals({ branchId });
      else if (action === 'draft-signal')
        await actionCaller.createDraftAction({
          kind: 'DRAFT_REQUISITION',
          branchId,
          signalId: field(data, 'signalId'),
          reference: `STOCK-${field(data, 'signalId').slice(-8).toUpperCase()}`,
          medicineId: field(data, 'medicineId'),
          packLevelId: field(data, 'packLevelId'),
          canonicalUnitsPerPack: number(data, 'unitsPerPack'),
          quantityPacks: number(data, 'quantityPacks'),
        });
      else throw new Error('Choose a supported inventory action.');
      destination = url(branchId, 'Inventory action completed.');
    } catch (error) {
      // Keep the thrown value out of the URL entirely: it can contain database, provider,
      // authorization, or validation details that are not safe to return to the browser.
      void error;
      destination = url(branchId, pharmacyActionErrorMessage('inventory'), 'error');
    }
    // Replace, not push: a completed action must not leave an extra Back step.
    redirect(destination, 'replace');
  }

  const inventoryHash = (id: string) =>
    `${route}?${new URLSearchParams({ branch: branch.id })}#${id}`;
  const importHref = openingImportHref(branch.id);
  const receiveStep = {
    href: '/pharmacy/purchasing/receiving',
    label: 'Receive a supplier delivery',
  };
  const importStep = { href: importHref, label: 'Import opening stock' };
  const locationStep = { href: inventoryHash('locations'), label: 'Create a location' };
  const countSteps: NextStep[] = [
    ...(available.length ? [] : [importStep, receiveStep]),
    ...(locations.length ? [] : [locationStep]),
  ];
  const otherBranchesWithoutLocation = branches.filter(
    (item) => item.id !== branch.id && !destinationLocations.some((l) => l.branchId === item.id)
  );

  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy operations · INV-01—09 / PUR-07"
        heading="Inventory"
        description="Your stock by batch and expiry, with counts, write-offs, transfers, recalls and stock to-dos."
        actions={
          <Link href={importHref} className={buttonVariants()}>
            Import opening stock
          </Link>
        }
      />
      {query.notice ? (
        <div
          className={`rounded-[var(--radius-sm)] border p-3 text-sm ${query.kind === 'error' ? 'border-destructive bg-destructive-background text-destructive-foreground' : 'border-success bg-success-background text-success-foreground'}`}
          role={query.kind === 'error' ? 'alert' : 'status'}
        >
          {query.notice}
        </div>
      ) : null}
      <SectionCard title="Working branch" eyebrow="Organization-scoped">
        {branches.length > 1 ? (
          <FilterForm action={route} autoSubmit className="flex flex-wrap items-end gap-3">
            <BranchField branches={branches} value={branch.id} />
            <Button className="min-h-11" type="submit" variant="secondary">
              Open branch
            </Button>
          </FilterForm>
        ) : (
          <BranchField branches={branches} value={branch.id} />
        )}
      </SectionCard>
      <section aria-label="Inventory summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Available units" value={totalUnits.toLocaleString()} sub="Ledger projection" />
        <Stat
          label="Held units"
          value={heldUnits.toLocaleString()}
          sub="Quarantine, damage, transit"
        />
        <Stat
          label="Counts awaiting approval"
          value={counts.filter((c) => c.status === 'AWAITING_COAUTH').length}
          sub="Distinct co-author required"
        />
        <Stat label="Open stock actions" value={signals.length} sub="Ranked by due time" />
      </section>

      <SectionCard title="Stock by expiry" eyebrow="INV-01—04 · soonest expiry sells first">
        {available.length === 0 ? (
          <Empty
            steps={[
              { href: '/pharmacy/medicines', label: 'Set up medicines and packs' },
              receiveStep,
            ]}
          >
            No available stock at this branch yet. Add your medicines and their packs first. To
            load stock you already have, use Import opening stock at the top of this page; for new
            stock, receive a supplier delivery.
          </Empty>
        ) : (
          <div
            role="region"
            aria-label="Pharmacy inventory batches"
            tabIndex={0}
            className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Sell order</TableHead>
                  <TableHead>Medicine / batch</TableHead>
                  <TableHead>Expiry</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Disposition</TableHead>
                  <TableHead className="text-right">Physical arrangement</TableHead>
                  <TableHead className="text-right">Pack action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {available.map(({ lot, balance }, index) => (
                  <TableRow key={`${lot.id}:${balance.stockLocationId}:${balance.disposition}`}>
                    <TableCell className="font-mono">#{index + 1}</TableCell>
                    <TableCell>
                      <span className="font-medium text-text-strong">
                        {lot.batch.medicine.brandName ?? lot.batch.medicine.productName}
                      </span>
                      <span className="block text-xs text-text-muted">
                        Batch {lot.batch.batchNumber} · {lot.supplierName}
                      </span>
                    </TableCell>
                    <TableCell>{when(lot.batch.expiresAt)}</TableCell>
                    <TableCell>{balance.location.name}</TableCell>
                    <TableCell>
                      <StatusPill
                        status={label(balance.disposition)}
                        tone={tone(balance.disposition)}
                      />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {balance.onHandUnits} units · {balance.sealedPacks} sealed +{' '}
                      {balance.looseUnits} loose
                    </TableCell>
                    <TableCell className="whitespace-normal align-top text-right">
                      <BreakPackForm
                        branchId={branch.id}
                        inventoryLotId={lot.id}
                        stockLocationId={balance.stockLocationId}
                        medicineName={
                          lot.batch.medicine.brandName ?? lot.batch.medicine.productName
                        }
                        batchNumber={lot.batch.batchNumber}
                        locationName={balance.location.name}
                        sealedPacks={balance.sealedPacks}
                        looseUnits={balance.looseUnits}
                        unitsPerPack={lot.unitsPerPack}
                        onHandUnits={balance.onHandUnits}
                        expiresAt={lot.batch.expiresAt.toISOString()}
                        observedAt={observedAt}
                        unavailableReason={
                          breakPackPermission ??
                          (lot.batch.state !== 'ACTIVE'
                            ? `Batch is ${label(lot.batch.state).toLowerCase()}.`
                            : !lot.receivedAt
                              ? 'Stock has not been received.'
                              : !balance.location.active
                                ? 'Stock location is inactive.'
                                : balance.disposition !== 'AVAILABLE'
                                  ? 'Stock is not available.'
                                  : null)
                        }
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <div className="grid gap-6 xl:grid-cols-2">
        <SectionCard className="scroll-mt-24" id="locations" title="Locations" eyebrow="INV-05">
          {outOfRangeLogs.length > 0 ? (
            <div
              className="mb-4 rounded-[var(--radius-sm)] border border-destructive bg-destructive-background p-3 text-sm text-destructive-foreground"
              role="alert"
            >
              {outOfRangeLogs.length} recent temperature reading
              {outOfRangeLogs.length === 1 ? ' is' : 's are'} outside the validated range. Review
              the affected stock before use.
            </div>
          ) : null}
          <div className="space-y-2">
            {locations.map((location) => (
              <div
                className="flex items-center justify-between rounded-[var(--radius-sm)] border border-border-subtle p-3"
                key={location.id}
              >
                <div>
                  <p className="font-medium text-text-strong">{location.name}</p>
                  <p className="text-xs text-text-muted">
                    {label(location.kind)} · code {location.code}
                    {location.coldChain
                      ? ` · ${location.minimumTemperatureC}–${location.maximumTemperatureC} °C`
                      : ''}
                  </p>
                </div>
                <StatusPill
                  status={location.coldChain ? 'Cold chain' : 'Ambient'}
                  tone={location.coldChain ? 'warning' : 'neutral'}
                />
              </div>
            ))}
          </div>
          <form action={perform} className="mt-5 grid gap-3 sm:grid-cols-2">
            <input name="action" type="hidden" value="create-location" />
            <input name="branchId" type="hidden" value={branch.id} />
            <label className="text-sm">
              Name
              <Input className="mt-1" name="name" required />
            </label>
            <label className="text-sm">
              Code
              <Input className="mt-1" name="code" required />
            </label>
            <label className="text-sm">
              Storage type
              <select className={inputClass} name="kind">
                {['STORE', 'RACK_BIN', 'FRIDGE', 'SAFE', 'QUARANTINE', 'TRANSIT', 'RETURNS'].map(
                  (kind) => (
                    <option key={kind} value={kind}>
                      {label(kind)}
                    </option>
                  )
                )}
              </select>
            </label>
            <label className="flex min-h-11 items-center gap-2 self-end text-sm">
              <input name="coldChain" type="checkbox" /> Validated cold-chain zone
            </label>
            <label className="text-sm">
              Minimum °C
              <Input className="mt-1" name="minimumTemperatureC" step="0.1" type="number" />
            </label>
            <label className="text-sm">
              Maximum °C
              <Input className="mt-1" name="maximumTemperatureC" step="0.1" type="number" />
            </label>
            <Button className="sm:col-span-2" type="submit">
              Create location
            </Button>
          </form>
          <div className="mt-6 border-t border-border-subtle pt-5">
            <h3 className="font-medium text-text-strong">Manual temperature log</h3>
            {coldChainLocations.length > 0 ? (
              <form action={perform} className="mt-3 grid gap-3 sm:grid-cols-2">
                <input name="action" type="hidden" value="record-temperature" />
                <input name="branchId" type="hidden" value={branch.id} />
                <label className="text-sm">
                  Validated zone
                  <select className={inputClass} name="stockLocationId">
                    {coldChainLocations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name} · {location.minimumTemperatureC}–
                        {location.maximumTemperatureC} °C
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  Reading °C
                  <Input
                    className="mt-1"
                    inputMode="decimal"
                    name="temperatureC"
                    required
                    step="0.1"
                    type="number"
                  />
                </label>
                <Button className="sm:col-span-2" type="submit">
                  Record manual reading
                </Button>
              </form>
            ) : (
              <Empty>Create a validated cold-chain zone before recording temperatures.</Empty>
            )}
            <div className="mt-4 space-y-2">
              {temperatureLogs.map((log) => (
                <div
                  className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] bg-surface-sunken p-3 text-sm"
                  key={log.id}
                >
                  <span>
                    {log.location.name} · {log.temperatureC} °C · {when(log.recordedAt)}
                  </span>
                  <StatusPill
                    status={log.outOfRange ? 'Out of range' : 'In range'}
                    tone={log.outOfRange ? 'danger' : 'success'}
                  />
                </div>
              ))}
            </div>
            <div className="mt-6 border-t border-border-subtle pt-5">
              <ColdChainCameraSection
                db={ctx.db}
                scope={{ organizationId, branchId: branch.id }}
                zones={coldChainLocations}
                statuses={zoneStatuses}
                latestTemperatureC={
                  new Map(
                    [...latestTemperatureByZone].map(([zoneId, log]) => [zoneId, log.temperatureC])
                  )
                }
              />
            </div>
          </div>
        </SectionCard>
        <SectionCard
          className="scroll-mt-24"
          id="counts"
          title="Physical count"
          eyebrow="INV-06 · frozen snapshot"
        >
          {available.length && locations.length ? (
            <form action={perform} className="grid gap-3 sm:grid-cols-2">
              <input name="action" type="hidden" value="create-count" />
              <input name="branchId" type="hidden" value={branch.id} />
              <label className="text-sm sm:col-span-2">
                Lot and location
                <select className={inputClass} name="position">
                  {available.map(({ lot, balance }) => (
                    <option
                      key={`${lot.id}:${balance.stockLocationId}`}
                      value={`${lot.id}:${balance.stockLocationId}`}
                    >
                      {lot.batch.medicine.productName} · batch {lot.batch.batchNumber} ·{' '}
                      {balance.location.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                Variance threshold
                <Input
                  className="mt-1"
                  defaultValue="0"
                  min="0"
                  name="threshold"
                  required
                  type="number"
                />
              </label>
              <label className="text-sm">
                Counted sealed packs
                <Input className="mt-1" min="0" name="sealed" required type="number" />
              </label>
              <label className="text-sm">
                Counted loose units
                <Input className="mt-1" min="0" name="loose" required type="number" />
              </label>
              <Button className="sm:col-span-2" type="submit">
                Freeze count scope
              </Button>
            </form>
          ) : (
            <Empty steps={countSteps}>
              {available.length
                ? 'A count is taken at a stock location. Create a location for this branch, then start the count.'
                : 'There is nothing to count yet: this branch has no stock on hand. Import your opening stock or receive a delivery, then count it here.'}
            </Empty>
          )}
          {counts.length === 0 && available.length && locations.length ? (
            <p className="mt-4 text-sm text-text-muted">
              No counts yet. Pick a lot above, enter what is on the shelf and freeze the count.
            </p>
          ) : null}
          <div className="mt-5 space-y-2">
            {counts.map((count) => (
              <div
                className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-border-subtle p-3"
                key={count.id}
              >
                <div>
                  <StatusPill status={label(count.status)} tone={tone(count.status)} />
                  <p className="mt-1 text-xs text-text-muted">
                    {count.lines.length} frozen line · {when(count.createdAt)} · variance{' '}
                    {count.lines.reduce((sum, line) => sum + Math.abs(line.varianceUnits ?? 0), 0)}{' '}
                    units
                  </p>
                </div>
                {count.status !== 'APPROVED' ? (
                  <form action={perform}>
                    <input name="action" type="hidden" value="approve-count" />
                    <input name="branchId" type="hidden" value={branch.id} />
                    <input name="countId" type="hidden" value={count.id} />
                    <Submit>
                      {count.status === 'AWAITING_COAUTH'
                        ? 'Co-authorize variance'
                        : 'Approve count'}
                    </Submit>
                  </form>
                ) : null}
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Adjustments and write-off custody" eyebrow="INV-06">
        {writeOffPositions.length && users.length ? (
          <form action={perform} className="grid gap-3 md:grid-cols-3">
            <input name="action" type="hidden" value="write-off" />
            <input name="branchId" type="hidden" value={branch.id} />
            <label className="text-sm md:col-span-2">
              Lot
              <select className={inputClass} name="position">
                {writeOffPositions.map(({ lot, balance }) => (
                  <option
                    key={`${lot.id}:${balance.stockLocationId}:${balance.disposition}`}
                    value={`${lot.id}:${balance.stockLocationId}:${balance.disposition}`}
                  >
                    {lot.batch.medicine.productName} · {lot.batch.batchNumber} ·{' '}
                    {balance.location.name} · {label(balance.disposition)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Units
              <Input className="mt-1" min="1" name="units" required type="number" />
            </label>
            <label className="text-sm">
              Co-authorizing witness
              <select className={inputClass} name="witnessId">
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name} · {user.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Evidence reference
              <Input
                className="mt-1"
                name="evidenceRef"
                placeholder="Destruction certificate or photo reference"
                required
              />
            </label>
            <label className="text-sm md:col-span-2">
              Reason
              <Input className="mt-1" name="reason" required />
            </label>
            <Button className="self-end" type="submit" variant="destructive">
              Record write-off
            </Button>
          </form>
        ) : (
          <Empty
            steps={
              writeOffPositions.length
                ? [{ href: '/team', label: 'Invite a team member' }]
                : [importStep, receiveStep]
            }
          >
            {writeOffPositions.length
              ? 'A write-off must be witnessed by a second active team member. Invite a colleague, then record the write-off with them.'
              : 'There is no stock at this branch to adjust or write off yet. Import opening stock or receive a delivery first.'}
          </Empty>
        )}
        {releasableQuarantined.length ? (
          <form action={perform} className="mt-6 grid gap-3 md:grid-cols-3">
            <input name="action" type="hidden" value="release-quarantine" />
            <input name="branchId" type="hidden" value={branch.id} />
            <label className="text-sm md:col-span-2">
              Manually held stock
              <select className={inputClass} name="position">
                {releasableQuarantined.map(({ lot, balance }) => (
                  <option
                    key={`${lot.id}:${balance.stockLocationId}`}
                    value={`${lot.id}:${balance.stockLocationId}`}
                  >
                    {lot.batch.medicine.productName} · {lot.batch.batchNumber} ·{' '}
                    {balance.location.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Units
              <Input className="mt-1" min="1" name="units" required type="number" />
            </label>
            <label className="text-sm md:col-span-2">
              Clearance reason
              <Input className="mt-1" name="reason" required />
            </label>
            <Button className="self-end" type="submit" variant="secondary">
              Release manual hold
            </Button>
            <p className="text-xs text-text-muted md:col-span-3">
              Regulatory recall units remain reserved for the safety-authorized recall reversal.
            </p>
          </form>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Inter-branch transfers"
        eyebrow="INV-07 · allocate → approve → dispatch → receive"
        actions={
          <Link
            className={buttonVariants({ size: 'sm', variant: 'secondary' })}
            href={`/pharmacy/inventory/transfers?${new URLSearchParams({ branch: branch.id })}`}
          >
            Open stock transfers
          </Link>
        }
      >
        {available.length && destinationLocations.length ? (
          <form action={perform} className="grid gap-3 md:grid-cols-3">
            <input name="action" type="hidden" value="allocate-transfer" />
            <input name="branchId" type="hidden" value={branch.id} />
            <label className="text-sm md:col-span-2">
              Stock
              <select className={inputClass} name="position">
                {available.map(({ lot, balance }) => (
                  <option
                    key={`${lot.id}:${balance.stockLocationId}`}
                    value={`${lot.id}:${balance.stockLocationId}`}
                  >
                    {lot.batch.medicine.productName} · {lot.batch.batchNumber} ·{' '}
                    {balance.location.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Destination branch and location
              <select className={inputClass} name="destination">
                {destinationLocations.map((l) => (
                  <option key={l.id} value={`${l.branchId}:${l.id}`}>
                    {branchNames.get(l.branchId)} · {l.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Units
              <Input className="mt-1" min="1" name="units" required type="number" />
            </label>
            <Button className="md:col-span-3" type="submit">
              Allocate transfer
            </Button>
          </form>
        ) : (
          <Empty
            steps={
              branches.length < 2
                ? [{ href: '/pharmacy', label: 'Add a second branch in onboarding' }]
                : !destinationLocations.length
                  ? [
                      {
                        href: `${route}?${new URLSearchParams({ branch: otherBranchesWithoutLocation[0]?.id ?? branch.id })}#locations`,
                        label: `Create a location at ${otherBranchesWithoutLocation[0]?.name ?? 'the other branch'}`,
                      },
                    ]
                  : [importStep, receiveStep]
            }
          >
            {branches.length < 2
              ? 'Transfers move stock between your branches, and you have one. Add a second branch and its stock location in onboarding.'
              : !destinationLocations.length
                ? `${otherBranchesWithoutLocation.map((item) => item.name).join(', ')} ${otherBranchesWithoutLocation.length === 1 ? 'has' : 'have'} no stock location to receive into. Create one there first.`
                : 'This branch has no available stock to send yet. Import opening stock or receive a delivery first.'}
          </Empty>
        )}
        <div className="mt-5 space-y-2">
          {transfers.map((transfer) => (
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-border-subtle p-3"
              key={transfer.id}
            >
              <div>
                <p className="font-medium text-text-strong">
                  {branchNames.get(transfer.fromBranchId) ?? 'Source branch'} →{' '}
                  {branchNames.get(transfer.toBranchId) ?? 'Destination branch'}
                </p>
                <p className="text-xs text-text-muted">
                  {transfer.lines.reduce((sum, line) => sum + line.quantityUnits, 0)} units ·
                  received {transfer.lines.reduce((sum, line) => sum + line.receivedUnits, 0)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <StatusPill status={label(transfer.status)} tone={tone(transfer.status)} />
                {transfer.status === 'ALLOCATED' ? (
                  <form action={perform}>
                    <input name="action" type="hidden" value="approve-transfer" />
                    <input name="branchId" type="hidden" value={branch.id} />
                    <input name="transferId" type="hidden" value={transfer.id} />
                    <Submit>Approve</Submit>
                  </form>
                ) : null}
                {transfer.status === 'APPROVED' ? (
                  <form action={perform}>
                    <input name="action" type="hidden" value="dispatch-transfer" />
                    <input name="branchId" type="hidden" value={branch.id} />
                    <input name="transferId" type="hidden" value={transfer.id} />
                    <Submit>Dispatch</Submit>
                  </form>
                ) : null}
                {['DISPATCHED', 'PARTIALLY_RECEIVED'].includes(transfer.status) &&
                transfer.lines[0] ? (
                  <form action={perform}>
                    <input name="action" type="hidden" value="receive-transfer" />
                    <input name="branchId" type="hidden" value={transfer.toBranchId} />
                    <input name="transferId" type="hidden" value={transfer.id} />
                    <input name="lineId" type="hidden" value={transfer.lines[0].id} />
                    <input
                      name="units"
                      type="hidden"
                      value={transfer.lines[0].quantityUnits - transfer.lines[0].receivedUnits}
                    />
                    <Submit>Receive remaining</Submit>
                  </form>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      <div className="grid gap-6 xl:grid-cols-2">
        <SectionCard title="Recalls and quarantine" eyebrow="INV-08">
          {lots.length ? (
            <form action={perform} className="grid gap-3 sm:grid-cols-2">
              <input name="action" type="hidden" value="create-recall" />
              <input name="branchId" type="hidden" value={branch.id} />
              <label className="text-sm sm:col-span-2">
                Manufacturing batch
                <select className={inputClass} name="batchId">
                  {lots.map((lot) => (
                    <option key={lot.batch.id} value={lot.batch.id}>
                      {lot.batch.medicine.productName} · batch {lot.batch.batchNumber}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                Recall reference
                <Input className="mt-1" name="reference" required />
              </label>
              <label className="text-sm">
                Reason
                <Input className="mt-1" name="reason" required />
              </label>
              <Button className="sm:col-span-2" type="submit" variant="destructive">
                Issue recall and block stock
              </Button>
            </form>
          ) : (
            <Empty>A received manufacturing batch is required before a recall can be issued.</Empty>
          )}
          <div className="mt-5 space-y-2">
            {recalls.map((recall) => {
              const acknowledged = recall.acknowledgements.some(
                (ack) => ack.branchId === branch.id
              );
              return (
                <div
                  className="rounded-[var(--radius-sm)] border border-border-subtle p-3"
                  key={recall.id}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-text-strong">{recall.reference}</p>
                      <p className="text-xs text-text-muted">
                        {recall.reason} · {recall.acknowledgements.length}/{branches.length}{' '}
                        branches acknowledged
                      </p>
                    </div>
                    <StatusPill status={label(recall.status)} tone={tone(recall.status)} />
                  </div>
                  {recall.status === 'OPEN' ? (
                    <div className="mt-3 flex gap-2">
                      {!acknowledged ? (
                        <form action={perform}>
                          <input name="action" type="hidden" value="ack-recall" />
                          <input name="branchId" type="hidden" value={branch.id} />
                          <input name="noticeId" type="hidden" value={recall.id} />
                          <Submit>Acknowledge branch</Submit>
                        </form>
                      ) : null}
                      <form action={perform}>
                        <input name="action" type="hidden" value="close-recall" />
                        <input name="branchId" type="hidden" value={branch.id} />
                        <input name="noticeId" type="hidden" value={recall.id} />
                        <Submit>Close after reconciliation</Submit>
                      </form>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </SectionCard>
        <SectionCard
          title="Near-expiry and return windows"
          eyebrow="INV-09"
          actions={
            <Link
              className={buttonVariants({ size: 'sm', variant: 'secondary' })}
              href={`/pharmacy/inventory/expiry?branch=${encodeURIComponent(branch.id)}`}
            >
              Act on expiring stock
            </Link>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {nearExpiry.map((bucket) => (
              <div
                className="rounded-[var(--radius-sm)] border border-border-subtle p-4"
                key={bucket.bucketDays}
              >
                <p className="font-mono text-xs uppercase text-text-muted">
                  Expires within {bucket.bucketDays} days
                </p>
                <p className="mt-2 text-2xl font-semibold tabular-nums text-text-strong">
                  {money(bucket.valueAtRiskMinor)}
                </p>
                <p className="text-sm text-text-muted">
                  {bucket.units} units at risk ·{' '}
                  {bucket.withinSupplierReturnWindow
                    ? 'return claim reserved'
                    : 'no reserved return claim'}
                </p>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Stock action centre" eyebrow="PUR-07 · ranked by due time">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-text-muted">
            Signals explain their evidence window and never create an order or movement.
          </p>
          <form action={perform}>
            <input name="action" type="hidden" value="refresh-signals" />
            <input name="branchId" type="hidden" value={branch.id} />
            <Submit>Refresh signals</Submit>
          </form>
        </div>
        {signals.length === 0 ? (
          <Empty>
            No actionable stock signals. Refresh after receiving stock, approving safety levels, or
            recording demand.
          </Empty>
        ) : (
          <div className="space-y-3">
            {signals.map((signal, index) => (
              <article
                className="rounded-[var(--radius-md)] border border-border-subtle p-4"
                key={signal.id}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-mono text-xs uppercase text-text-muted">
                      #{index + 1} · {label(signal.kind)} · due {when(signal.dueAt)}
                    </p>
                    <h3 className="mt-1 font-semibold text-text-strong">
                      {signal.medicine.productName}
                      {signal.location ? ` · ${signal.location.name}` : ''}
                    </h3>
                    <p className="mt-2 max-w-3xl text-sm text-text-body">{signal.explanation}</p>
                    <p className="mt-2 text-xs text-text-muted">
                      Data {when(signal.dataWindowStart)}–{when(signal.dataWindowEnd)} · observed{' '}
                      {when(signal.sourceObservedAt)} · {signal.confidence.toLowerCase()} confidence
                    </p>
                  </div>
                  <StatusPill status={label(signal.status)} tone={tone(signal.status)} />
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {signal.status !== 'STALE' && draftLotByMedicine.get(signal.medicineId) ? (
                    <form action={perform}>
                      <input name="action" type="hidden" value="draft-signal" />
                      <input name="branchId" type="hidden" value={branch.id} />
                      <input name="signalId" type="hidden" value={signal.id} />
                      <input name="medicineId" type="hidden" value={signal.medicineId} />
                      <input
                        name="packLevelId"
                        type="hidden"
                        value={draftLotByMedicine.get(signal.medicineId)!.packLevelId}
                      />
                      <input
                        name="unitsPerPack"
                        type="hidden"
                        value={draftLotByMedicine.get(signal.medicineId)!.unitsPerPack}
                      />
                      <input
                        name="quantityPacks"
                        type="hidden"
                        value={Math.max(
                          1,
                          Math.ceil(
                            signal.neededUnits /
                              draftLotByMedicine.get(signal.medicineId)!.unitsPerPack
                          )
                        )}
                      />
                      <Button size="sm" type="submit">
                        Draft requisition
                      </Button>
                    </form>
                  ) : null}
                  {signal.status === 'OPEN' ? (
                    <form action={perform}>
                      <input name="action" type="hidden" value="ack-signal" />
                      <input name="branchId" type="hidden" value={branch.id} />
                      <input name="signalId" type="hidden" value={signal.id} />
                      <Submit>Acknowledge</Submit>
                    </form>
                  ) : null}
                  <form action={perform} className="flex gap-2">
                    <input name="action" type="hidden" value="snooze-signal" />
                    <input name="branchId" type="hidden" value={branch.id} />
                    <input name="signalId" type="hidden" value={signal.id} />
                    <Input
                      aria-label="Snooze reason"
                      className="h-9"
                      name="reason"
                      placeholder="Reason for 1-day snooze"
                      required
                    />
                    <Submit>Snooze</Submit>
                  </form>
                  <form action={perform} className="flex gap-2">
                    <input name="action" type="hidden" value="dismiss-signal" />
                    <input name="branchId" type="hidden" value={branch.id} />
                    <input name="signalId" type="hidden" value={signal.id} />
                    <Input
                      aria-label="Dismissal reason"
                      className="h-9"
                      name="reason"
                      placeholder="Dismissal reason"
                      required
                    />
                    <Submit destructive>Dismiss</Submit>
                  </form>
                </div>
              </article>
            ))}
          </div>
        )}
      </SectionCard>
    </main>
  );
}
