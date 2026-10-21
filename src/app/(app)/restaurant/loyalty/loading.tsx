import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function RestaurantLoyaltyLoading() {
  return (
    <div className="min-w-0 space-y-6" role="status" aria-label="Loading customers and loyalty">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Customers & Loyalty"
        description="Loading customer profiles, consent, and loyalty ledgers…"
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <SectionCard key={index}>
            <Skeleton className="h-20 w-full" />
          </SectionCard>
        ))}
      </div>
      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(18rem,0.75fr)_minmax(0,1.25fr)]">
        <SectionCard title="Loading customers…">
          <Skeleton className="h-72 w-full" />
        </SectionCard>
        <SectionCard title="Loading customer detail…">
          <Skeleton className="h-72 w-full" />
        </SectionCard>
      </div>
    </div>
  );
}
