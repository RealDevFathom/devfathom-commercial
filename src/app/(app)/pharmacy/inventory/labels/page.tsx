import type { Metadata } from 'next';
import Link from 'next/link';
import { TRPCError } from '@trpc/server';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { ShelfLabelPrintPanel } from '@/components/pharmacy/shelf-label-print-panel';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { pharmacyInventoryRouter } from '@/server/routers/pharmacy-inventory';
import { createTRPCContext } from '@/server/trpc';
import type { ShelfLabelSource } from '@/lib/pharmacy/shelf-label';

export const metadata: Metadata = { title: 'Shelf and price labels · Pharmacy' };
const route = '/pharmacy/inventory/labels';
async function tenantContext() {
  const actor = await resolveTenantActor();
  if (!actor) return null;
  return createTRPCContext({
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
}

const scalar = (value: string | string[] | undefined) => typeof value === 'string' ? value : undefined;

export default async function ShelfLabelsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  let branchId = scalar(params.branch);
  const goodsReceiptId = scalar(params.receipt);
  const query = scalar(params.q) ?? '';
  const after = scalar(params.after);
  let branches: { id: string; name: string }[] = [];
  let rows: ShelfLabelSource[] = [];
  let next: string | null = null;
  let error: string | null = null;
  try {
    const ctx = await tenantContext();
    if (!ctx?.session?.user) throw new TRPCError({ code: 'UNAUTHORIZED' });
    const caller = pharmacyInventoryRouter.createCaller(ctx);
    branches = await caller.shelfLabelBranches();
    if (!branchId && branches.length === 1) branchId = branches[0]!.id;
    if (branchId) ({ rows, next } = await caller.shelfLabelLots({ branchId, goodsReceiptId, query, after }));
  } catch (cause) {
    error = cause instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(cause.code)
      ? 'Pharmacy inventory permission, an enabled Inventory module and an active branch are required. Ask your workspace administrator for access.'
      : cause instanceof TRPCError && cause.code === 'CONFLICT'
        ? cause.message
        : cause instanceof TRPCError && cause.code === 'NOT_FOUND'
          ? 'This posted GRN is not available in the selected branch. Return to Goods in and select a posted receipt.'
          : 'Labels could not be loaded. Check the filters and retry; no stock or prices have changed.';
  }
  return <main className="min-w-0 space-y-6">
    <PageHeader eyebrow="Pharmacy / inventory" heading="Shelf and price labels" description="Print lot-specific prices for legacy packs and loose stock; scan a label at the counter to select its lot." />
    <div className="flex flex-wrap gap-4 text-sm"><Link className="underline focus-visible:outline-2 focus-visible:outline-ring" href="/pharmacy/inventory">Inventory</Link><Link className="underline focus-visible:outline-2 focus-visible:outline-ring" href="/pharmacy/purchasing/receiving">Goods in</Link></div>
    <SectionCard title="Medicine list and search">
      <form action={route} className="flex flex-wrap items-end gap-4">
        {goodsReceiptId ? <input type="hidden" name="receipt" value={goodsReceiptId} /> : null}
        <label className="min-w-0 text-sm text-text-body">Branch
          <select name="branch" defaultValue={branchId ?? ''} required className="mt-1 block min-h-11 max-w-full rounded-md border border-input bg-surface-raised px-3 text-text-strong focus-visible:outline-2 focus-visible:outline-ring">
            <option value="">Choose a branch</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </select>
        </label>
        <label className="min-w-0 flex-1 text-sm text-text-body">Medicine, brand or batch<Input className="mt-1 min-h-11" name="q" maxLength={120} defaultValue={query} /></label>
        <Button size="touch" type="submit" variant="secondary" disabled={!branches.length}>Search lots</Button>
      </form>
      {goodsReceiptId ? <p className="mt-3 text-sm text-text-muted">Showing the selected GRN. <Link className="underline focus-visible:outline-2 focus-visible:outline-ring" href={`${route}?${new URLSearchParams(branchId ? { branch: branchId } : {})}`}>Show medicine list</Link></p> : null}
    </SectionCard>
    {error ? <SectionCard title="Labels unavailable"><p role="alert" className="text-sm text-text-muted">{error}</p></SectionCard> : branchId ? <ShelfLabelPrintPanel key={`${branchId}:${goodsReceiptId}:${query}:${after}`} branchId={branchId} goodsReceiptId={goodsReceiptId} rows={rows} /> : <SectionCard title={branches.length ? 'Choose a branch' : 'No active branch'}><p className="text-sm text-text-muted">{branches.length ? 'Select a branch to list its received medicine lots.' : 'Finish pharmacy onboarding to create an active branch.'}</p></SectionCard>}
    {!error && next && branchId ? <Link className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-2 focus-visible:outline-ring" href={`${route}?${new URLSearchParams({ branch: branchId, q: query, after: next, ...(goodsReceiptId ? { receipt: goodsReceiptId } : {}) })}`}>Next 100 lots (print this page before continuing)</Link> : null}
  </main>;
}
