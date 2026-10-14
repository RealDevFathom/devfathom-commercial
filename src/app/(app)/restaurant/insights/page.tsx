import type { Metadata } from 'next';

import { InsightsConsole } from '@/components/restaurant/insights/insights-console';

export const metadata: Metadata = { title: 'Restaurant insights' };

export default function RestaurantInsightsPage() {
  return <InsightsConsole />;
}
