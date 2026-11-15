import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export default function Loading() {
  return (
    <main className="min-w-0 space-y-6" aria-busy="true" aria-label="Loading posted cash coverage">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Posted cash coverage"
        description="Loading posted-ledger balances…"
      />
      <SectionCard title="Loading posted cash coverage">
        <p role="status" className="text-sm text-text-muted">
          Reading authorized branch postings…
        </p>
      </SectionCard>
    </main>
  );
}
