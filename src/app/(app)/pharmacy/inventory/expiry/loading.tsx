import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function PharmacyExpiryBoardLoading() {
  return (
    <main aria-label="Loading pharmacy expiry board" className="min-w-0 space-y-6" role="status">
      <PageHeader
        eyebrow="Pharmacy operations · INV-09"
        heading="Expiry board"
        description="Loading stock that is close to expiry."
      />
      <Skeleton className="h-24 w-full rounded-[var(--radius-md)]" />
      <SectionCard title="Loading expiring stock">
        <Skeleton className="h-72 w-full" />
      </SectionCard>
    </main>
  );
}
