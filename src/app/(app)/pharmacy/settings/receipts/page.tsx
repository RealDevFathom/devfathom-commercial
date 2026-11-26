import type { Metadata } from 'next';
import Link from 'next/link';
import { PharmacyReceiptDesigner } from '@/components/pharmacy/receipt-designer';
import { PageHeader } from '@/components/ui/page-header';
import { buttonVariants } from '@/components/ui/button';
import { createTRPCContext } from '@/server/trpc';
export const metadata: Metadata = { title: 'Pharmacy receipt design' };
export default async function ReceiptSettingsPage() {
  const ctx = await createTRPCContext();
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy settings"
        heading="Receipt design"
        description="Choose how this branch presents its branding on customer receipts."
        actions={
          <Link
            className={buttonVariants({ variant: 'outline', size: 'touch' })}
            href="/pharmacy/settings/printers"
          >
            Printer settings
          </Link>
        }
      />
      <PharmacyReceiptDesigner canSave={ctx.session?.user.role === 'ADMIN'} />
    </div>
  );
}
