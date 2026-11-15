import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

/** UX rule 9: the loading state has the shape of the surface, not a bare spinner. */
export default function PharmacySupplierPriceListsLoading() {
  return (
    <main aria-label="Loading Supplier price lists" className="min-w-0 space-y-6" role="status">
      <PageHeader
        eyebrow="Pharmacy procurement"
        heading="Supplier price lists"
        description="Loading this workspace's price lists."
      />
      <SectionCard title="Loading">
        <Skeleton className="h-40 w-full" />
      </SectionCard>
      <SectionCard title="Loading">
        <Skeleton className="h-64 w-full" />
      </SectionCard>
    </main>
  );
}
