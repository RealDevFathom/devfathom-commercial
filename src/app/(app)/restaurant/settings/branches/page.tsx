import type { Metadata } from 'next';

import { RestaurantBranchesConsole } from '@/components/restaurant/restaurant-branches-console';

export const metadata: Metadata = { title: 'Restaurant branches' };

export default function RestaurantBranchesPage() {
  return <RestaurantBranchesConsole />;
}
