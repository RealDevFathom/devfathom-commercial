import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export default function PharmacyRegulatoryLoading() {
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Branch regulatory profile"
        description="Province, premises, licence, permitted schedules, qualified person, tax and retention."
      />
      <SectionCard title="Loading this branch’s profile" titleLevel={2}>
        <div aria-hidden className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 8 }, (_, index) => (
            <div className="space-y-2" key={index}>
              <div className="h-3 w-32 animate-pulse rounded bg-muted" />
              <div className="h-11 w-full animate-pulse rounded-md bg-muted" />
            </div>
          ))}
        </div>
        <p className="sr-only">Loading this branch’s regulatory profile.</p>
      </SectionCard>
    </div>
  );
}
