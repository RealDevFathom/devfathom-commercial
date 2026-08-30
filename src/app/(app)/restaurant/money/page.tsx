import type { Metadata } from 'next';

import { MoneyConsole } from '@/components/restaurant/money/money-console';

export const metadata: Metadata = { title: 'Restaurant Finance' };

export default function RestaurantMoneyPage() {
  return <MoneyConsole />;
}
