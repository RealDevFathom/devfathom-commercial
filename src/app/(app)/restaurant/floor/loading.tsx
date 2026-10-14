import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function RestaurantFloorLoading() {
  return (
    <div className="min-w-0 space-y-6" role="status" aria-label="Loading restaurant floor">
      <PageHeader eyebrow="Restaurant operations" heading="Floor" description="Loading floor…" />
      <SectionCard title="Loading floor…">
        <Skeleton className="h-32 w-full" />
      </SectionCard>
    </div>
  );
}
