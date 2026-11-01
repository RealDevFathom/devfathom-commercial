import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Day close has its own loading state; without it the route would inherit the
 * counter's and briefly read "Counter".
 */
export default function PharmacyDayCloseLoading() {
  return (
    <div className="min-w-0 space-y-6" role="status" aria-label="Loading pharmacy day close">
      <PageHeader eyebrow="Pharmacy" heading="Day close" description="Loading the day close…" />
      <SectionCard title="Loading the business day…">
        <Skeleton className="h-64 w-full" />
      </SectionCard>
    </div>
  );
}
