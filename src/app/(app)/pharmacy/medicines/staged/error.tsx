'use client';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';
export default function Error({ unstable_retry }: { unstable_retry: () => void }) {
  return (
    <SectionCard title="Source review unavailable" titleLevel={2}>
      <p className="mb-4 text-sm" role="alert">
        The preserved references could not be loaded. Retry or contact your workspace administrator.
        No stock was posted by this review.
      </p>
      <Button className="min-h-11" onClick={unstable_retry}>
        Retry
      </Button>
    </SectionCard>
  );
}
