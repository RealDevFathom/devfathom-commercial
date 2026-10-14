import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function RestaurantMenusLoading() {
  return (
    <div className="min-w-0 space-y-6" role="status" aria-label="Loading restaurant menus">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Menus & publishing"
        description="Loading brands, menus, price lists, and branch publications…"
      />
      <div className="grid gap-5 xl:grid-cols-3">
        {[0, 1, 2].map((panel) => (
          <SectionCard key={panel} title="Loading workspace…">
            <div className="space-y-3">
              {[0, 1, 2, 3].map((row) => (
                <Skeleton key={row} className="h-11 w-full" />
              ))}
            </div>
          </SectionCard>
        ))}
      </div>
    </div>
  );
}
