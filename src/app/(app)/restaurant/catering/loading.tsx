import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function CateringLoading() {
  return (
    <div>
      <PageHeader
        eyebrow="Restaurant"
        heading="Catering"
        description="Loading catering operations…"
      />
      <SectionCard title="Loading catering orders…" titleLevel={2}>
        <Skeleton className="h-48 w-full" />
      </SectionCard>
    </div>
  );
}
