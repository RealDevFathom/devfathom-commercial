import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';

const skeletonClass = 'motion-reduce:animate-none';

export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading sales command" className="mx-auto max-w-[1600px]">
      <PageHeader
        eyebrow={<Skeleton className={`${skeletonClass} h-3 w-40`} />}
        heading={<Skeleton className={`${skeletonClass} h-12 w-72 max-w-full`} />}
        description={<Skeleton className={`${skeletonClass} h-5 w-[40rem] max-w-full`} />}
      />

      <section aria-label="Loading opportunity board" className="mt-7">
        <div className="mb-3 flex items-end justify-between gap-4">
          <div className="space-y-2">
            <Skeleton className={`${skeletonClass} h-3 w-24`} />
            <Skeleton className={`${skeletonClass} h-7 w-52`} />
          </div>
          <Skeleton className={`${skeletonClass} h-3 w-16`} />
        </div>
        <div className="grid auto-cols-[260px] grid-flow-col gap-3 overflow-hidden pb-3">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton
              className={`${skeletonClass} h-64 min-w-[260px] rounded-[var(--radius-lg)]`}
              key={index}
            />
          ))}
        </div>
      </section>

      <div className="mt-7 grid gap-7 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-7">
          <Skeleton className={`${skeletonClass} h-80 rounded-[var(--radius-md)]`} />
          <Skeleton className={`${skeletonClass} h-64 rounded-[var(--radius-md)]`} />
          <Skeleton className={`${skeletonClass} h-56 rounded-[var(--radius-md)]`} />
        </div>
        <div className="space-y-7">
          <Skeleton className={`${skeletonClass} h-72 rounded-[var(--radius-md)]`} />
          <Skeleton className={`${skeletonClass} h-14 rounded-[var(--radius-sm)]`} />
          <Skeleton className={`${skeletonClass} h-14 rounded-[var(--radius-sm)]`} />
        </div>
      </div>
    </div>
  );
}
