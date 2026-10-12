import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function RestaurantOrdersLoading() {
  return (
    <div className="min-w-0 space-y-6" role="status" aria-label="Loading restaurant orders">
      <PageHeader eyebrow="Restaurant operations" heading="Orders" description="Loading orders…" />
      <SectionCard title="Loading orders…">
        <Skeleton className="h-32 w-full" />
      </SectionCard>
    </div>
  );
}
