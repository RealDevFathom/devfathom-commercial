import Link from 'next/link';
import {
  StarterHistory,
  cataloguePageNumber,
} from '@/components/pharmacy/tenant-medicine-catalogue';
import { buttonVariants } from '@/components/ui/button';
import { AddMedicineForm } from '@/components/pharmacy/add-medicine-form';
import { CatalogueApprovalQueue } from '@/components/pharmacy/catalogue-approval-queue';
import type { Metadata } from 'next';
import { StagedMedicineCatalogue } from '@/components/pharmacy/staged-medicine-catalogue';

import { MedicineReferenceWorkbench } from '@/components/pharmacy/medicine-reference-workbench';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { medicineConnectorHealth } from '@/lib/pharmacy/licensed-reference-connectors';
import { createTRPCContext } from '@/server/trpc';
import { can, subjectFromSession } from '@/lib/abac';

export const metadata: Metadata = { title: 'Medicine catalogue' };

export default async function MedicineReferencePage({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await createTRPCContext();
  const sessionUser = ctx.session?.user;
  // DEV-19: a pharmacist who holds the catalogue review permission but is not a
  // workspace administrator reviews proposals in the queue. The server checks
  // every read and decision again.
  if (
    sessionUser &&
    sessionUser.role !== 'ADMIN' &&
    (await can(subjectFromSession(sessionUser), 'pharmacy:catalogue-review', undefined, {
      db: ctx.db,
      source: 'TRPC',
      ip: ctx.requestMeta?.ip ?? null,
    }))
  ) {
    const params = await searchParams;
    const list = params.list === 'narcotics' ? 'narcotics' : 'conflicts';
    const page = cataloguePageNumber(
      typeof params.reviewPage === 'string' ? params.reviewPage : ''
    );
    const history =
      params.view === 'imports'
        ? await (
            await import('@/server/routers/pharmacy-staged-review')
          ).pharmacyStagedReviewRouter
            .createCaller(ctx)
            .pharmacyMedicine.starterHistory({ list, page })
        : null;
    return (
      <div className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy / catalog governance"
          heading="Catalogue review"
          description="Approve or reject catalogue edits submitted for review."
        />
        <Link href="?view=imports" className={buttonVariants({ variant: 'outline' })}>
          Starter catalogue review
        </Link>
        {history && <StarterHistory data={history} list={list} page={page} />}
        <CatalogueApprovalQueue reviewerView />
      </div>
    );
  }
  if (sessionUser?.role !== 'ADMIN') {
    return (
      <div className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy / catalog governance"
          heading="Medicine reference connectors"
          description="Normalize reference sources into reviewable medicine candidates."
        />
        <SectionCard title="Catalog administration permission required" titleLevel={2}>
          <p className="text-sm text-text-muted">
            Your role cannot review proposed medicines. Ask a pharmacist with catalogue review
            permission to review this import. A workspace administrator must upload source files,
            inspect provenance, and publish reference assertions. No connector data has been exposed
            or changed.
          </p>
        </SectionCard>
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-6">
      {await StagedMedicineCatalogue({ searchParams, ctx })}
      <CatalogueApprovalQueue />
      <AddMedicineForm />
      <details className="rounded-md border border-border bg-surface-card p-6">
        <summary className="min-h-11 cursor-pointer font-semibold focus-visible:outline-2 focus-visible:outline-ring">
          Medicine reference connectors
        </summary>
        <MedicineReferenceWorkbench health={medicineConnectorHealth()} />
      </details>
    </div>
  );
}
