import type { Metadata } from 'next';

import { RestaurantTaxConsole } from '@/components/restaurant/restaurant-tax-console';

export const metadata: Metadata = { title: 'Restaurant tax configuration' };

export default function RestaurantTaxPage() {
  return <RestaurantTaxConsole />;
}
