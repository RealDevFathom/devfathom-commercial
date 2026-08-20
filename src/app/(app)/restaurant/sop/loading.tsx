import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

const skeletonClass = 'motion-reduce:animate-none';

export default function Loading() {
  return (
    <main aria-busy="true" aria-label="Loading branch SOP board" className="min-w-0 space-y-6">
      <PageHeader
        eyebrow={<Skeleton className={`${skeletonClass} h-3 w-36`} />}
        heading={<Skeleton className={`${skeletonClass} h-11 w-72 max-w-full`} />}
        description={<Skeleton className={`${skeletonClass} h-4 w-[34rem] max-w-full`} />}
      />

      <SectionCard>
        <Skeleton className={`${skeletonClass} h-6 w-32`} />
        <Skeleton className={`${skeletonClass} mt-2 h-4 w-80 max-w-full`} />
        <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <Skeleton className={`${skeletonClass} h-11`} />
          <Skeleton className={`${skeletonClass} h-11`} />
          <Skeleton className={`${skeletonClass} h-11 w-28`} />
        </div>
      </SectionCard>

      <section
        aria-label="Loading SOP summary"
        className="grid grid-cols-2 gap-4 sm:grid-cols-4 xl:grid-cols-7"
      >
        {Array.from({ length: 7 }, (_, index) => (
          <div className="space-y-2" key={index}>
            <Skeleton className={`${skeletonClass} h-3 w-20`} />
            <Skeleton className={`${skeletonClass} h-9 w-12`} />
          </div>
        ))}
      </section>

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <SectionCard>
          <div className="flex items-center justify-between gap-3">
            <Skeleton className={`${skeletonClass} h-6 w-36`} />
            <Skeleton className={`${skeletonClass} h-3 w-20`} />
          </div>
          <div className="mt-5 space-y-5">
            {Array.from({ length: 4 }, (_, index) => (
              <div className="space-y-3 border-b border-border-subtle pb-5" key={index}>
                <Skeleton className={`${skeletonClass} h-5 w-28`} />
                <Skeleton className={`${skeletonClass} h-20 w-full`} />
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <Skeleton className={`${skeletonClass} h-3 w-40`} />
              <Skeleton className={`${skeletonClass} h-7 w-64 max-w-full`} />
              <Skeleton className={`${skeletonClass} h-4 w-28`} />
            </div>
            <Skeleton className={`${skeletonClass} h-5 w-20 rounded-full`} />
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton className={`${skeletonClass} h-16`} key={index} />
            ))}
          </div>
          <div className="mt-6 space-y-4 border-t border-border-subtle pt-5">
            <Skeleton className={`${skeletonClass} h-5 w-24`} />
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton className={`${skeletonClass} h-24 w-full`} key={index} />
            ))}
          </div>
        </SectionCard>
      </div>
    </main>
  );
}
