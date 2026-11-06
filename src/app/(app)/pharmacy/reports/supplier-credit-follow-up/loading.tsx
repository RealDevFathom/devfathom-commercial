import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function SupplierCreditFollowUpLoading() {
  return (
    <main
      aria-label="Loading Supplier-credit follow-up"
      className="min-w-0 space-y-6"
      role="status"
    >
      <PageHeader
        eyebrow="Pharmacy reports"
        heading="Supplier-credit follow-up"
        description="Reading recorded returns, debit notes and supplier credit."
      />
      <SectionCard title="Prepare follow-up" titleLevel={2}>
        <Skeleton className="h-20 w-full" />
      </SectionCard>
      <SectionCard title="Loading draft evidence" titleLevel={2}>
        <Skeleton className="h-32 w-full" />
      </SectionCard>
    </main>
  );
}
