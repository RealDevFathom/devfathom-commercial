import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function PharmacyInventoryLoading() {
  return (
    <div aria-label="Loading pharmacy inventory" className="min-w-0 space-y-6" role="status">
      <PageHeader
        eyebrow="Pharmacy operations"
        heading="Inventory"
        description="Loading stock levels, expiry dates, and tasks."
      />
      <Skeleton className="h-24 w-full rounded-[var(--radius-md)]" />
      <SectionCard title="Loading stock details">
        <Skeleton className="h-72 w-full" />
      </SectionCard>
    </div>
  );
}
