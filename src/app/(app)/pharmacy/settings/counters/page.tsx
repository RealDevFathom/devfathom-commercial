import type { Metadata } from 'next';

import { PharmacyCounterComputersConsole } from '@/components/pharmacy/counter-computers';
import { PageHeader } from '@/components/ui/page-header';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Counter computers' };

/**
 * DEV-957 — enrol a computer as a pharmacy counter, prepare it for offline
 * selling, and rotate or revoke counters. Every procedure enforces the
 * administrator and branch rules on the server; `canManage` only shapes the page.
 */
export default async function PharmacyCounterComputersPage() {
  const ctx = await createTRPCContext();
  const canManage = ctx.session?.user?.role === 'ADMIN';
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Counter computers"
        description="Enrol the computers that sell at the counter, prepare them to keep working when the internet is down, and revoke one that is lost or replaced."
      />
      <PharmacyCounterComputersConsole
        canManage={canManage}
        organizationId={ctx.entitlements?.organizationId ?? ''}
      />
    </div>
  );
}
