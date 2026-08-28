import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function RestaurantSopOversightLoading() {
  return (
    <main
      className="min-w-0 space-y-6"
      role="status"
      aria-busy="true"
      aria-label="Loading SOP oversight"
    >
      <PageHeader
        eyebrow="Restaurant operations"
        heading="SOP oversight"
        description="Loading escalation policies, compliance scores, and audit history…"
        actions={<Skeleton className="h-6 w-28 motion-reduce:animate-none" />}
      />

      <SectionCard eyebrow="Escalation" title="Escalation policies">
        <div className="grid gap-3 lg:grid-cols-[1.4fr_0.8fr_1fr_auto]">
          {[0, 1, 2, 3].map((field) => (
            <Skeleton key={field} className="h-11 w-full motion-reduce:animate-none" />
          ))}
        </div>
        <div className="mt-6 space-y-2">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-14 w-full motion-reduce:animate-none" />
          ))}
        </div>
      </SectionCard>

      <SectionCard eyebrow="Performance" title="Compliance scoring">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((tile) => (
            <Skeleton key={tile} className="h-20 w-full motion-reduce:animate-none" />
          ))}
        </div>
        <Skeleton className="mt-6 h-32 w-full motion-reduce:animate-none" />
      </SectionCard>

      <SectionCard eyebrow="Audit" title="Occurrence audit history">
        <div className="space-y-2">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-14 w-full motion-reduce:animate-none" />
          ))}
        </div>
      </SectionCard>
    </main>
  );
}
