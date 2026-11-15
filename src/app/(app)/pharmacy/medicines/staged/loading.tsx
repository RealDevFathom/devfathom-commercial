import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
export default function Loading() {
  return (
    <div className="min-w-0 space-y-6" aria-busy="true">
      <PageHeader heading="Staged medicines" description="Loading preserved source references." />
      <SectionCard title="Loading review" titleLevel={2}>
        <p role="status">Reading your workspace’s staged candidates. No stock is being posted.</p>
      </SectionCard>
    </div>
  );
}
