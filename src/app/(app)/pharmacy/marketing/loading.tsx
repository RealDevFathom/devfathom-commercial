import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
export default function LoadingMarketing() {
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrowMuted
        className="[&_p]:text-text-body [&_[data-slot=eyebrow]]:text-text-body"
        eyebrow="Pharmacy"
        heading="Marketing"
        description="Loading your branch and campaign history."
      />
      <SectionCard title="Loading workspace" titleLevel={2}>
        <p role="status" className="text-sm text-text-muted">
          Checking access and fetching saved campaigns…
        </p>
      </SectionCard>
    </div>
  );
}
