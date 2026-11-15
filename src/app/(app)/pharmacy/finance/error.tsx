'use client';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Pharmacy operations"
        heading="Finance"
        description="Bookkeeping and tax controls are temporarily unavailable."
      />
      <SectionCard title="Finance could not load">
        <p className="text-sm text-text-muted">
          No data was changed. Retry the request or contact your workspace administrator if it
          continues.
        </p>
        <Button className="mt-4" onClick={reset} variant="secondary">
          Try again
        </Button>
      </SectionCard>
    </div>
  );
}
