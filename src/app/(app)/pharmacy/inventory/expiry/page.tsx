import { browserUuid } from '@/lib/browser-uuid';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { BranchAssignmentRequired } from '@/components/pharmacy/inventory/branch-assignment-required';
import { ExpiryBoard, type ExpiryBoardRow } from '@/components/pharmacy/inventory/expiry-board';
import { Button, buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { hasModule } from '@/lib/entitlements';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import {
  admittedInventoryBranchIds,
  EXPIRY_BOARD_WINDOWS,
  pharmacyInventoryRouter,
} from '@/server/routers/pharmacy-inventory';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Pharmacy expiry board' };

const route = '/pharmacy/inventory/expiry';
const inputClass =
  'mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const field = (data: FormData, key: string) => String(data.get(key) ?? '').trim();
const number = (data: FormData, key: string) => Number.parseInt(field(data, key), 10);
const pkr = (minor: number) => `PKR ${(minor / 100).toFixed(2)}`;
type Window = (typeof EXPIRY_BOARD_WINDOWS)[number];
const windowFrom = (value: string | undefined): Window =>
  EXPIRY_BOARD_WINDOWS.find((days) => String(days) === value) ?? 90;

/** Domain reason codes, said the way the operator needs to hear them. */
const FAILURES: Record<string, string> = {
  INSUFFICIENT_STOCK: 'Not enough available units at that location for this action.',
  INVALID_ARRANGEMENT:
    'That quantity would split a sealed pack. Quarantine the loose units plus whole packs.',
  BLOCKED_STOCK: 'This batch is recalled or quarantined, so it cannot be marked down.',
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

function url(
  params: { branch: string; within: Window; view?: 'print' },
  notice?: { text: string; kind: 'success' | 'error' }
) {
  const query = new URLSearchParams({ branch: params.branch, within: String(params.within) });
  if (params.view) query.set('view', params.view);
  if (notice) {
    query.set('notice', notice.text);
    query.set('kind', notice.kind);
  }
  return `${route}?${query}`;
}

export default async function PharmacyExpiryBoardPage({
  searchParams,
}: {
  searchParams: Promise<{
    branch?: string;
    within?: string;
    view?: string;
    notice?: string;
    kind?: string;
  }>;
}) {
  const query = await searchParams;
  const withinDays = windowFrom(query.within);
  const view = query.view === 'print' ? 'print' : 'board';
  const ctx = await tenantContext();
  const moduleEnabled = ctx ? hasModule(ctx.entitlements, 'pharmacy-inventory') : false;
  const header = (
    <PageHeader
      eyebrow="Pharmacy operations · INV-09"
      heading="Expiry board"
      description="Act on stock before it becomes dead stock: mark it down, send it back, or pull it from sale."
    />
  );
  if (!ctx?.session?.user || !moduleEnabled) {
    return (
      <div className="min-w-0 space-y-6">
        {header}
        <SectionCard title={moduleEnabled ? 'Permission required' : 'Inventory module unavailable'}>
          <p className="text-sm text-text-muted">
            {moduleEnabled
              ? 'Ask a workspace administrator for pharmacy inventory access.'
              : 'Enable Pharmacy Inventory in workspace modules to use this board.'}
          </p>
        </SectionCard>
      </div>
    );
  }

  const organizationId = ctx.organization!.id;
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
        {header}
        <BranchAssignmentRequired canAssign={ctx.session.user.role === 'ADMIN'} />
      </div>
    );
  }
  if (!branch) {
    return (
      <div className="min-w-0 space-y-6">
        {header}
        <SectionCard title="Create an active branch first">
          <p className="text-sm text-text-muted">
            The expiry board is branch-scoped. Finish pharmacy onboarding to create a branch.
          </p>
        </SectionCard>
      </div>
    );
  }

  const board = await pharmacyInventoryRouter
    .createCaller(ctx)
    .expiryBoardLots({ branchId: branch.id, withinDays });
  const rows: ExpiryBoardRow[] = board.rows.map((row) => ({
    ...row,
    expiresAt: row.expiresAt.toISOString(),
    returnWindowOpensAt: row.returnWindowOpensAt?.toISOString() ?? null,
    returnDeadlineAt: row.returnDeadlineAt?.toISOString() ?? null,
    markdown: row.markdown
      ? {
          markdownPercent: row.markdown.markdownPercent,
          printedMrpMinor: row.markdown.printedMrpMinor,
          proposedPackPriceMinor: row.markdown.proposedPackPriceMinor,
          reason: row.markdown.reason,
          recordedAt: row.markdown.recordedAt.toISOString(),
        }
      : null,
    requestKey: browserUuid(),
  }));

  async function perform(data: FormData) {
    'use server';
    const params = { branch: field(data, 'branchId'), within: windowFrom(field(data, 'within')) };
    let destination: string;
    try {
      const actionCtx = await tenantContext();
      if (!actionCtx?.session?.user)
        throw new Error('Your session expired. Sign in and try again.');
      const caller = pharmacyInventoryRouter.createCaller(actionCtx);
      const position = {
        branchId: params.branch,
        inventoryLotId: field(data, 'inventoryLotId'),
        stockLocationId: field(data, 'stockLocationId'),
      };
      const action = field(data, 'action');
      let text: string;
      if (action === 'markdown') {
        const result = await caller.draftExpiryMarkdown({
          ...position,
          markdownPercent: number(data, 'markdownPercent'),
          reason: field(data, 'reason'),
        });
        text = result.created
          ? `Mark-down draft recorded for batch ${result.draft.batchNumber}: ${pkr(result.draft.printedMrpMinor)} → ${pkr(result.draft.proposedPackPriceMinor)} per pack (${result.draft.markdownPercent}% off). The counter still sells at the printed MRP until pricing applies it.`
          : `That mark-down draft already exists for batch ${result.draft.batchNumber} — nothing new was recorded.`;
      } else if (action === 'return') {
        const result = await caller.draftExpiryReturn({
          ...position,
          supplierId: field(data, 'supplierId'),
          units: number(data, 'units'),
          reason: field(data, 'reason'),
        });
        text = result.created
          ? `Supplier return draft ${result.purchaseReturn.reference} created in Purchasing → Returns. A draft reserves nothing until it is submitted.`
          : `This lot already has return ${result.purchaseReturn.reference} (${result.purchaseReturn.status.toLowerCase()}) — open it in Purchasing → Returns.`;
      } else if (action === 'quarantine') {
        const result = await caller.quarantineExpiring({
          ...position,
          units: number(data, 'units'),
          reason: field(data, 'reason'),
          requestKey: field(data, 'requestKey'),
        });
        text = result.replayed
          ? 'That quarantine was already recorded — nothing moved twice.'
          : `Quarantined ${result.held.quantityUnits} units — the ledger now holds them out of sale.`;
      } else throw new Error('Choose a supported expiry action.');
      destination = url(params, { text, kind: 'success' });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      destination = url(params, {
        text: FAILURES[message] ?? (message || 'The expiry action could not be completed.'),
        kind: 'error',
      });
    }
    redirect(destination);
  }

  return (
    <div className="min-w-0 space-y-6">
      {header}
      {query.branch && query.branch !== branch.id ? (
        <p
          className="rounded-[var(--radius-sm)] border border-warning/40 bg-warning/10 p-3 text-sm text-text-body print:hidden"
          role="status"
        >
          The requested branch is not one of your inventory branches, so this board shows{' '}
          {branch.name} instead.
        </p>
      ) : null}
      {query.notice ? (
        <div
          className={`rounded-[var(--radius-sm)] border p-3 text-sm print:hidden ${query.kind === 'error' ? 'border-destructive bg-destructive-background text-destructive-foreground' : 'border-success bg-success-background text-success-foreground'}`}
          role={query.kind === 'error' ? 'alert' : 'status'}
        >
          {query.notice}
        </div>
      ) : null}
      <SectionCard className="print:hidden" eyebrow="Branch-scoped" title="Board filters">
        <form className="flex flex-wrap items-end gap-3" method="get">
          {view === 'print' ? <input name="view" type="hidden" value="print" /> : null}
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
          <label className="min-w-48 text-sm text-text-body">
            Expiring within
            <select className={inputClass} defaultValue={String(withinDays)} name="within">
              {EXPIRY_BOARD_WINDOWS.map((days) => (
                <option key={days} value={days}>
                  {days} days
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="secondary">
            Show
          </Button>
          <Link
            className={buttonVariants({ variant: 'ghost' })}
            href={`/pharmacy/inventory?branch=${encodeURIComponent(branch.id)}`}
          >
            Back to inventory
          </Link>
        </form>
      </SectionCard>
      <ExpiryBoard
        action={perform}
        boardHref={url({ branch: branch.id, within: withinDays })}
        branchId={branch.id}
        branchName={branch.name}
        generatedAt={board.generatedAt.toISOString()}
        printHref={url({ branch: branch.id, within: withinDays, view: 'print' })}
        riskBuckets={board.riskBuckets}
        returnsHref={`/pharmacy/purchasing/returns?branch=${encodeURIComponent(branch.id)}`}
        rows={rows}
        suppliers={board.suppliers}
        view={view}
        withinDays={withinDays}
      />
    </div>
  );
}
