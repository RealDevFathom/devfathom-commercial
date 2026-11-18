import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function ShelfLabelsLoading() {
  return (
    <div className="min-w-0 space-y-6" role="status" aria-label="Loading shelf labels">
      <PageHeader
        eyebrow="Pharmacy operations · Inventory"
        heading="Shelf and price labels"
        description="Loading the selected stock and current prices."
      />
      <SectionCard title="Loading labels">
        <Skeleton className="h-72 w-full" />
      </SectionCard>
    </div>
  );
}
