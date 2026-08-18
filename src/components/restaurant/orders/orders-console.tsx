'use client';

import { PageHeader } from '@/components/ui/page-header';

export function OrdersConsole() {
  return (
    <div className="min-w-0">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Orders"
        description="Review order activity and operational detail."
      />
    </div>
  );
}
