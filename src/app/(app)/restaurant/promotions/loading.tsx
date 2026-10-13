import { Skeleton } from '@/components/ui/skeleton';

export default function RestaurantPromotionsLoading() {
  return (
    <div role="status" aria-label="Loading offers" className="space-y-6">
      <Skeleton className="h-28 w-full motion-reduce:animate-none" />
      <Skeleton className="h-80 w-full motion-reduce:animate-none" />
    </div>
  );
}
