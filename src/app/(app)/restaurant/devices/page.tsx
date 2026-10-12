import type { Metadata } from 'next';

import { RestaurantDevicesConsole } from '@/components/restaurant/restaurant-devices-console';

export const metadata: Metadata = { title: 'Restaurant devices' };

export default function RestaurantDevicesPage() {
  return <RestaurantDevicesConsole />;
}
