import type { Metadata } from 'next';

import { RestaurantStaffConsole } from '@/components/restaurant/restaurant-staff-console';

export const metadata: Metadata = { title: 'Restaurant staff' };

export default function RestaurantStaffPage() {
  return <RestaurantStaffConsole />;
}
