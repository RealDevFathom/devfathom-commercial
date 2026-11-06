import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function BranchComparisonLoading() {
  return (
    <main aria-label="Loading Branch comparison" className="min-w-0 space-y-6" role="status">
      <PageHeader
        eyebrow="Owner only"
        heading="Branch comparison"
        description="Comparing sales, margin, lost demand, expiry and khata across branches."
      />
      <SectionCard title="Branch performance" titleLevel={2}>
        <Skeleton className="h-40 w-full" />
      </SectionCard>
    </main>
  );
}
