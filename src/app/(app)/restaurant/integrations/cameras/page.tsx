import type { Metadata } from 'next';
import { RestaurantCamerasConsole } from '@/components/restaurant/restaurant-cameras-console';
export const metadata: Metadata = { title: 'Restaurant cameras' };
export default function RestaurantCamerasPage() {
  return <RestaurantCamerasConsole />;
}
