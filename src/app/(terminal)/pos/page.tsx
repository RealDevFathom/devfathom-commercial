import type { Metadata } from 'next';

import { OrderPad } from '@/components/restaurant/pos/order-pad';

export const metadata: Metadata = {
  title: 'Restaurant POS',
  description: 'Device-authenticated restaurant order pad.',
};

export default function PosPage() {
  return <OrderPad />;
}
