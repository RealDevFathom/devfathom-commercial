import type { Metadata } from 'next';

import { RefillProgramConsole } from '@/components/pharmacy/refill-program-console';
import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Refill program' };

export default function PharmacyRefillProgramPage() {
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Refill program"
        description="Monthly packs for chronic medicines: stock is held each cycle, and prescription-only cycles wait for a covering prescription and a pharmacist's signature."
        actions={
          <Link href="/pharmacy/orders" className={buttonVariants({ variant: 'outline' })}>
            Customer orders
          </Link>
        }
      />
      <RefillProgramConsole />
    </div>
  );
}
