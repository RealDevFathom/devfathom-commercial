import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function ImportedStockLoading() {
  return (
    <main aria-label="Loading imported stock" className="min-w-0 space-y-6" role="status">
      <PageHeader
        eyebrow="Pharmacy inventory · Awaiting verification"
        heading="Imported stock"
        description="Loading imported stock references."
      />
      <Skeleton className="h-24 w-full rounded-[var(--radius-md)]" />
      <SectionCard title="Loading imported medicine references">
        <Skeleton className="h-72 w-full" />
      </SectionCard>
    </main>
  );
}
