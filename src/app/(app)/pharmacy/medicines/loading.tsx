import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export default function MedicineReferenceLoading() {
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy / catalog governance"
        heading="Medicine reference connectors"
        description="Loading connector health and review controls…"
      />
      <SectionCard title="Loading workbench" titleLevel={2}>
        <div className="h-24 animate-pulse rounded-md bg-surface-sunken" />
      </SectionCard>
    </div>
  );
}
