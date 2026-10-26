import type { Metadata } from 'next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { parseBalanceSheetCutoff } from '@/lib/pharmacy/accounts/balance-sheet';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { createTRPCContext } from '@/server/trpc';
import { BalanceSheetReport } from './balance-sheet-report';

export const metadata: Metadata = { title: 'Pharmacy balance sheet' };

export default async function BalanceSheetPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string; cutoff?: string }>;
}) {
  const query = await searchParams;
  const actor = await resolveTenantActor();
  if (!actor?.session?.user || actor.session.user.role !== 'ADMIN') {
    return (
      <main className="space-y-6">
        <PageHeader
          eyebrow="Pharmacy accounts"
          heading="Balance sheet"
          description="Classified canonical posted balances."
        />
        <SectionCard title="Permission required">
          <p className="text-sm text-text-muted">
            An organization administrator must read financial reports.
          </p>
        </SectionCard>
      </main>
    );
  }

  const ctx = await createTRPCContext({
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
  const branches = await ctx.db.pharmacyBranch.findMany({
    where: { organizationId: ctx.entitlements.organizationId, active: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  const branch = branches.find(({ id }) => id === query.branch) ?? branches[0];
  const cutoff = query.cutoff ? parseBalanceSheetCutoff(query.cutoff) : new Date();

  return (
    <main className="space-y-6">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Balance sheet"
        description="Assets, liabilities, opening equity, and cumulative posted result with an explicit reconciliation gap."
      />
      <SectionCard title="Report scope">
        <form className="flex flex-wrap items-end gap-3">
          <label className="grid min-w-56 gap-2 text-sm">
            Active branch
            <select
              name="branch"
              defaultValue={branch?.id}
              className="min-h-11 rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3"
            >
              {branches.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid min-w-72 gap-2 text-sm">
            As-of exclusive cutoff (UTC ISO 8601)
            <Input name="cutoff" defaultValue={query.cutoff ?? cutoff?.toISOString()} required />
          </label>
          <Button className="min-h-11">Read balance sheet</Button>
        </form>
        {query.cutoff && !cutoff && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            Enter a valid ISO 8601 timestamp with an explicit UTC offset, such as
            2026-10-26T12:00:00Z. No financial balances were requested.
          </p>
        )}
        {branch && cutoff && (
          <p className="mt-3 text-xs text-text-muted">
            Branch: {branch.name} · Cutoff: {cutoff.toISOString()} (exclusive)
          </p>
        )}
      </SectionCard>
      {branch && cutoff ? (
        <BalanceSheetReport
          caller={pharmacyFinanceRouter.createCaller(ctx)}
          branchId={branch.id}
          cutoff={cutoff}
        />
      ) : !branch ? (
        <SectionCard title="No active branch">
          <p className="text-sm text-text-muted">
            Create an active pharmacy branch before reading balances.
          </p>
        </SectionCard>
      ) : null}
    </main>
  );
}
