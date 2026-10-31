'use client';

import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export default function FiscalExceptionsError({ reset }: { reset: () => void }) {
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader eyebrow="Pharmacy accounts" heading="Fiscal exception evidence"
        description="Current-state local fiscal evidence." />
      <SectionCard title="Evidence unavailable">
        <p role="alert" className="text-sm text-text-muted">Evidence could not be loaded. Try again or contact support.</p>
        <Button onClick={reset} variant="secondary" size="touch" className="mt-4">Try again</Button>
      </SectionCard>
    </main>
  );
}
