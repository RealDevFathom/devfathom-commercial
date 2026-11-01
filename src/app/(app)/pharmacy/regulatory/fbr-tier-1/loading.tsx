import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export default function PharmacyFbrTier1Loading() {
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy · FBR"
        heading="Am I Tier-1?"
        description="A self-check for whether FBR point-of-sale integration applies to this business."
      />
      <SectionCard title="Loading your latest answer" titleLevel={2}>
        <div aria-hidden className="space-y-4">
          {Array.from({ length: 5 }, (_, index) => (
            <div className="space-y-2" key={index}>
              <div className="h-3 w-64 max-w-full animate-pulse rounded bg-muted" />
              <div className="h-11 w-full max-w-sm animate-pulse rounded-md bg-muted" />
            </div>
          ))}
        </div>
        <p className="sr-only">Loading the FBR Tier-1 self-check.</p>
      </SectionCard>
    </main>
  );
}
