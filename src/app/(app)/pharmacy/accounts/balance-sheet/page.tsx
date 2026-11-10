import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { createTRPCContext } from '@/server/trpc';
import { BalanceSheetReport } from './balance-sheet-report';

export const metadata: Metadata = { title: 'Pharmacy balance sheet' };

async function tenantContext() {
  const actor = await resolveTenantActor();
  if (!actor) return null;
  return createTRPCContext({
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
}

export default async function PharmacyBalanceSheetPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string | string[]; cutoff?: string | string[] }>;
}) {
  const query = await searchParams;
  const ctx = await tenantContext();
  if (!ctx?.session?.user || ctx.session.user.role !== 'ADMIN') {
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy accounts"
          heading="Balance sheet"
          description="Classified posted balances and explicit accounting-equation gaps."
        />
        <SectionCard title="Permission required">
          <p className="text-sm text-text-muted">
            Administrator financial-report access is required.
          </p>
        </SectionCard>
      </main>
    );
  }

  const branches = await ctx.db.pharmacyBranch.findMany({
    where: { organizationId: ctx.entitlements.organizationId, active: true },
    orderBy: { name: 'asc' },
    select: { id: true },
  });
  // Only an omitted branch may use the default. An explicit invalid scope must
  // never return another branch's financial balances.
  const branch =
    query.branch === undefined
      ? branches[0]
      : branches.find(({ id }) => id === query.branch);
  if (!branch) {
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy accounts"
          heading="Balance sheet"
          description="Classified posted balances and explicit accounting-equation gaps."
        />
        <SectionCard title={query.branch === undefined ? 'No active branch' : 'Branch unavailable'}>
          <p role="alert" className="text-sm text-text-muted">
            {query.branch === undefined
              ? 'An active in-tenant pharmacy branch is required.'
              : 'The requested branch is not an active branch in your tenant. No financial rows are shown.'}
          </p>
        </SectionCard>
      </main>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const requestedCutoff = typeof query.cutoff === 'string' ? query.cutoff : '';
  const parsedCutoff = new Date(`${requestedCutoff}T00:00:00.000Z`);
  const cutoff =
    /^\d{4}-\d{2}-\d{2}$/.test(requestedCutoff) &&
    !Number.isNaN(parsedCutoff.getTime()) &&
    parsedCutoff.toISOString().slice(0, 10) === requestedCutoff
      ? requestedCutoff
      : today;
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Balance sheet"
        description="Classified posted balances and explicit accounting-equation gaps."
      />
      <BalanceSheetReport
        caller={pharmacyFinanceRouter.createCaller(ctx)}
        branchId={branch.id}
        cutoff={cutoff}
      />
    </main>
  );
}
