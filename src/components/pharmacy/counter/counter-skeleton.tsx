import { Skeleton } from '@/components/ui/skeleton';

import { CounterActionBarSkeleton, CounterFrame } from './counter-frame';

/**
 * DEV-977 (Counter v2, state B6) — the counter while it loads: its own bars, then the
 * search, bill and payment column in the same places as the loaded screen.
 */
export function CounterSkeleton() {
  return (
    <CounterFrame actionBar={<CounterActionBarSkeleton />}>
      <div
        className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:overflow-hidden xl:grid-cols-[minmax(0,1fr)_380px]"
        role="status"
        aria-label="Loading pharmacy counter"
      >
        <span className="sr-only">Loading pharmacy counter…</span>
        <div
          aria-hidden="true"
          data-counter-skeleton-bill=""
          className="min-w-0 lg:flex lg:min-h-0 lg:flex-col lg:border-e lg:border-border-subtle"
        >
          <div className="border-b border-border-subtle px-4 py-3 lg:px-6 lg:pt-4 lg:pb-3.5">
            <div className="flex min-h-14 items-center gap-3 rounded-[var(--radius-sm)] border border-border-default bg-surface-card px-3.5">
              <Skeleton className="h-4 w-1/2" />
            </div>
            <div className="mt-2.5 flex gap-2">
              <Skeleton className="h-11 w-36 rounded-full" />
              <Skeleton className="h-11 w-44 rounded-full" />
              <Skeleton className="h-11 w-36 rounded-full" />
            </div>
          </div>
          <div className="space-y-6 px-4 py-4 lg:px-6">
            {['w-3/5', 'w-1/2', 'w-2/3'].map((width) => (
              <div key={width} className="grid grid-cols-[minmax(0,1fr)_6rem] gap-x-6 gap-y-2.5">
                <Skeleton className={`h-3.5 ${width}`} />
                <Skeleton className="h-3.5" />
                <Skeleton className="h-3 w-2/5" />
              </div>
            ))}
          </div>
        </div>
        <div
          aria-hidden="true"
          data-counter-skeleton-total=""
          className="space-y-3.5 p-4 lg:overflow-y-auto lg:bg-surface-card lg:p-5"
        >
          <div className="space-y-2.5 rounded-2xl border border-border-subtle bg-surface-card px-4 py-3.5">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-3 w-2/5" />
          </div>
          <div className="space-y-2 rounded-2xl bg-surface-sunken px-4 py-3.5">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-8 w-2/3" />
          </div>
          <Skeleton className="h-14 w-full rounded-[var(--radius-sm)]" />
        </div>
      </div>
    </CounterFrame>
  );
}
