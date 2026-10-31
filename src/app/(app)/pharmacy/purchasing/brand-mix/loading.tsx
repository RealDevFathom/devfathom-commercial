import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export default function BrandMixLoading() {
  return (
    <main className="min-w-0 space-y-6" role="status" aria-label="Loading Brand mix">
      <PageHeader
        eyebrow="Pharmacy procurement"
        heading="Brand mix"
        description="Loading branch and medicine choices for purchasing review."
      />
      <SectionCard title="Loading comparison">
        <p className="text-sm text-text-muted">
          Reading exact equivalents and reservation-aware availability.
        </p>
      </SectionCard>
    </main>
  );
}
