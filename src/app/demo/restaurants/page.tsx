import { notFound } from 'next/navigation';

import { isDemoEnabled } from '@/lib/demo/config';

import { DemoRestaurantEntryClient } from './demo-entry-client';

export const dynamic = 'force-dynamic';

export default function RestaurantDemoPage() {
  if (!isDemoEnabled()) notFound();

  return <DemoRestaurantEntryClient />;
}
