import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export default function PharmacyOrdersLoading() {
  return (
    <div className="min-w-0 space-y-6" aria-busy="true">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Customer orders"
        description="Checking catalogue availability and current orders…"
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,0.65fr)]">
        <SectionCard
          title="Loading branch catalogue"
          titleLevel={2}
          className="min-h-80 animate-pulse"
        />
        <SectionCard
          title="Loading order proposal"
          titleLevel={2}
          className="min-h-64 animate-pulse"
        />
      </div>
    </div>
  );
}
