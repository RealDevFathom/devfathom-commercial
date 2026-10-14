'use client';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';
export default function HealthError({
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <SectionCard title="Health data unavailable" titleLevel={2}>
      <p role="alert" className="mb-4">
        The health snapshot could not be loaded. Refresh to try again.
      </p>
      <Button className="min-h-11" onClick={unstable_retry}>
        Try again
      </Button>
    </SectionCard>
  );
}
