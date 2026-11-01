import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function OpeningStockImportLoading() {
  return (
    <main aria-label="Loading opening stock import" className="min-w-0 space-y-6" role="status">
      <PageHeader
        eyebrow="Pharmacy inventory · Owner setup"
        heading="Import opening stock"
        description="Loading your branches and stock locations."
      />
      <Skeleton className="h-24 w-full rounded-[var(--radius-md)]" />
      <SectionCard title="Loading import setup">
        <Skeleton className="h-72 w-full" />
      </SectionCard>
    </main>
  );
}
