import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function FiscalExceptionsLoading() {
  return (
    <main className="min-w-0 space-y-6" role="status" aria-label="Loading fiscal exception evidence">
      <PageHeader eyebrow="Pharmacy accounts" heading="Fiscal exception evidence"
        description="Checking access and reading bounded local evidence." />
      <SectionCard title="Loading evidence"><Skeleton className="h-32 w-full" /></SectionCard>
    </main>
  );
}
