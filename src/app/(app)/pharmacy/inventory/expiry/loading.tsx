import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div role="status" aria-label="Loading Expiry board" className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy operations"
        heading="Expiry board"
        description="Loading expiring stock and supplier return windows."
      />
      <SectionCard title="Loading expiry board">
        <Skeleton className="h-32 w-full" />
      </SectionCard>
    </div>
  );
}
