import type { Metadata } from 'next';

import { PageTransition } from '@/components/motion/page-transition';
import { LoyaltyConsole } from '@/components/restaurant/loyalty/loyalty-console';

export const metadata: Metadata = { title: 'Customers & Loyalty' };

export default function RestaurantLoyaltyPage() {
  return (
    <PageTransition>
      <LoyaltyConsole />
    </PageTransition>
  );
}
