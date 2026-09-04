import type { Metadata } from 'next';

import { CateringConsole } from '@/components/restaurant/catering/catering-console';

export const metadata: Metadata = { title: 'Restaurant catering' };

export default function RestaurantCateringPage() {
  return <CateringConsole />;
}
