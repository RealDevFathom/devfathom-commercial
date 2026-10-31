import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function RestaurantNotificationsLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading notifications center"
      className="min-w-0 space-y-6"
      role="status"
    >
      <PageHeader
        eyebrow="Restaurant operations"
        eyebrowMuted
        heading="Notifications center"
        description="Loading in-app alerts, delivery records, and routing controls."
      />
      <span className="sr-only">Loading notifications center.</span>
      <SectionCard>
        <Skeleton className="h-5 w-48 motion-reduce:animate-none" />
        <Skeleton className="mt-3 h-4 w-full max-w-3xl motion-reduce:animate-none" />
      </SectionCard>
      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(20rem,0.75fr)]">
        <SectionCard>
          <div className="space-y-4">
            {[0, 1, 2].map((item) => (
              <Skeleton key={item} className="h-36 w-full motion-reduce:animate-none" />
            ))}
          </div>
        </SectionCard>
        <SectionCard>
          <div className="space-y-3">
            {[0, 1, 2, 3, 4].map((item) => (
              <Skeleton key={item} className="h-16 w-full motion-reduce:animate-none" />
            ))}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
