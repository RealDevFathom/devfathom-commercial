import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function RestaurantCatalogLoading() {
  return (
    <div className="min-w-0 space-y-6" role="status" aria-label="Loading restaurant catalog">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Catalog"
        description="Loading canonical catalog data…"
      />
      <SectionCard title="Loading catalog…">
        <div className="space-y-3">
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} className="h-12 w-full" />
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
