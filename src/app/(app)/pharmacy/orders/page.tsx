import type { Metadata } from 'next';

import { PharmacyCustomerOrderingConsole } from '@/components/pharmacy/customer-ordering-console';
import { CustomerPortalPanel } from '@/components/pharmacy/customer-portal-panel';
import { PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Pharmacy orders' };

export default function PharmacyOrdersPage() {
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Customer orders"
        description="One protected storefront for branch collection and staff-runner delivery. Every order remains a proposal until pharmacy staff accepts it."
      />
      <CustomerPortalPanel />
      <PharmacyCustomerOrderingConsole />
    </div>
  );
}
