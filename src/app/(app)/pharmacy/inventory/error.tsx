'use client';

import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export default function PharmacyInventoryError({ reset }: { reset: () => void }) {
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy operations"
        heading="Inventory"
        description="Lots, counts, transfers, recalls, and stock actions."
      />
      <SectionCard title="Inventory could not load">
        <p className="text-sm text-text-muted">
          No stock was changed. Check your connection and try loading the board again.
        </p>
        <Button className="mt-4" onClick={reset} variant="secondary">
          Try again
        </Button>
      </SectionCard>
    </div>
  );
}
