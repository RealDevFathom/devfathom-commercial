import type { Metadata } from 'next';

import { PageTransition } from '@/components/motion/page-transition';
import { PromotionsConsole } from '@/components/restaurant/promotions/promotions-console';

export const metadata: Metadata = { title: 'Restaurant Offers' };

export default function RestaurantPromotionsPage() {
  return (
    <PageTransition>
      <PromotionsConsole />
    </PageTransition>
  );
}
