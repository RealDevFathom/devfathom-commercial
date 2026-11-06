import type { Metadata } from 'next';
import Link from 'next/link';

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
import { BranchField, FilterForm } from '@/components/pharmacy/inventory/filter-form';
import { openingImportHref } from '@/components/pharmacy/inventory/opening-import';
import { Button, buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { hasModule } from '@/lib/entitlements';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { pharmacyInventoryRouter } from '@/server/routers/pharmacy-inventory';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Stock transfers' };

const route = '/pharmacy/inventory/transfers';
const header = {
  eyebrow: 'Pharmacy operations · INV-07',
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

const SUCCESS: Record<TransferAction, string> = {
  allocate: 'Transfer allocated. A colleague must approve it before dispatch.',
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
  if (!ctx?.session?.user || !moduleEnabled) {
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader {...header} />
        <SectionCard title={moduleEnabled ? 'Permission required' : 'Inventory module unavailable'}>
          <p className="text-sm text-text-muted">
            {moduleEnabled
              ? 'Ask a workspace administrator for pharmacy inventory access.'
              : 'Enable Pharmacy Inventory in workspace modules to move stock between branches.'}
          </p>
        </SectionCard>
      </main>
    );
  }

  const organizationId = ctx.organization!.id;
  const currentUserId = ctx.session.user.id;
  const branches = await ctx.db.pharmacyBranch.findMany({
    where: { organizationId, active: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, city: true },
  });
  const branch = branches.find((item) => item.id === query.branch) ?? branches[0] ?? null;
  if (!branch) {
    return (
      <main className="min-w-0 space-y-6">
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
      </main>
    );
  }

  const caller = pharmacyInventoryRouter.createCaller(ctx);
  const [transfers, balances, destinationLocations, witnesses] = await Promise.all([
    caller.transferBoard({ branchId: branch.id }),
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
    ctx.db.user.findMany({
      where: { organizationId, status: 'ACTIVE', id: { not: currentUserId } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, title: true },
    }),
  ]);
  const branchNames = new Map(branches.map((item) => [item.id, item.name]));
  const stock = balances.map((balance) => ({
    value: `${balance.inventoryLotId}:${balance.stockLocationId}`,
    label: `${balance.lot.batch.medicine.brandName ?? balance.lot.batch.medicine.productName} · batch ${balance.lot.batch.batchNumber} · ${balance.location.name} · ${balance.onHandUnits} units`,
  }));
  const destinations = destinationLocations
    .filter((location) => branchNames.has(location.branchId))
    .map((location) => ({
      value: `${location.branchId}:${location.id}`,
      label: `${branchNames.get(location.branchId)} · ${location.name}`,
    }));
  const branchesWithLocation = new Set(destinationLocations.map((location) => location.branchId));
  const otherBranchWithoutLocation = branches.find(
    (item) => item.id !== branch.id && !branchesWithLocation.has(item.id)
  );
  const inventoryHref = (branchId: string, section = '') =>
    `/pharmacy/inventory?${new URLSearchParams({ branch: branchId })}${section}`;
  const stockSteps: NextStep[] = [
    { href: openingImportHref(branch.id), label: 'Import opening stock' },
    { href: '/pharmacy/purchasing/receiving', label: 'Receive a supplier delivery' },
  ];
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
      else if (action === 'approve') await actionCaller.approveTransfer({ branchId, transferId });
      else if (action === 'dispatch')
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

  return (
    <main className="min-w-0 space-y-6">
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

      <section aria-label="Transfer summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
        {stock.length && destinations.length ? (
          <TransferAllocateForm
            action={perform}
            branchId={branch.id}
            destinations={destinations}
            stock={stock}
          />
        ) : (
          <Empty
            steps={
              branches.length < 2
                ? [{ href: '/pharmacy', label: 'Add a second branch in onboarding' }]
                : !destinations.length
                  ? [
                      {
                        href: inventoryHref(
                          otherBranchWithoutLocation?.id ?? branch.id,
                          '#locations'
                        ),
                        label: `Create a location at ${otherBranchWithoutLocation?.name ?? 'the other branch'}`,
                      },
                    ]
                  : stockSteps
            }
          >
            {branches.length < 2
              ? 'Transfers move stock between your branches, and you have one. Add a second branch and its stock location in onboarding.'
              : !destinations.length
                ? 'The other branch has no stock location to receive into yet. Create one there first.'
                : `${branch.name} has no available stock to send yet. Import opening stock or receive a delivery first.`}
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
          <Empty>
            No transfers are on their way to {branch.name}. When another branch sends stock here, it
            appears in this list to receive.
          </Empty>
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
                transfer={transfer}
                witnesses={witnesses}
              />
            ))}
          </div>
        ) : (
          <Empty>
            {branch.name} has not sent any stock yet. Use Send stock above to start a transfer.
          </Empty>
        )}
      </SectionCard>
    </main>
  );
}
