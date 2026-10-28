import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export default function Loading() {
  return (
    <main className="min-w-0 space-y-6" aria-busy="true">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Fiscal exception evidence"
        description="Checking report access and current exception evidence."
      />
      <SectionCard title="Loading evidence" titleLevel={2}>
        <p role="status" className="text-sm text-text-muted">
          Verifying branch scope before reading fiscal exception evidence.
        </p>
      </SectionCard>
    </main>
  );
}
