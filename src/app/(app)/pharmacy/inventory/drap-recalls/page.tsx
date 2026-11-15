import type { Metadata } from 'next';

import { DrapRecallReview } from '@/components/pharmacy/drap-recall-review';
import { PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'DRAP recall alerts' };

export default function DrapRecallAlertsPage() {
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy / inventory"
        heading="DRAP recall alerts"
        description="Confirm or dismiss each alert parsed from DRAP's recall pages. Stock is quarantined only after a person confirms."
      />
      <DrapRecallReview />
    </div>
  );
}
