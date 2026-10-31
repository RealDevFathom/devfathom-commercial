import type { Metadata } from 'next';
import { CustomerPortal } from '@/components/pharmacy/customer-portal';

export const metadata: Metadata = {
  title: 'My pharmacy',
  manifest: '/pharmacy-customer.webmanifest',
  robots: { index: false, follow: false },
};

export default function PharmacyCustomerPage() {
  return (
    <div className="studio-viewport min-h-dvh text-text-body">
      <a href="#customer-content" className="sr-only focus:not-sr-only focus:p-4">
        Skip to customer service
      </a>
      <div className="studio-shell min-h-dvh lg:min-h-[calc(100dvh-44px)]">
        <main
          id="customer-content"
          className="studio-canvas space-y-6 rounded-[inherit] p-4 sm:p-6 lg:p-8"
        >
          <CustomerPortal />
        </main>
      </div>
    </div>
  );
}
