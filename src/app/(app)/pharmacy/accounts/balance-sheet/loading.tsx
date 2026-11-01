import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export default function Loading() {
  return (
    <main className="min-w-0 space-y-6" aria-busy="true">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Balance sheet"
        description="Classifying canonical posted balances."
      />
      <SectionCard title="Loading report">
        <p className="text-sm text-text-muted">Reading authorized posted balances…</p>
      </SectionCard>
    </main>
  );
}
