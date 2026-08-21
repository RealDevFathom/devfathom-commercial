import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function RestaurantLoyaltyLoading() {
  return (
    <div className="min-w-0 space-y-6" role="status" aria-label="Loading customers and loyalty">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Customers & Loyalty"
        description="Loading the customer register and loyalty ledger…"
      />
      <SectionCard eyebrow="Canonical register" title="Customer search">
        <div className="space-y-3">
          <Skeleton className="h-11 w-full max-w-md" />
          <Skeleton className="h-56 w-full" />
        </div>
      </SectionCard>
    </div>
  );
}
