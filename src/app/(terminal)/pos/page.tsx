import type { Metadata } from 'next';

import { OrderPad } from '@/components/restaurant/pos/order-pad';

export const metadata: Metadata = {
  title: 'Restaurant Register',
  description: 'Device-authenticated restaurant order and checkout console.',
};

export default function PosPage() {
  return <OrderPad />;
}
