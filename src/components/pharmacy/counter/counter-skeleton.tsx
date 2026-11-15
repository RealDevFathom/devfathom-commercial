import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';

export function CounterSkeleton() {
  return (
    <div
      className="pos-calm h-full min-h-0 overflow-y-auto bg-surface-page px-4 pt-3 pb-28 xl:pb-4"
      role="status"
      aria-label="Loading pharmacy counter"
    >
      <span className="sr-only">Loading pharmacy counter…</span>
      <header className="mb-3 space-y-3" aria-hidden="true">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-text-strong">Counter</h1>
          <Skeleton className="h-11 w-36" />
          <Skeleton className="h-11 w-28" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-11 w-28" />
          <Skeleton className="h-11 w-28" />
          <Skeleton className="h-11 w-28" />
        </div>
      </header>
      <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_20rem]" aria-hidden="true">
        <SectionCard className="overflow-hidden rounded-xl p-0" aria-label="Counter bill">
          <div className="space-y-3 border-b border-border-subtle p-4">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-11 w-full" />
          </div>
          <div className="space-y-3 p-4" aria-label="Cart">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        </SectionCard>
        <aside className="min-w-0 xl:sticky xl:top-0" aria-label="Bill total">
          <SectionCard className="space-y-3 rounded-xl p-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-11 w-full" />
          </SectionCard>
        </aside>
      </div>
    </div>
  );
}
