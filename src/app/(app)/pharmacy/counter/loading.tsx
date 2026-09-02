import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function PharmacyCounterLoading() {
  return (
    <div className="min-w-0 space-y-6" role="status" aria-label="Loading pharmacy counter">
      <PageHeader eyebrow="Pharmacy" heading="Counter" description="Loading the counter…" />
      <SectionCard title="Loading the counter…">
        <Skeleton className="h-64 w-full" />
      </SectionCard>
    </div>
  );
}
