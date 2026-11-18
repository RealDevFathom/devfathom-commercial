import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div role="status" aria-label="Loading Replenishment" className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy operations"
        heading="Replenishment"
        description="Loading replenishment report access and branch scope."
      />
      <SectionCard title="Loading replenishment">
        <Skeleton className="h-32 w-full" />
      </SectionCard>
    </div>
  );
}
