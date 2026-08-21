import type { Metadata } from 'next';

import { LoyaltyConsole } from '@/components/restaurant/loyalty/loyalty-console';

export const metadata: Metadata = { title: 'Customers & Loyalty' };

export default function RestaurantLoyaltyPage() {
  return <LoyaltyConsole />;
}
