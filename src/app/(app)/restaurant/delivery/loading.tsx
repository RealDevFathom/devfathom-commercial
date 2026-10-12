import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function RestaurantDeliveryLoading() {
  return (
    <div className="min-w-0 space-y-6" role="status" aria-label="Loading restaurant delivery">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Delivery"
        description="Loading delivery administration…"
      />
      <div className="grid gap-6 xl:grid-cols-2">
        <SectionCard title="Loading delivery zones…">
          <Skeleton className="h-40 w-full" />
        </SectionCard>
        <SectionCard title="Loading saved addresses…">
          <Skeleton className="h-40 w-full" />
        </SectionCard>
      </div>
    </div>
  );
}
