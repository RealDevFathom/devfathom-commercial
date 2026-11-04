import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

const pulse = 'motion-reduce:animate-none';

/** The Procedures workspace while it loads, in the same geometry as the loaded page. */
export function PharmacySopSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading procedures"
      className="min-w-0 space-y-6"
    >
      <PageHeader
        eyebrow="Pharmacy"
        heading="Procedures"
        description="Loading this branch's procedures."
      />
      <Skeleton className={`${pulse} h-8 w-80 max-w-full`} />
      <div className="grid grid-cols-1 gap-4 rounded-lg border border-border-subtle bg-card p-5 min-[420px]:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div className="space-y-2" key={index}>
            <Skeleton className={`${pulse} h-3 w-24`} />
            <Skeleton className={`${pulse} h-9 w-12`} />
          </div>
        ))}
      </div>
      <div className="grid min-w-0 gap-6 xl:grid-cols-2">
        {Array.from({ length: 2 }, (_, card) => (
          <SectionCard key={card}>
            <Skeleton className={`${pulse} h-6 w-32`} />
            <div className="mt-4 space-y-2">
              {Array.from({ length: 3 }, (_, row) => (
                <Skeleton className={`${pulse} h-20 w-full`} key={row} />
              ))}
            </div>
          </SectionCard>
        ))}
      </div>
    </div>
  );
}
