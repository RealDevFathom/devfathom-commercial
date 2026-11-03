import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function PharmacyReportsLoading() {
  return (
    <main aria-label="Loading Pharmacy reports" className="min-w-0 space-y-6" role="status">
      <PageHeader
        eyebrow="Pharmacy operations"
        heading="Reports"
        description="Loading your reports."
      />
      <SectionCard title="Report filters">
        <Skeleton className="h-20 w-full" />
      </SectionCard>
      <SectionCard title="Loading overview">
        <Skeleton className="h-32 w-full" />
      </SectionCard>
      <SectionCard title="Loading daily owner digest">
        <Skeleton className="h-40 w-full" />
      </SectionCard>
    </main>
  );
}
