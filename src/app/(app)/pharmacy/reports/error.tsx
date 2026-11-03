'use client';

import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export default function PharmacyReportsError({ reset }: { reset: () => void }) {
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy operations"
        heading="Reports"
        description="Sales, stock, expiry and supplier reports for your pharmacy."
      />
      <SectionCard title="Reports could not load">
        <p className="text-sm text-text-muted">
          No settings were changed. Check your connection and try again.
        </p>
        <Button className="mt-4" onClick={reset} variant="secondary">
          Try again
        </Button>
      </SectionCard>
    </main>
  );
}
