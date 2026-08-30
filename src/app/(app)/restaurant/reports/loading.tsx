import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function RestaurantReportsLoading() {
  return (
    <main aria-label="Loading Restaurant reports" className="min-w-0 space-y-6" role="status">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Reports"
        description="Loading bounded closed-day reporting."
      />
      <SectionCard title="Report filters">
        <Skeleton className="h-20 w-full" />
      </SectionCard>
      {Array.from({ length: 6 }, (_, index) => (
        <SectionCard key={index} title="Loading section">
          <Skeleton className="h-32 w-full" />
        </SectionCard>
      ))}
    </main>
  );
}
