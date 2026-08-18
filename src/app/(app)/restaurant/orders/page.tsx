import type { Metadata } from 'next';

import { OrdersConsole } from '@/components/restaurant/orders/orders-console';

export const metadata: Metadata = { title: 'Restaurant orders' };

export default function RestaurantOrdersPage() {
  return <OrdersConsole />;
}
