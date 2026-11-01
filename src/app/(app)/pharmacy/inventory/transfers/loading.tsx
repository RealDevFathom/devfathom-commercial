import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function PharmacyTransfersLoading() {
  return (
    <main aria-label="Loading stock transfers" className="min-w-0 space-y-6" role="status">
      <PageHeader
        eyebrow="Pharmacy operations · INV-07"
        heading="Stock transfers"
        description="Loading transfers between branches."
      />
      <Skeleton className="h-24 w-full rounded-[var(--radius-md)]" />
      <SectionCard title="Loading transfers">
        <Skeleton className="h-72 w-full" />
      </SectionCard>
    </main>
  );
}
