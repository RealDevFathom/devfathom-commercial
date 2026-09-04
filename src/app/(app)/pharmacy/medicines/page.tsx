import type { Metadata } from 'next';

import { MedicineReferenceWorkbench } from '@/components/pharmacy/medicine-reference-workbench';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { medicineConnectorHealth } from '@/lib/pharmacy/licensed-reference-connectors';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Medicine reference connectors' };

export default async function MedicineReferencePage() {
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
        eyebrow="Pharmacy / catalog governance"
        heading="Medicine reference connectors"
        description="Normalize manual and licensed reference sources into reviewable medicine candidates with field-level provenance and explicit rights."
      />
      <MedicineReferenceWorkbench health={medicineConnectorHealth()} />
    </main>
  );
}
