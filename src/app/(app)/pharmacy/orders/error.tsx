'use client';

import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export default function PharmacyOrdersError({ reset }: { reset: () => void }) {
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Customer orders"
        description="The ordering workspace could not be loaded. No order or reservation was changed."
      />
      <SectionCard title="Ordering is temporarily unavailable" titleLevel={2}>
        <p className="text-sm text-text-muted">
          Try loading the protected ordering workspace again.
        </p>
        <Button className="mt-4" onClick={reset}>
          Try again
        </Button>
      </SectionCard>
    </div>
  );
}
