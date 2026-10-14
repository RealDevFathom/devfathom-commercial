import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function RestaurantMoneyLoading() {
  return (
    <div className="min-w-0 space-y-6" role="status" aria-label="Loading Restaurant Finance">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Restaurant Finance"
        description="Loading reconciliation history for bills, payments, drawers, and daily closes…"
      />
      <SectionCard eyebrow="Finance & reconciliation" title="Filters">
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </SectionCard>
      <SectionCard title="Loading finance ledgers…">
        <div className="space-y-3">
          <Skeleton className="h-11 w-full max-w-xl" />
          <Skeleton className="h-56 w-full" />
        </div>
      </SectionCard>
    </div>
  );
}
