'use client';

import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export default function PharmacyRefillProgramError({ reset }: { reset: () => void }) {
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Refill program"
        description="The refill program could not be loaded. No subscription, cycle or stock hold was changed."
      />
      <SectionCard title="Refill program is temporarily unavailable" titleLevel={2}>
        <p className="text-sm text-text-muted">Try loading the refill program again.</p>
        <Button className="mt-4" onClick={reset}>
          Try again
        </Button>
      </SectionCard>
    </div>
  );
}
