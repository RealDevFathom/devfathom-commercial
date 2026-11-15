import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
export default function Loading() {
  return (
    <div className="min-w-0 space-y-6" aria-busy="true">
      <PageHeader
        eyebrow="Pharmacy reports"
        heading="Repeat purchasing"
        description="Reading selected authorized branches."
      />
      <SectionCard title="Calculating cohorts" titleLevel={2}>
        <p role="status" className="text-sm text-text-muted">
          Checking complete follow-up and identification coverage. Rates appear only after the full
          bounded scope is read.
        </p>
      </SectionCard>
    </div>
  );
}
