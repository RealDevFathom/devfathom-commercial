import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function RestaurantSopAdminLoading() {
  return (
    <div
      className="min-w-0 space-y-6"
      role="status"
      aria-busy="true"
      aria-label="Loading SOP administration"
    >
      <PageHeader
        eyebrow="Restaurant operations"
        heading="SOP administration"
        description="Loading templates, immutable versions, and branch schedules…"
        actions={<Skeleton className="h-6 w-28 motion-reduce:animate-none" />}
      />

      <SectionCard eyebrow="sop.templates.max" title="Template library">
        <div className="grid gap-3 lg:grid-cols-[1fr_0.7fr_1.4fr_auto]">
          <Skeleton className="h-11 w-full motion-reduce:animate-none" />
          <Skeleton className="h-11 w-full motion-reduce:animate-none" />
          <Skeleton className="h-11 w-full motion-reduce:animate-none" />
          <Skeleton className="h-11 w-32 motion-reduce:animate-none" />
        </div>
        <div className="mt-6 space-y-2">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-14 w-full motion-reduce:animate-none" />
          ))}
        </div>
      </SectionCard>

      <SectionCard eyebrow="Version workspace" title="Loading procedure…">
        <div className="mb-5 flex flex-wrap gap-2">
          {[0, 1, 2].map((version) => (
            <Skeleton key={version} className="h-8 w-24 motion-reduce:animate-none" />
          ))}
        </div>
        <div className="space-y-3">
          {[0, 1, 2, 3].map((step) => (
            <Skeleton key={step} className="h-16 w-full motion-reduce:animate-none" />
          ))}
        </div>
      </SectionCard>

      <SectionCard eyebrow="Branch schedules" title="Assignments">
        <div className="grid gap-6 xl:grid-cols-[minmax(18rem,0.72fr)_minmax(0,1.28fr)]">
          <div className="space-y-3">
            {[0, 1, 2, 3, 4].map((field) => (
              <Skeleton key={field} className="h-11 w-full motion-reduce:animate-none" />
            ))}
          </div>
          <div className="space-y-2 xl:border-l xl:border-border-subtle xl:pl-6">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-16 w-full motion-reduce:animate-none" />
            ))}
          </div>
        </div>
      </SectionCard>

      <SectionCard eyebrow="Contract boundary" title="Escalation policies">
        <Skeleton className="h-16 w-full max-w-3xl motion-reduce:animate-none" />
      </SectionCard>
    </div>
  );
}
