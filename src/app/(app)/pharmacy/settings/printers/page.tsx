import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import type { Metadata } from 'next';

import { PharmacyPrinterSettingsConsole } from '@/components/pharmacy/printer-settings';
import { PageHeader } from '@/components/ui/page-header';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Pharmacy printer settings' };

/**
 * DEV-742 — branch receipt printer and paper, plus a test print. The save
 * procedure enforces the administrator rule; `canSave` only shapes the form.
 */
export default async function PharmacyPrinterSettingsPage() {
  const ctx = await createTRPCContext();
  const canSave = ctx.session?.user?.role === 'ADMIN';
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Printer settings"
        actions={
          <Link
            className={buttonVariants({ variant: 'outline', size: 'touch' })}
            href="/pharmacy/settings/receipts"
          >
            Receipt design
          </Link>
        }
        description="Choose each branch's receipt paper — thermal 58 mm, thermal 80 mm or A4 — print a test page, and set up the print bridge for a thermal printer."
      />
      <PharmacyPrinterSettingsConsole canSave={canSave} />
    </div>
  );
}
