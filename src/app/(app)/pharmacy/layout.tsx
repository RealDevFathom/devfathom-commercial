import { Suspense, type ReactNode } from 'react';
import { WahaDeliveryNotice } from '@/components/pharmacy/waha-delivery-notice';

/** Keep shared metadata readable throughout pharmacy without changing shell geometry. */
export default function PharmacyLayout({ children }: { children: ReactNode }) {
  return (
    <div className="pharmacy-workspace contents">
      {process.env.PHARMACY_WHATSAPP_PROVIDER === 'waha' && (
        <Suspense fallback={null}>
          <WahaDeliveryNotice />
        </Suspense>
      )}
      {children}
    </div>
  );
}
