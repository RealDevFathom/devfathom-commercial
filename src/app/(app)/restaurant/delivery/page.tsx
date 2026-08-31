import type { Metadata } from 'next';

import { DeliveryConsole } from '@/components/restaurant/delivery/delivery-console';

export const metadata: Metadata = { title: 'Restaurant delivery' };

export default function RestaurantDeliveryPage() {
  return <DeliveryConsole />;
}
