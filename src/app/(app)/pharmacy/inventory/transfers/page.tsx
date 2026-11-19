import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { BranchAssignmentRequired } from '@/components/pharmacy/inventory/branch-assignment-required';
import {
  ALLOCATE_ROWS,
  TransferAllocateForm,
} from '@/components/pharmacy/inventory/transfers/transfer-allocate-form';
import { TransferCard } from '@/components/pharmacy/inventory/transfers/transfer-card';
import {
  allocateInput,
  receiveInput,
} from '@/components/pharmacy/inventory/transfers/transfer-form-data';
import {
  RECEIVABLE_STATUSES,
  transferErrorMessage,
  transferVarianceUnits,
  type TransferAction,
} from '@/components/pharmacy/inventory/transfers/transfer-presentation';
import { selectClass } from '@/components/pharmacy/inventory/transfers/transfer-receive-form';
import { Button, buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import { soloOwnerApprovalAllowed } from '@/lib/pharmacy/purchase-approval';
import { writeOffWitnessOptions } from '@/lib/pharmacy/write-off-witness';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import {
  admittedInventoryBranchIds,
  pharmacyInventoryRouter,
} from '@/server/routers/pharmacy-inventory';
import { createTRPCContext } from '@/server/trpc';
import { batchPhrase } from '@/lib/pharmacy/unrecorded-batch';

export const metadata: Metadata = { title: 'Stock transfers' };

const route = '/pharmacy/inventory/transfers';
const header = {
  eyebrow: 'Pharmacy operations',
  heading: 'Stock transfers',
  description:
    'Allocate, approve, dispatch and receive stock between branches, with a printed slip.',
};

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

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-[var(--radius-sm)] bg-surface-sunken p-5 text-sm text-text-muted">
      {children}
    </p>
  );
}

const SUCCESS: Record<TransferAction, string> = {
  allocate: 'Transfer allocated. A colleague must approve it before dispatch.',
  'allocate-request':
    'Transfer request allocated. A colleague must approve it before dispatch; nothing has moved yet.',
  approve: 'Transfer approved. Print the packing slip and dispatch it.',
  dispatch: 'Transfer dispatched. The stock is now in transit.',
  receive: 'Transfer received and closed.',
};

export default async function PharmacyTransfersPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string; notice?: string; kind?: string }>;
}) {
  const query = await searchParams;
  const ctx = await tenantContext();
  const moduleEnabled = ctx ? hasModule(ctx.entitlements, 'pharmacy-inventory') : false;
  // PR J (#979): the page checks the permission the board and its actions need,
  // not just the module, so a counter-only role is told why instead of erroring.
  const permitted =
    moduleEnabled && ctx?.session?.user
      ? await can(subjectFromSession(ctx.session.user), 'pharmacy:inventory', undefined, {
          db: ctx.db,
          source: 'TRPC',
          ip: ctx.requestMeta.ip,
        }).catch(() => false)
      : false;
  if (!ctx?.session?.user || !moduleEnabled || !permitted) {
    return (
      <div className="min-w-0 space-y-6">
        <PageHeader {...header} />
        <SectionCard title={moduleEnabled ? 'Permission required' : 'Inventory module unavailable'}>
          <p className="text-sm text-text-muted">
            {moduleEnabled
              ? 'Ask a workspace administrator for pharmacy inventory access.'
              : 'Enable Pharmacy Inventory in workspace modules to move stock between branches.'}
          </p>
        </SectionCard>
      </div>
    );
  }

  const organizationId = ctx.organization!.id;
  const currentUserId = ctx.session.user.id;
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
        <PageHeader {...header} />
        <BranchAssignmentRequired canAssign={ctx.session.user.role === 'ADMIN'} />
      </div>
    );
  }
  if (!branch) {
    return (
      <div className="min-w-0 space-y-6">
        <PageHeader {...header} />
        <SectionCard title="Create an active branch first">
          <p className="text-sm text-text-muted">
            Transfers move stock between branches. Finish pharmacy onboarding to create them.
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
  const transfers = await caller.transferBoard({ branchId: branch.id });
  // DEV-908: the owner's switch. Display only; every allocation re-checks it.
  const transferSwitch = await caller.branchTransferSettings();
  const [balances, destinationLocations, witnessOptions, soloApprover] = await Promise.all([
    ctx.db.pharmacyStockBalance.findMany({
      where: {
        organizationId,
        branchId: branch.id,
        disposition: 'AVAILABLE',
        onHandUnits: { gt: 0 },
      },
      orderBy: [{ lot: { batch: { expiresAt: 'asc' } } }],
      include: {
        location: { select: { name: true } },
        lot: {
          select: {
            id: true,
            batch: {
              select: {
                batchNumber: true,
                expiresAt: true,
                medicine: { select: { productName: true, brandName: true } },
              },
            },
          },
        },
      },
    }),
    ctx.db.pharmacyStockLocation.findMany({
      where: { organizationId, active: true, branchId: { not: branch.id } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, branchId: true },
    }),
    // DEV-628: a shortfall is witnessed like a write-off, so offer only people the
    // receipt will accept: colleagues assigned to this branch with a PIN, or the
    // solo owner/pharmacist themself.
    writeOffWitnessOptions(ctx.db, { organizationId, branchId: branch.id, actorId: currentUserId }),
    // Solo-pharmacy rule: a sole owner approves their own allocation with a fresh PIN.
    // Display only; the approval procedure re-checks it on the server.
    soloOwnerApprovalAllowed(ctx.db, organizationId, currentUserId, branch.id).catch(() => false),
  ]);
  const witnesses = witnessOptions.soloSelfWitness
    ? [{ id: currentUserId, name: 'You (solo witness)', title: null }]
    : witnessOptions.witnesses;
  const branchNames = new Map(branches.map((item) => [item.id, item.name]));
  const stock = balances.map((balance) => ({
    value: `${balance.inventoryLotId}:${balance.stockLocationId}`,
    label: `${balance.lot.batch.medicine.brandName ?? balance.lot.batch.medicine.productName} · ${batchPhrase(balance.lot.batch.batchNumber, 'batch')} · ${balance.location.name} · ${balance.onHandUnits} units`,
  }));
  const destinations = destinationLocations
    .filter((location) => branchNames.has(location.branchId))
    .map((location) => ({
      value: `${location.branchId}:${location.id}`,
      label: `${branchNames.get(location.branchId)} · ${location.name}`,
    }));
  const outbound = transfers.filter((transfer) => transfer.direction === 'OUTBOUND');
  const inbound = transfers.filter((transfer) => transfer.direction === 'INBOUND');

  /** Answers with the destination; TransferActionForm follows it (WHA-1344). */
  async function perform(data: FormData): Promise<string> {
    'use server';
    const branchId = String(data.get('branchId') ?? '').trim();
    const action = String(data.get('action') ?? '') as TransferAction;
    try {
      const actionCtx = await tenantContext();
      if (!actionCtx?.session?.user)
        throw new Error('Your session expired. Sign in and try again.');
      const actionCaller = pharmacyInventoryRouter.createCaller(actionCtx);
      const transferId = String(data.get('transferId') ?? '').trim();
      if (action === 'allocate')
        await actionCaller.allocateTransfer(allocateInput(data, ALLOCATE_ROWS));
      else if (action === 'allocate-request')
        await actionCaller.allocateRequestedTransfer({ branchId, transferId });
      else if (action === 'approve') {
        const soloPin = String(data.get('soloPin') ?? '').trim();
        await actionCaller.approveTransfer({
          branchId,
          transferId,
          ...(soloPin ? { soloPin } : {}),
        });
      } else if (action === 'dispatch')
        await actionCaller.dispatchTransfer({
          branchId,
          transferId,
          idempotencyKeyPrefix: `ui-dispatch:${transferId}`,
        });
      else if (action === 'receive')
        await actionCaller.receiveTransferWithVariance(receiveInput(data));
      else throw new Error('Choose a supported transfer action.');
      return url(branchId, SUCCESS[action]);
    } catch (error) {
      return url(branchId, transferErrorMessage(action, error), 'error');
    }
  }

  /** DEV-908: the owner switches recorded branch transfers on or off. */
  async function setSwitch(data: FormData) {
    'use server';
    const branchId = String(data.get('branchId') ?? '').trim();
    const enabled = String(data.get('enabled') ?? '') === 'true';
    let destination: string;
    try {
      const actionCtx = await tenantContext();
      if (!actionCtx?.session?.user)
        throw new Error('Your session expired. Sign in and try again.');
      await pharmacyInventoryRouter.createCaller(actionCtx).setBranchTransfersEnabled({ enabled });
      destination = url(
        branchId,
        enabled ? 'Branch transfers switched on.' : 'Branch transfers switched off.'
      );
    } catch (error) {
      destination = url(
        branchId,
        error instanceof Error ? error.message : 'The setting could not be changed.',
        'error'
      );
    }
    redirect(destination);
  }

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        {...header}
        actions={
          <Link
            className={buttonVariants({ variant: 'outline' })}
            href={`/pharmacy/inventory?${new URLSearchParams({ branch: branch.id })}`}
          >
            Back to inventory
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
      <SectionCard eyebrow="Organization-scoped" title="Working branch">
        <form className="flex flex-wrap items-end gap-3" method="get">
          <label className="min-w-64 flex-1 text-sm text-text-body">
            Branch
            <select className={selectClass} defaultValue={branch.id} name="branch">
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

      <SectionCard eyebrow="Owner setting" title="Branch transfers">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1 text-sm text-text-muted">
            <StatusPill
              label={transferSwitch.enabled ? 'On' : 'Off'}
              status={transferSwitch.enabled ? 'active' : 'pending'}
            />
            <p>
              Moves stock between this pharmacy&apos;s own licensed branches, recorded at both ends.
              Controlled drugs are never transferred.
            </p>
            {transferSwitch.canChange ? null : <p>Only the owner can change this setting.</p>}
          </div>
          {transferSwitch.canChange ? (
            <form action={setSwitch}>
              <input name="branchId" type="hidden" value={branch.id} />
              <input
                name="enabled"
                type="hidden"
                value={transferSwitch.enabled ? 'false' : 'true'}
              />
              <Button type="submit" variant={transferSwitch.enabled ? 'outline' : 'default'}>
                {transferSwitch.enabled ? 'Switch off' : 'Switch on'}
              </Button>
            </form>
          ) : null}
        </div>
      </SectionCard>

      <section aria-label="Transfer summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Stat
          label="Requested"
          sub="Outbound, to allocate"
          value={outbound.filter((t) => t.status === 'DRAFT').length}
        />
        <Stat
          label="Awaiting approval"
          sub="Outbound, second person"
          value={outbound.filter((t) => t.status === 'ALLOCATED').length}
        />
        <Stat
          label="Ready to dispatch"
          sub="Approved outbound"
          value={outbound.filter((t) => t.status === 'APPROVED').length}
        />
        <Stat
          label="Arriving"
          sub="Inbound in transit"
          value={inbound.filter((t) => RECEIVABLE_STATUSES.has(t.status)).length}
        />
        <Stat
          label="Variance units"
          sub="Written off on receipt"
          value={transfers.reduce((sum, t) => sum + transferVarianceUnits(t), 0).toLocaleString()}
        />
      </section>

      <SectionCard eyebrow="Allocate → approve → dispatch" title="Send stock">
        {!transferSwitch.enabled ? (
          <Empty>
            Branch transfers are switched off. Stock already in transit can still be received.
          </Empty>
        ) : stock.length && destinations.length ? (
          <TransferAllocateForm
            action={perform}
            branchId={branch.id}
            destinations={destinations}
            stock={stock}
          />
        ) : (
          <Empty>
            {destinations.length
              ? 'This branch has no available stock to send. Receive stock first.'
              : 'Transfers need a second active branch with a receiving location. Add it in onboarding.'}
          </Empty>
        )}
      </SectionCard>

      <SectionCard eyebrow="Receive with variance" title="Inbound transfers">
        {inbound.length ? (
          <div className="space-y-3">
            {inbound.map((transfer) => (
              <TransferCard
                action={perform}
                branchId={branch.id}
                currentUserId={currentUserId}
                key={transfer.id}
                transfer={transfer}
                witnesses={witnesses}
              />
            ))}
          </div>
        ) : (
          <Empty>No transfers are addressed to {branch.name} yet.</Empty>
        )}
      </SectionCard>

      <SectionCard eyebrow="Outbound" title="Outbound transfers">
        {outbound.length ? (
          <div className="space-y-3">
            {outbound.map((transfer) => (
              <TransferCard
                action={perform}
                branchId={branch.id}
                currentUserId={currentUserId}
                key={transfer.id}
                soloApprover={soloApprover}
                transfer={transfer}
                witnesses={witnesses}
              />
            ))}
          </div>
        ) : (
          <Empty>{branch.name} has not sent any stock yet. Allocate a transfer above.</Empty>
        )}
      </SectionCard>
    </div>
  );
}
