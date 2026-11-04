import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PharmacyPrinterSettings } from '@/components/pharmacy/printer-settings/printer-settings-console';
import { PageHeader } from '@/components/ui/page-header';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';

export const metadata: Metadata = { title: 'Pharmacy printers' };

/**
 * DEV-742: pharmacy branch printer settings and test print. Pharmacy only (DEV-355): it
 * holds no restaurant kitchen routing, print bridge or KOT settings. The session decides
 * the organization; branch reads and saves are re-authorized by the pharmacy router.
 */
export default async function PharmacyPrinterSettingsPage() {
  const actor = await resolveTenantActor();
  if (actor?.organization.vertical !== 'PHARMACY') notFound();
  // Shapes the UI only. `counterSaveReceiptFormat` is an admin procedure on the server.
  const canEdit = actor.session.user?.role === 'ADMIN';
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Printers"
        description="Choose each branch’s receipt paper — thermal 58 mm, thermal 80 mm or A4 — and print a test page to check the printer."
      />
      <PharmacyPrinterSettings canEdit={canEdit} />
    </main>
  );
}
