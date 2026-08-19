import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function RestaurantMoneyLoading() {
  return (
    <div className="min-w-0 space-y-6" role="status" aria-label="Loading restaurant money">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Money"
        description="Loading money ledgers…"
      />
      <SectionCard title="Loading money ledgers…">
        <Skeleton className="h-32 w-full" />
      </SectionCard>
    </div>
  );
}
