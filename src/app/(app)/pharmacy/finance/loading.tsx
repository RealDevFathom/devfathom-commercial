import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <PageHeader
        eyebrow="Pharmacy operations"
        heading="Finance"
        description="Loading bookkeeping and tax controls…"
      />
      <SectionCard title="Loading finance">
        <div className="h-28 animate-pulse rounded-[var(--radius-sm)] bg-surface-sunken motion-reduce:animate-none" />
      </SectionCard>
    </div>
  );
}
