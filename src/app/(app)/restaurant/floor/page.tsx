import type { Metadata } from 'next';

import { FloorConsole } from '@/components/restaurant/floor/floor-console';

export const metadata: Metadata = { title: 'Restaurant floor' };

export default function RestaurantFloorPage() {
  return <FloorConsole />;
}
