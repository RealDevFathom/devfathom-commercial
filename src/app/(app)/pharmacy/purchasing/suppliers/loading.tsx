import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

/** UX rule 9: the loading state has the shape of the surface, not a bare spinner. */
export default function PharmacySuppliersLoading() {
  return (
    <div aria-label="Loading Suppliers" className="min-w-0 space-y-6" role="status">
      <PageHeader
        eyebrow="Pharmacy procurement"
        heading="Suppliers"
        description="Loading this workspace's purchasing records."
      />
      <div className="grid gap-6 sm:grid-cols-4">
        {[0, 1, 2, 3].map((tile) => (
          <Skeleton className="h-20 w-full" key={tile} />
        ))}
      </div>
      <SectionCard title="Loading">
        <Skeleton className="h-40 w-full" />
      </SectionCard>
      <SectionCard title="Loading">
        <Skeleton className="h-64 w-full" />
      </SectionCard>
    </div>
  );
}
