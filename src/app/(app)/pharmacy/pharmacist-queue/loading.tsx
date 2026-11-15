import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <PageHeader
        eyebrow="Pharmacy · Pharmacist review"
        heading="Pharmacist queue"
        description="Triage in request order, leave an explicit clinical decision, then sign to release."
      />
      <SectionCard title="Loading review queue" titleLevel={2}>
        <div className="h-28 animate-pulse rounded-[var(--radius-sm)] bg-surface-sunken motion-reduce:animate-none" />
      </SectionCard>
    </div>
  );
}
