import type { Metadata } from 'next';

import { RestaurantRosterConsole } from '@/components/restaurant/restaurant-roster-console';

export const metadata: Metadata = { title: 'Restaurant roster' };

export default function RestaurantRosterPage() {
  return <RestaurantRosterConsole />;
}
