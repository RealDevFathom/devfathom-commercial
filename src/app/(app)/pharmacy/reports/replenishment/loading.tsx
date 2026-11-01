import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function ReplenishmentLoading() {
  return (
    <main aria-label="Loading Replenishment" className="min-w-0 space-y-6" role="status">
      <PageHeader
        eyebrow="Pharmacy reports"
        heading="Replenishment"
        description="Loading your branches and report access."
      />
      <SectionCard title="Report scope" titleLevel={2}>
        <Skeleton className="h-24 w-full" />
      </SectionCard>
      <SectionCard title="Observation window" titleLevel={2}>
        <Skeleton className="h-20 w-full" />
      </SectionCard>
    </main>
  );
}
