import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function RestaurantInsightsLoading() {
  return (
    <div className="min-w-0 space-y-6" role="status" aria-label="Loading restaurant insights">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Insights"
        description="Loading rollups, reconciliation totals, and reports…"
      />
      <SectionCard eyebrow="Insight rollups" title="Filters">
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </SectionCard>
      <SectionCard title="Loading reports…">
        <div className="space-y-3">
          <Skeleton className="h-11 w-full max-w-xl" />
          <Skeleton className="h-56 w-full" />
        </div>
      </SectionCard>
    </div>
  );
}
