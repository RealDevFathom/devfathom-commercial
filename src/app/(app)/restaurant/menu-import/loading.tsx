import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function RestaurantMenuImportLoading() {
  return (
    <div className="min-w-0 space-y-6" role="status" aria-label="Loading menu import">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Menu import"
        description="Loading uploads, the review queue, and import progress…"
      />
      <SectionCard title="Loading uploads…">
        <Skeleton className="h-28 w-full" />
      </SectionCard>
      <SectionCard title="Loading review queue…">
        <div className="space-y-3">
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} className="h-11 w-full" />
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
