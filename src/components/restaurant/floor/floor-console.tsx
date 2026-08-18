'use client';

import { PageHeader } from '@/components/ui/page-header';

export function FloorConsole() {
  return (
    <div className="min-w-0">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Floor"
        description="Manage floors, tables, sections, and kitchen routing."
      />
    </div>
  );
}
