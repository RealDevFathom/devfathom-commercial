import type { Metadata } from 'next';
import Link from 'next/link';

import { BranchAssignmentRequired } from '@/components/pharmacy/inventory/branch-assignment-required';
import { ShelfLabelPrintPanel } from '@/components/pharmacy/inventory/shelf-label-print-panel';
import { Button, buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { hasModule } from '@/lib/entitlements';
import { can, subjectFromSession } from '@/lib/abac';
import type { ShelfLabelSheet, ShelfLabelSource } from '@/lib/pharmacy/shelf-label-source';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import {
  admittedInventoryBranchIds,
  pharmacyInventoryRouter,
} from '@/server/routers/pharmacy-inventory';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Shelf and price labels' };

const inputClass =
  'mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

async function tenantContext() {
  const actor = await resolveTenantActor();
  if (!actor) return null;
  return createTRPCContext({
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
}

const list = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value : value ? [value] : [])
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * DEV-90 — print shelf and price stickers for stock without a usable barcode,
 * from a posted goods receipt (`?receipt=`), a medicine list (`?medicine=`) or
 * a search (`?q=`).
 */
export default async function PharmacyShelfLabelsPage({
  searchParams,
}: {
  searchParams: Promise<{
    branch?: string;
    receipt?: string;
    q?: string;
    medicine?: string | string[];
  }>;
}) {
  const query = await searchParams;
  const ctx = await tenantContext();
  const moduleEnabled = ctx ? hasModule(ctx.entitlements, 'pharmacy-inventory') : false;
  const permitted =
    ctx?.session?.user && moduleEnabled
      ? await can(subjectFromSession(ctx.session.user), 'pharmacy:inventory', undefined, {
          db: ctx.db,
        })
      : false;
  const header = (
    <PageHeader
      eyebrow="Pharmacy operations · Inventory"
      heading="Shelf and price labels"
      description="Print stickers for legacy packs and loose strips: name, strength, MRP per pack and strip, expiry, and a lot code the counter scans."
    />
  );
  if (!ctx?.session?.user || !moduleEnabled || !permitted) {
    return (
      <div className="min-w-0 space-y-6">
        {header}
        <SectionCard title={moduleEnabled ? 'Permission required' : 'Inventory module unavailable'}>
          <p className="text-sm text-text-muted">
            {moduleEnabled
              ? 'Ask a workspace administrator for pharmacy inventory access.'
              : 'Enable Pharmacy Inventory in workspace modules to print shelf labels.'}
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
  const admitted = await admittedInventoryBranchIds(ctx);
  const workingBranches = branches.filter((item) => admitted.has(item.id));
  const branch =
    workingBranches.find((item) => item.id === query.branch) ?? workingBranches[0] ?? null;
  if (!branch) {
    return (
      <div className="min-w-0 space-y-6">
        {header}
        {branches.length > 0 ? (
          <BranchAssignmentRequired canAssign={ctx.session.user.role === 'ADMIN'} />
        ) : (
          <SectionCard title="Create an active branch first">
            <p className="text-sm text-text-muted">
              Shelf labels are branch-scoped. Finish pharmacy onboarding to create a branch.
            </p>
          </SectionCard>
        )}
      </div>
    );
  }

  const receipts = await ctx.db.pharmacyGoodsReceipt.findMany({
    where: { organizationId, branchId: branch.id, status: 'POSTED' },
    orderBy: { postedAt: 'desc' },
    take: 20,
    select: { id: true, reference: true, supplierInvoiceRef: true },
  });

  const searchText = (query.q ?? '').trim();
  const medicineIds = list(query.medicine).slice(0, 100);
  const source: ShelfLabelSource | null = query.receipt
    ? { kind: 'RECEIPT', goodsReceiptId: query.receipt }
    : medicineIds.length > 0
      ? { kind: 'MEDICINES', medicineIds }
      : searchText.length >= 2
        ? { kind: 'SEARCH', query: searchText.slice(0, 120) }
        : null;

  let sheet: ShelfLabelSheet | null = null;
  let failure: string | null = null;
  if (source) {
    try {
      sheet = await pharmacyInventoryRouter
        .createCaller(ctx)
        .shelfLabels({ branchId: branch.id, source });
    } catch {
      failure =
        'The labels could not be loaded. Check your inventory access and selection, then retry.';
    }
  }

  return (
    <div className="min-w-0 space-y-6">
      {header}
      <SectionCard eyebrow="Branch-scoped" title="Choose what to label">
        <div className="grid gap-5 lg:grid-cols-2">
          <form className="flex flex-wrap items-end gap-3" method="get">
            <input name="branch" type="hidden" value={branch.id} />
            <label className="min-w-64 flex-1 text-sm text-text-body">
              Posted goods receipt
              <select
                className={inputClass}
                defaultValue={query.receipt ?? ''}
                disabled={receipts.length === 0}
                name="receipt"
                required
              >
                <option value="" disabled>
                  {receipts.length === 0 ? 'No posted receipt in this branch' : 'Select a receipt'}
                </option>
                {receipts.map((receipt) => (
                  <option key={receipt.id} value={receipt.id}>
                    {receipt.reference} · invoice {receipt.supplierInvoiceRef}
                  </option>
                ))}
              </select>
            </label>
            <Button disabled={receipts.length === 0} size="touch" type="submit" variant="secondary">
              Load receipt
            </Button>
          </form>
          <form className="flex flex-wrap items-end gap-3" method="get">
            <input name="branch" type="hidden" value={branch.id} />
            <label className="min-w-64 flex-1 text-sm text-text-body">
              Search medicines
              <input
                className={inputClass}
                defaultValue={searchText}
                maxLength={120}
                minLength={2}
                name="q"
                placeholder="Name, brand, salt or barcode"
                required
                type="search"
              />
            </label>
            <Button size="touch" type="submit" variant="secondary">
              Search
            </Button>
          </form>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border-subtle pt-4">
          <form className="flex flex-wrap items-end gap-3" method="get">
            <label className="min-w-64 text-sm text-text-body">
              Branch
              <select className={inputClass} defaultValue={branch.id} name="branch">
                {workingBranches.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.city}
                  </option>
                ))}
              </select>
            </label>
            <Button size="touch" type="submit" variant="ghost">
              Switch branch
            </Button>
          </form>
          <Link
            className={buttonVariants({ variant: 'ghost', size: 'touch' })}
            href={`/pharmacy/inventory?branch=${encodeURIComponent(branch.id)}`}
          >
            Back to inventory
          </Link>
        </div>
      </SectionCard>

      {failure ? (
        <div
          className="rounded-[var(--radius-sm)] border border-destructive bg-destructive-background p-3 text-sm text-destructive-foreground"
          role="alert"
        >
          {failure}
        </div>
      ) : sheet ? (
        <ShelfLabelPrintPanel key={JSON.stringify(source)} rows={sheet.rows} title={sheet.title} />
      ) : (
        <SectionCard title="Nothing selected yet">
          <p className="rounded-[var(--radius-sm)] bg-surface-sunken p-5 text-sm text-text-muted">
            Load a posted goods receipt to print one label per received pack, or search for the
            medicines on a shelf.
          </p>
        </SectionCard>
      )}
    </div>
  );
}
