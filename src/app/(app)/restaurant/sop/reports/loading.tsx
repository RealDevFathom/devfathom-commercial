import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export default function Loading() {
  return (
    <main aria-busy="true" aria-label="Loading SOP report" className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="SOP reports"
        description="Loading report filters and reconciled outcomes."
      />
      <SectionCard title="Loading report">
        <div className="h-24 animate-pulse rounded-[var(--radius-sm)] bg-surface-sunken motion-reduce:animate-none" />
      </SectionCard>
    </main>
  );
}
