import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy="true"
      aria-label="Loading inventory console"
    >
      <div className="space-y-3">
        <Skeleton className="h-3 w-36 motion-reduce:animate-none" />
        <Skeleton className="h-12 w-72 max-w-full motion-reduce:animate-none" />
        <Skeleton className="h-5 w-[32rem] max-w-full motion-reduce:animate-none" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton
            className="h-32 rounded-[var(--radius-md)] motion-reduce:animate-none"
            key={index}
          />
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Skeleton className="h-[30rem] rounded-[var(--radius-md)] motion-reduce:animate-none" />
        <Skeleton className="h-[30rem] rounded-[var(--radius-md)] motion-reduce:animate-none" />
      </div>
      <Skeleton className="h-[24rem] rounded-[var(--radius-md)] motion-reduce:animate-none" />
      <div className="grid gap-6 xl:grid-cols-2">
        <Skeleton className="h-[26rem] rounded-[var(--radius-md)] motion-reduce:animate-none" />
        <Skeleton className="h-[26rem] rounded-[var(--radius-md)] motion-reduce:animate-none" />
      </div>
    </div>
  );
}
