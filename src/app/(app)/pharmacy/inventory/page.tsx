import { browserUuid } from '@/lib/browser-uuid';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { BranchAssignmentRequired } from '@/components/pharmacy/inventory/branch-assignment-required';
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
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import { readPharmacyAdviceAccess } from '@/lib/pharmacy/advice-access';
import { evaluateSessionUser } from '@/lib/auth/session-state';
import { DEMO_UNAVAILABLE_MESSAGE, isDemoProcedureBlocked } from '@/lib/demo/isolation';
import {
  isPharmacyActionForbidden,
  PHARMACY_INVENTORY_ACCESS_DENIED_MESSAGE,
  pharmacyActionErrorMessage,
} from '@/lib/pharmacy/action-error-message';
import { formatLotExpiry } from '@/lib/pharmacy/product-class';
import { lotStockBreakdown } from '@/lib/pharmacy/stock-breakdown';
import { writeOffWitnessOptions } from '@/lib/pharmacy/write-off-witness';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import {
  admittedInventoryBranchIds,
  pharmacyInventoryRouter,
} from '@/server/routers/pharmacy-inventory';
import { renderStockComposition } from '@/lib/pharmacy/counter';
import { createTRPCContext } from '@/server/trpc';

import { BATCH_NOT_RECORDED, batchNumberLabel, batchPhrase } from '@/lib/pharmacy/unrecorded-batch';

import { BreakPackForm } from './break-pack-form';

export const metadata: Metadata = { title: 'Pharmacy inventory' };

const route = '/pharmacy/inventory';
const inputClass =
  'mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
type StockStrengths = Parameters<typeof renderStockComposition>[0];
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
// These recall procedures are gated by `regulatory` (pharmacy:safety), not pharmacy:inventory,
// so a refusal on them must not be explained as missing inventory access.
const SAFETY_GATED_ACTIONS = new Set(['create-recall', 'ack-recall', 'close-recall']);

async function tenantContext() {
  const actor = await resolveTenantActor();
  if (!actor) return null;
  return createTRPCContext({
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
}

/** Mirrors the `pharmacy:inventory` gate on stock-location and other inventory-control procedures. */
async function hasInventoryAccess(context: Awaited<ReturnType<typeof tenantContext>>) {
  const user = context?.session?.user;
  if (!context || !user) return false;
  return can(subjectFromSession(user), 'pharmacy:inventory', undefined, {
    db: context.db,
    source: 'TRPC',
    ip: context.requestMeta.ip,
  });
}

function url(branchId: string, notice: string, kind: 'success' | 'error' = 'success') {
  return `${route}?${new URLSearchParams({ branch: branchId, notice, kind })}`;
}

/** DEV-862: product name plus the recorded salt and strength, e.g. `Panadol (paracetamol 500 mg)`. */
function lotProductLabel(lot: {
  batch: { medicine: { productName: string; strengths: StockStrengths } };
}) {
  const composition = renderStockComposition(lot.batch.medicine.strengths);
  return composition
    ? `${lot.batch.medicine.productName} (${composition})`
    : lot.batch.medicine.productName;
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-[var(--radius-sm)] bg-surface-sunken p-5 text-sm text-text-muted">
      {children}
    </p>
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

type InventoryContext = NonNullable<Awaited<ReturnType<typeof tenantContext>>>;

async function inventoryControlAllowed(ctx: InventoryContext): Promise<boolean> {
  const user = ctx.session?.user;
  if (!user) return false;
  try {
    return await can(subjectFromSession(user), 'pharmacy:inventory', undefined, {
      db: ctx.db,
      source: 'TRPC',
      ip: ctx.requestMeta.ip,
    });
  } catch {
    return false;
  }
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
      <div className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy operations"
          heading="Inventory"
          description="Lots, counts, transfers, recalls, and ranked stock actions."
        />
        <SectionCard title={moduleEnabled ? 'Permission required' : 'Inventory module unavailable'}>
          <p className="text-sm text-text-muted">
            {moduleEnabled
              ? 'Ask a workspace administrator for pharmacy inventory access.'
              : 'Enable Pharmacy Inventory in workspace modules to use this console.'}
          </p>
        </SectionCard>
      </div>
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
  // #979: `createLocation` is an inventory-control write; a counter-only role
  // is not offered a form the server would refuse.
  const canControlInventory = await inventoryControlAllowed(ctx);
  const viewerId = ctx.session.user.id;
  // DEV-594: offer the expiry advisor where the owner reviews expiring stock.
  const advice = await readPharmacyAdviceAccess(ctx);
  const branches = await ctx.db.pharmacyBranch.findMany({
    where: { organizationId, active: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, city: true },
  });
  // DEV-660: the gated stock reads admit only a branch the actor is assigned to (or
  // any branch, for a verified tenant ADMIN), so only those branches are offered.
  // `branches` still names the other side of a transfer.
  const admitted = await admittedInventoryBranchIds(ctx);
  const workingBranches = branches.filter((item) => admitted.has(item.id));
  const branch =
    workingBranches.find((item) => item.id === query.branch) ?? workingBranches[0] ?? null;
  if (!branch && branches.length > 0) {
    return (
      <div className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy operations"
          heading="Inventory"
          description="Lots, counts, transfers, recalls, and ranked stock actions."
        />
        <BranchAssignmentRequired canAssign={ctx.session.user.role === 'ADMIN'} />
      </div>
    );
  }
  if (!branch) {
    return (
      <div className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy operations"
          heading="Inventory"
          description="Lots, counts, transfers, recalls, and ranked stock actions."
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
      </div>
    );
  }

  const caller = pharmacyInventoryRouter.createCaller(ctx);
  // DEV-660: the gated read admits the branch (and, for a tenant ADMIN without an
  // assignment, writes the exception's audit row) before any direct stock read.
  const nearExpiry = await caller.nearExpiryBoard({ branchId: branch.id });
  const [
    organizationLocations,
    lots,
    counts,
    transfers,
    recalls,
    signals,
    writeOffWitnesses,
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
        batch: {
          include: {
            medicine: {
              select: {
                productName: true,
                brandName: true,
                strengths: {
                  orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                  select: { value: true, unit: true, ingredient: { select: { name: true } } },
                },
              },
            },
          },
        },
        balances: { include: { location: true } },
        // DEV-727: the received pack hierarchy, so stock reads as boxes + strips.
        packLevel: {
          select: {
            presentation: {
              select: {
                dosageForm: true,
                packLevels: {
                  where: { organizationId },
                  select: {
                    id: true,
                    level: true,
                    parentPackLevelId: true,
                    unitsPerParent: true,
                  },
                },
              },
            },
          },
        },
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
        medicine: {
          select: {
            productName: true,
            strengths: {
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: { value: true, unit: true, ingredient: { select: { name: true } } },
            },
          },
        },
        location: { select: { name: true } },
      },
    }),
    // DEV-628: only people the write-off will accept: colleagues assigned to
    // this branch with a PIN, or the solo owner/pharmacist themself.
    writeOffWitnessOptions(ctx.db, {
      organizationId,
      branchId: branch.id,
      actorId: ctx.session.user.id,
    }),
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
  // DEV-682: today's cycle-count list is ranked in SQL; only an inventory
  // controller, who can submit and confirm a count, is shown it.
  const cycleCount = canControlInventory
    ? await caller.dailyCycleCountList({ branchId: branch.id })
    : [];
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
  // Damaged holds can only leave inventory; they are never released back to sale.
  const damaged = lots.flatMap((lot) =>
    lot.balances
      .filter((balance) => balance.disposition === 'DAMAGED' && balance.onHandUnits > 0)
      .map((balance) => ({ lot, balance }))
  );
  const releasableQuarantined = quarantined.filter(({ lot }) => lot.batch.state === 'ACTIVE');
  const writeOffPositions = [...available, ...quarantined, ...damaged];
  const totalUnits = available.reduce((sum, row) => sum + row.balance.onHandUnits, 0);
  const draftLotByMedicine = new Map(
    available.map(({ lot }) => [lot.batch.medicineId, lot] as const)
  );
  const compositionByLotId = new Map(
    lots.map((lot) => [lot.id, renderStockComposition(lot.batch.medicine.strengths)] as const)
  );
  const heldUnits = lots
    .flatMap((lot) => lot.balances)
    .filter((b) => b.disposition !== 'AVAILABLE')
    .reduce((sum, b) => sum + b.onHandUnits, 0);

  async function perform(data: FormData) {
    'use server';
    const branchId = field(data, 'branchId');
    const action = field(data, 'action');
    let destination: string;
    let actionCtx: Awaited<ReturnType<typeof tenantContext>> = null;
    try {
      actionCtx = await tenantContext();
      if (!actionCtx?.session?.user)
        throw new Error('Your session expired. Sign in and try again.');
      const actionCaller = pharmacyInventoryRouter.createCaller(actionCtx);
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
      else if (action === 'create-cycle-count') {
        const sealed = data.getAll('cycleSealed');
        const loose = data.getAll('cycleLoose');
        await actionCaller.createCount({
          branchId,
          varianceThreshold: number(data, 'threshold'),
          readings: data.getAll('cyclePosition').map((position, index) => ({
            inventoryLotId: String(position).split(':')[0]!,
            stockLocationId: String(position).split(':')[1]!,
            countedSealedPacks: Number.parseInt(String(sealed[index] ?? ''), 10),
            countedLooseUnits: Number.parseInt(String(loose[index] ?? ''), 10),
          })),
        });
      } else if (action === 'approve-count')
        await actionCaller.approveCount({
          branchId,
          countId: field(data, 'countId'),
          idempotencyKeyPrefix: `ui-count:${field(data, 'countId')}`,
          varianceReason: field(data, 'varianceReason') || undefined,
          soloPin: field(data, 'soloPin') || undefined,
        });
      else if (action === 'write-off')
        await actionCaller.writeOff({
          branchId,
          inventoryLotId: field(data, 'position').split(':')[0]!,
          stockLocationId: field(data, 'position').split(':')[1]!,
          units: number(data, 'units'),
          witnessId: field(data, 'witnessId'),
          witnessPin: field(data, 'witnessPin'),
          reason: field(data, 'reason'),
          evidenceRef: field(data, 'evidenceRef'),
          idempotencyKey: `ui-writeoff:${browserUuid()}`,
          disposition: field(data, 'position').split(':')[2] as
            'AVAILABLE' | 'QUARANTINE' | 'DAMAGED',
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
      // Only the error class and code are read. A refusal is named as missing inventory access
      // only when the actor genuinely lacks `pharmacy:inventory`; other refusals stay generic.
      void error;
      const accessDenied =
        !SAFETY_GATED_ACTIONS.has(action) &&
        isPharmacyActionForbidden(error) &&
        !(await hasInventoryAccess(actionCtx));
      destination = url(
        branchId,
        accessDenied
          ? PHARMACY_INVENTORY_ACCESS_DENIED_MESSAGE
          : pharmacyActionErrorMessage('inventory'),
        'error'
      );
    }
    redirect(destination);
  }

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy operations"
        heading="Inventory"
        description="Lots sold earliest-expiry first, controlled stock movements, chain operations, and the ranked work queue."
        actions={
          <>
            <Link
              href="/pharmacy/inventory/import"
              className={buttonVariants({ variant: 'secondary' })}
            >
              Import opening stock
            </Link>
            <Link
              href="/pharmacy/inventory/imports"
              className={buttonVariants({ variant: 'secondary' })}
            >
              Imported stock references
            </Link>
            <Link
              href={`/pharmacy/inventory/labels?${new URLSearchParams({ branch: branch.id })}`}
              className={buttonVariants({ variant: 'secondary' })}
            >
              Shelf labels
            </Link>
          </>
        }
      />
      {query.notice ? (
        <div
          className={`rounded-[var(--radius-sm)] border p-3 text-sm ${query.kind === 'error' ? 'border-destructive bg-destructive-background text-destructive-foreground' : 'border-success/30 bg-success/10 text-success'}`}
          role={query.kind === 'error' ? 'alert' : 'status'}
        >
          {query.notice}
        </div>
      ) : null}
      <SectionCard title="Working branch" eyebrow="Organization-scoped">
        <form className="flex flex-wrap items-end gap-3" method="get">
          <label className="min-w-64 flex-1 text-sm text-text-body">
            Branch
            <select className={inputClass} defaultValue={branch.id} name="branch">
              {workingBranches.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.city}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="secondary">
            Open branch
          </Button>
        </form>
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

      <SectionCard title="Lots by earliest expiry" eyebrow="Stock on hand">
        {available.length === 0 ? (
          <Empty>
            No available lots yet. Set up a medicine and its pack, then import your opening count or
            receive a supplier delivery.
            <span className="mt-3 flex flex-wrap gap-3">
              <Link href="/pharmacy/medicines" className={buttonVariants({ variant: 'outline' })}>
                Set up medicines and packs
              </Link>
              <Link
                href="/pharmacy/inventory/import"
                className={buttonVariants({ variant: 'outline' })}
              >
                Import opening stock
              </Link>
              <Link
                href="/pharmacy/purchasing/receiving"
                className={buttonVariants({ variant: 'outline' })}
              >
                Receive supplier delivery
              </Link>
              <Link href="/pharmacy" className={buttonVariants({ variant: 'ghost' })}>
                Pharmacy setup
              </Link>
            </span>
          </Empty>
        ) : (
          <Table
            containerProps={{
              role: 'region',
              'aria-label': 'Pharmacy inventory batches',
              tabIndex: 0,
              className:
                'overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            }}
          >
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
              {available.map(({ lot, balance }, index) => {
                const composition = renderStockComposition(lot.batch.medicine.strengths);
                return (
                  <TableRow key={`${lot.id}:${balance.stockLocationId}:${balance.disposition}`}>
                    <TableCell className="font-mono">#{index + 1}</TableCell>
                    <TableCell>
                      <span className="font-medium text-text-strong">
                        {lot.batch.medicine.brandName ?? lot.batch.medicine.productName}
                      </span>
                      {composition ? (
                        <span dir="auto" className="block text-xs text-text-body">
                          {composition}
                        </span>
                      ) : null}
                      <span className="block text-xs text-text-muted">
                        {lot.batch.batchNumber === null
                          ? BATCH_NOT_RECORDED
                          : `${batchPhrase(lot.batch.batchNumber)}`}{' '}
                        · {lot.supplierName}
                      </span>
                      <Link
                        className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                        href={`/pharmacy/inventory/labels?${new URLSearchParams({ branch: branch.id, medicine: lot.batch.medicineId })}`}
                        aria-label={`Print shelf labels for ${lot.batch.medicine.productName}`}
                      >
                        Print labels
                      </Link>
                    </TableCell>
                    <TableCell>{formatLotExpiry(lot.batch.expiresAt, when)}</TableCell>
                    <TableCell>{balance.location.name}</TableCell>
                    <TableCell>
                      <StatusPill
                        status={label(balance.disposition)}
                        tone={tone(balance.disposition)}
                      />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {lotStockBreakdown({
                        onHandUnits: balance.onHandUnits,
                        rootPackLevelId: lot.packLevelId,
                        unitsPerPack: lot.unitsPerPack,
                        packLevels: lot.packLevel?.presentation.packLevels,
                        dosageForm: lot.packLevel?.presentation.dosageForm,
                      })}{' '}
                      · {balance.sealedPacks} sealed + {balance.looseUnits} loose
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
                        expiresAt={lot.batch.expiresAt?.toISOString() ?? null}
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
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <div className="grid gap-6 xl:grid-cols-2">
        <SectionCard title="Locations" eyebrow="Storage">
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
          {canControlInventory ? (
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
          ) : (
            <p className="mt-5 text-sm text-text-muted">
              Creating stock locations needs inventory access — ask an owner.
            </p>
          )}
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
        <SectionCard title="Physical count" eyebrow="Stock count · frozen snapshot">
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
                      {lotProductLabel(lot)} · {batchPhrase(lot.batch.batchNumber, 'batch')} ·{' '}
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
            <div className="space-y-3">
              <Empty>
                {locations.length === 0
                  ? 'No active stock location exists for this branch. Create a location in Locations, then receive stock before starting a count.'
                  : 'No available received stock to count at this branch. Receive stock before starting a count.'}
              </Empty>
              <Link
                href={`/pharmacy/purchasing/receiving?branch=${encodeURIComponent(branch.id)}`}
                className={buttonVariants({ variant: 'outline', size: 'touch' })}
              >
                Receive stock
              </Link>
            </div>
          )}
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
                  {count.varianceReason ? (
                    <p className="mt-1 text-xs text-text-body">Reason: {count.varianceReason}</p>
                  ) : null}
                </div>
                {count.status !== 'APPROVED' ? (
                  <form action={perform} className="flex flex-wrap items-end gap-2">
                    <input name="action" type="hidden" value="approve-count" />
                    <input name="branchId" type="hidden" value={branch.id} />
                    <input name="countId" type="hidden" value={count.id} />
                    {count.lines.some((line) => (line.varianceUnits ?? 0) !== 0) ? (
                      <label className="text-sm">
                        Variance reason
                        <Input
                          className="mt-1"
                          maxLength={500}
                          name="varianceReason"
                          placeholder="Recount confirmed; breakage not logged"
                          required
                        />
                      </label>
                    ) : null}
                    {count.status === 'AWAITING_COAUTH' && count.createdById === viewerId ? (
                      <label className="text-sm">
                        Your PIN, if you work alone
                        <Input
                          autoComplete="off"
                          className="mt-1 w-32"
                          inputMode="numeric"
                          maxLength={8}
                          name="soloPin"
                          pattern="[0-9]{4,8}"
                          type="password"
                        />
                      </label>
                    ) : null}
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

      {canControlInventory ? (
        <SectionCard title="Daily cycle count" eyebrow="Daily count · fast movers and high value">
          {cycleCount.length ? (
            <form action={perform} className="space-y-4">
              <input name="action" type="hidden" value="create-cycle-count" />
              <input name="branchId" type="hidden" value={branch.id} />
              <p className="text-sm text-text-muted">
                Count each shelf position below without looking up the book quantity. Submitting
                saves a draft count; the variance is posted only after a person approves it with a
                reason.
              </p>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Medicine</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Why today</TableHead>
                      <TableHead className="text-right">Sealed packs</TableHead>
                      <TableHead className="text-right">Loose units</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cycleCount.map((item) => (
                      <TableRow key={`${item.inventoryLotId}:${item.stockLocationId}`}>
                        <TableCell>
                          <input
                            name="cyclePosition"
                            type="hidden"
                            value={`${item.inventoryLotId}:${item.stockLocationId}`}
                          />
                          {item.medicineName}
                          {compositionByLotId.get(item.inventoryLotId) ? (
                            <span dir="auto" className="block text-xs text-text-body">
                              {compositionByLotId.get(item.inventoryLotId)}
                            </span>
                          ) : null}
                          <span className="block text-xs text-text-muted">
                            {batchPhrase(item.batchNumber, 'batch')} · {item.unitsPerPack} per pack
                          </span>
                        </TableCell>
                        <TableCell>{item.locationName}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {item.basis.map((basis) => (
                              <StatusPill
                                key={basis}
                                status={basis === 'FAST_MOVER' ? 'Fast mover' : 'High value'}
                                tone="neutral"
                              />
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            aria-label={`Counted sealed packs, ${item.medicineName} ${batchPhrase(item.batchNumber, 'batch')} at ${item.locationName}`}
                            className="ml-auto w-24"
                            min="0"
                            name="cycleSealed"
                            required
                            type="number"
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            aria-label={`Counted loose units, ${item.medicineName} ${batchPhrase(item.batchNumber, 'batch')} at ${item.locationName}`}
                            className="ml-auto w-24"
                            min="0"
                            name="cycleLoose"
                            required
                            type="number"
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="flex flex-wrap items-end gap-3">
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
                <Button type="submit">Submit counted stock</Button>
              </div>
            </form>
          ) : (
            <Empty>
              Nothing to cycle count today. Every sellable position here was counted in the last 7
              days, or the branch holds no available stock.
            </Empty>
          )}
        </SectionCard>
      ) : null}

      <SectionCard title="Adjustments and write-off custody" eyebrow="Stock corrections">
        {writeOffPositions.length &&
        (writeOffWitnesses.witnesses.length || writeOffWitnesses.soloSelfWitness) ? (
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
                    {lotProductLabel(lot)} · {batchNumberLabel(lot.batch.batchNumber)} ·{' '}
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
                {writeOffWitnesses.soloSelfWitness ? (
                  <option value={viewerId}>You (solo witness)</option>
                ) : (
                  writeOffWitnesses.witnesses.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name ?? 'Unnamed colleague'}
                      {user.title ? ` · ${user.title}` : ''}
                    </option>
                  ))
                )}
              </select>
            </label>
            <label className="text-sm">
              Witness PIN
              <Input
                autoComplete="off"
                className="mt-1"
                inputMode="numeric"
                maxLength={8}
                name="witnessPin"
                pattern="[0-9]{4,8}"
                required
                type="password"
              />
              <span className="mt-1 block text-xs text-text-muted">
                {writeOffWitnesses.soloSelfWitness
                  ? 'Nobody else is assigned to this branch. Confirm with your own PIN; the self-witness is audited.'
                  : 'The witness enters their own PIN here. Only colleagues assigned to this branch with a PIN can witness.'}
              </span>
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
          <Empty>
            A write-off needs available or quarantined stock and a witness: a colleague assigned to
            this branch who has a PIN set up.
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
                    {lotProductLabel(lot)} · {batchNumberLabel(lot.batch.batchNumber)} ·{' '}
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
        eyebrow="Branch transfers · allocate → approve → dispatch → receive"
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
                    {lotProductLabel(lot)} · {batchNumberLabel(lot.batch.batchNumber)} ·{' '}
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
          <Empty>
            Transfers need available stock and a second active branch. Add the branch and its
            receiving location in onboarding.
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
                {/* DEV-660: stock is received at the destination, by someone assigned there,
                    so the action is offered only while that branch is the working branch. */}
                {['DISPATCHED', 'PARTIALLY_RECEIVED'].includes(transfer.status) &&
                transfer.toBranchId === branch.id &&
                transfer.lines[0] ? (
                  <form action={perform}>
                    <input name="action" type="hidden" value="receive-transfer" />
                    <input name="branchId" type="hidden" value={branch.id} />
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
        <SectionCard title="Recalls and quarantine" eyebrow="Safety">
          <p className="mb-4 text-sm text-text-muted">
            DRAP recall alerts wait for a person before any stock moves.{' '}
            <Link className="underline underline-offset-4" href="/pharmacy/inventory/drap-recalls">
              Review DRAP recall alerts
            </Link>
          </p>
          {lots.length ? (
            <form action={perform} className="grid gap-3 sm:grid-cols-2">
              <input name="action" type="hidden" value="create-recall" />
              <input name="branchId" type="hidden" value={branch.id} />
              <label className="text-sm sm:col-span-2">
                Manufacturing batch
                <select className={inputClass} name="batchId">
                  {lots.map((lot) => (
                    <option key={lot.batch.id} value={lot.batch.id}>
                      {lotProductLabel(lot)} · {batchPhrase(lot.batch.batchNumber, 'batch')}
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
          eyebrow="Expiry"
          actions={
            <div className="flex flex-wrap justify-end gap-2">
              {advice.expiry ? (
                <Link
                  className={buttonVariants({ size: 'sm', variant: 'outline' })}
                  href={`/pharmacy/reports?${new URLSearchParams({ branch: branch.id })}#expiry-advisor`}
                >
                  Expiry advice
                </Link>
              ) : null}
              <Link
                className={buttonVariants({ size: 'sm', variant: 'secondary' })}
                href={`/pharmacy/inventory/expiry?branch=${encodeURIComponent(branch.id)}`}
              >
                Act on expiring stock
              </Link>
            </div>
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
                {/* DEV-965: the PKR value is landed cost, sent only with financial reports. */}
                <p className="mt-2 text-2xl font-semibold tabular-nums text-text-strong">
                  {bucket.valueAtRiskMinor === null
                    ? `${bucket.units.toLocaleString('en-PK')} units`
                    : money(bucket.valueAtRiskMinor)}
                </p>
                <p className="text-sm text-text-muted">
                  {bucket.valueAtRiskMinor === null ? 'At risk' : `${bucket.units} units at risk`} ·{' '}
                  {bucket.withinSupplierReturnWindow
                    ? 'return claim reserved'
                    : 'no reserved return claim'}
                </p>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Stock action centre" eyebrow="Ranked by due time">
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
                    {renderStockComposition(signal.medicine.strengths) ? (
                      <p dir="auto" className="text-xs text-text-body">
                        {renderStockComposition(signal.medicine.strengths)}
                      </p>
                    ) : null}
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
    </div>
  );
}
