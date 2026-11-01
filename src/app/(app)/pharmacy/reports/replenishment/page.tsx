import type { Metadata } from 'next';
import Link from 'next/link';
import type { ComponentProps } from 'react';

import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import { createTRPCContext } from '@/server/trpc';
import { reportsBackHref } from '../report-helpers';
import { ScenarioConsole } from './scenario-console';

export const metadata: Metadata = { title: 'Replenishment · Pharmacy reports' };

export default async function ReplenishmentPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string | string[] }>;
}) {
  const query = await searchParams;
  let scopedProps: ComponentProps<typeof ScenarioConsole> | null = null;
  try {
    const actor = await resolveTenantActor();
    if (!actor) throw new Error('Session unavailable');
    const ctx = await createTRPCContext({
      session: actor.session,
      organization: actor.organization,
      support: actor.support,
    });
    const caller = pharmacyReportsRouter.createCaller(ctx);
    const [scope, catalog] = await Promise.all([caller.branches(), caller.catalog()]);
    const branchId = typeof query.branch === 'string' ? query.branch : '';
    const invalidBranch =
      query.branch !== undefined &&
      (!branchId || !scope.branches.some((branch) => branch.id === branchId));
    scopedProps = {
      organizationId: scope.organizationId,
      branches: scope.branches,
      financial: ctx.session?.user?.role === 'ADMIN' && catalog.permissions.financial,
      initialBranchId: invalidBranch ? '' : branchId,
      invalidInitialBranch: invalidBranch,
      today: new Date().toISOString().slice(0, 10),
    };
  } catch {
    // Contain read/access failures without exposing source error text.
  }
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy reports"
        heading="Replenishment"
        description="Inspect recorded consumption and supply, then compare explicit planning assumptions."
      />
      <Link
        href={reportsBackHref({ branch: typeof query.branch === 'string' ? query.branch : null })}
        className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-2 focus-visible:outline-ring"
      >
        Back to reports
      </Link>
      {scopedProps ? (
        <ScenarioConsole {...scopedProps} />
      ) : (
        <SectionCard title="Replenishment reports unavailable" titleLevel={2}>
          <p role="alert" className="text-sm text-text-muted">
            Report access, your session or source data is unavailable. Retry, or ask your workspace
            administrator to check Pharmacy Reports access.
          </p>
          <form action="/pharmacy/reports/replenishment" method="get" className="mt-4">
            <Button type="submit" variant="outline" className="min-h-11">
              Retry report access
            </Button>
          </form>
        </SectionCard>
      )}
    </main>
  );
}
