import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function PharmacyReportsLoading() {
  return (
    <div aria-label="Loading Pharmacy reports" className="min-w-0 space-y-6" role="status">
      <PageHeader
        eyebrow="Pharmacy operations"
        heading="Reports"
        description="Loading ledger-derived reporting."
      />
      <SectionCard title="Report filters">
        <Skeleton className="h-20 w-full" />
      </SectionCard>
      <SectionCard title="Loading command centre">
        <Skeleton className="h-32 w-full" />
      </SectionCard>
      <SectionCard title="Loading daily owner digest">
        <Skeleton className="h-40 w-full" />
      </SectionCard>
    </div>
  );
}
