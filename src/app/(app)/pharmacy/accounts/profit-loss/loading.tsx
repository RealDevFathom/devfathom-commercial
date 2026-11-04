import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export default function Loading() {
  return (
    <main className="min-w-0 space-y-6" aria-busy="true" aria-label="Loading profit and loss">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Profit and loss"
        description="Loading posted-ledger reporting…"
      />
      <SectionCard title="Loading profit and loss">
        <p role="status" className="text-sm text-text-muted">
          Reading authorized branch postings…
        </p>
      </SectionCard>
    </main>
  );
}
