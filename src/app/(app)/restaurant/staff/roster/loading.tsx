import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

const skeletonClass = 'motion-reduce:animate-none';

export default function Loading() {
  return (
    <main aria-busy="true" aria-label="Loading branch roster" className="min-w-0 space-y-6">
      <PageHeader
        eyebrow={<Skeleton className={`${skeletonClass} h-3 w-36`} />}
        heading={<Skeleton className={`${skeletonClass} h-11 w-56 max-w-full`} />}
        description={<Skeleton className={`${skeletonClass} h-4 w-[34rem] max-w-full`} />}
      />

      <SectionCard>
        <Skeleton className={`${skeletonClass} h-6 w-40`} />
        <Skeleton className={`${skeletonClass} mt-2 h-4 w-96 max-w-full`} />
        <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_10rem_10rem_auto]">
          <Skeleton className={`${skeletonClass} h-11`} />
          <Skeleton className={`${skeletonClass} h-11`} />
          <Skeleton className={`${skeletonClass} h-11`} />
          <Skeleton className={`${skeletonClass} h-11 w-32`} />
        </div>
      </SectionCard>

      <SectionCard>
        <Skeleton className={`${skeletonClass} h-6 w-44`} />
        <div className="mt-5 space-y-3">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton className={`${skeletonClass} h-12 w-full`} key={index} />
          ))}
        </div>
      </SectionCard>
    </main>
  );
}
