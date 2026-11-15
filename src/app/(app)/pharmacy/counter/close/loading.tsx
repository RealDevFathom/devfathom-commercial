import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function PharmacyDayCloseLoading() {
  return (
    <div className="min-w-0 space-y-6" role="status" aria-label="Loading day close">
      <PageHeader eyebrow="Pharmacy" heading="Day close" description="Loading day close…" />
      <SectionCard title="Loading day close…">
        <Skeleton className="h-64 w-full" />
      </SectionCard>
    </div>
  );
}
