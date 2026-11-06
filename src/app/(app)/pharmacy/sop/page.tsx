import type { Metadata } from 'next';
import { Suspense } from 'react';

import { PharmacySopWorkspace } from '@/components/pharmacy/sop/pharmacy-sop-workspace';
import { PharmacySopSkeleton } from '@/components/pharmacy/sop/sop-skeleton';

export const metadata: Metadata = { title: 'Procedures' };

/**
 * DEV-751 — pharmacy procedures on the shared SOP engine. The workspace reads
 * its branch, tab and open procedure from the URL, so it sits inside its own
 * Suspense boundary (`useSearchParams`); access is decided by the server
 * through `pharmacySop.access`, never by this page.
 */
export default function PharmacySopPage() {
  return (
    <Suspense fallback={<PharmacySopSkeleton />}>
      <PharmacySopWorkspace />
    </Suspense>
  );
}
