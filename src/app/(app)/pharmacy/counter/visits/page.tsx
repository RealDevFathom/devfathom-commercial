import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { pharmacySalesRouter } from '@/server/routers/pharmacy-sales';
import { createTRPCContext } from '@/server/trpc';
import { VisitForm } from './visit-form';

export default async function DemandVisitsPage({
  searchParams,
}: {
  searchParams: Promise<{ branchId?: string }>;
}) {
  const query = await searchParams;
  let branches: { id: string; name: string }[] | null = null;
  try {
    const ctx = await createTRPCContext();
    branches = (await pharmacySalesRouter.createCaller(ctx).counterBranches()).branches;
  } catch {
    /* Render the same permission/error surface as the counter. */
  }
  async function capture(_state: { message: string; success: boolean }, data: FormData) {
    'use server';
    try {
      const ctx = await createTRPCContext();
      await pharmacySalesRouter.createCaller(ctx).captureDemandVisit({
        branchId: String(data.get('branchId') ?? ''),
        id: String(data.get('id') ?? ''),
        ...(data.get('medicineId') ? { medicineId: String(data.get('medicineId')).trim() } : {}),
        walkedOut: data.get('walkedOut') === 'true',
      });
      return {
        success: true,
        message: 'Visit recorded. Demand reports evaluate this evidence on refresh.',
      };
    } catch {
      return {
        success: false,
        message:
          'Visit not confirmed. Check branch access and the medicine ID; walk-outs require an item. Retrying this visit will not count it twice.',
      };
    }
  }
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy counter"
        heading="Record a visit"
        description="Record each actual visit once, including served visits, so walk-out rates have a measured denominator."
      />
      <Link
        href="/pharmacy/counter"
        className="inline-flex min-h-11 items-center text-sm text-primary underline focus-visible:outline-2 focus-visible:outline-ring"
      >
        Back to counter
      </Link>
      <SectionCard title="Visit outcome" titleLevel={2}>
        <p className="mb-4 text-sm text-text-muted">
          Use one primary requested SKU per walk-out. Record served and walk-out visits
          consistently; partial capture does not establish total footfall. Do not record customer
          names or contact details.
        </p>
        {branches ? (
          <VisitForm
            branches={branches}
            initialBranchId={query.branchId}
            visitId={randomUUID()}
            action={capture}
          />
        ) : (
          <p role="alert" className="text-sm text-text-muted">
            Counter access or branch data unavailable. Refresh or ask your administrator to verify
            counter access.
          </p>
        )}
      </SectionCard>
    </main>
  );
}
