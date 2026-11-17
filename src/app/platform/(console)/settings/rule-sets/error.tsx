'use client';

import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';

export default function RuleSetsError({ reset }: { reset: () => void }) {
  return (
    <SectionCard title="Jurisdiction rules could not be loaded">
      <p className="mb-4 text-sm text-text-muted">
        Reload the published versions before drafting a new one.
      </p>
      <Button onClick={reset}>Try again</Button>
    </SectionCard>
  );
}
