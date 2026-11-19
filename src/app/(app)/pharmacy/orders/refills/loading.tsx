import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export default function PharmacyRefillProgramLoading() {
  return (
    <div className="min-w-0 space-y-6" aria-busy="true">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Refill program"
        description="Loading refill subscriptions…"
      />
      <SectionCard
        title="Loading refill subscriptions"
        titleLevel={2}
        className="min-h-64 animate-pulse"
      />
    </div>
  );
}
