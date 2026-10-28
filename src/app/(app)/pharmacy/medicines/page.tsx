import type { Metadata } from 'next';
import { CreateMedicine } from '@/components/pharmacy/create-medicine';
import { StagedMedicineCatalogue } from '@/components/pharmacy/staged-medicine-catalogue';

import { MedicineReferenceWorkbench } from '@/components/pharmacy/medicine-reference-workbench';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { medicineConnectorHealth } from '@/lib/pharmacy/licensed-reference-connectors';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Medicine catalogue' };

export default async function MedicineReferencePage({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await createTRPCContext();
  if (ctx.session?.user.role !== 'ADMIN') {
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy / catalog governance"
          heading="Medicine reference connectors"
          description="Normalize reference sources into reviewable medicine candidates."
        />
        <SectionCard title="Catalog administration permission required" titleLevel={2}>
          <p className="text-sm text-text-muted">
            A workspace administrator must upload source files, inspect provenance, and publish
            reference assertions. No connector data has been exposed or changed.
          </p>
        </SectionCard>
      </main>
    );
  }
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy / medicines"
        heading="Medicine catalogue"
        description="Create a medicine, review and publish its facts, then define its pack for receiving."
      />
      <CreateMedicine />
      <MedicineReferenceWorkbench health={medicineConnectorHealth()} />
      <details className="rounded-md border border-border bg-surface-card p-6">
        <summary className="min-h-11 cursor-pointer font-semibold focus-visible:outline-2 focus-visible:outline-ring">
          Preserved import source review
        </summary>
        {await StagedMedicineCatalogue({ searchParams, showHeader: false })}
      </details>
    </main>
  );
}
