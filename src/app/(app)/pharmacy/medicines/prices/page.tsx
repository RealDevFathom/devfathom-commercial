import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { PriceNotices } from '@/components/pharmacy/medicines/price-notices';

export const metadata: Metadata = { title: 'Medicine price intelligence' };

export default function MedicinePricesPage() {
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy / medicines"
        heading="Price intelligence"
        description="Review DRAP notices against organization pack prices. All amounts are PKR; batch printed MRP remains historical evidence."
      />
      <PriceNotices />
    </div>
  );
}
