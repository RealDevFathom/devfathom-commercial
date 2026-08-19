import type { Metadata } from 'next';

import { KdsBoard } from '@/components/restaurant/kds/kds-board';

export const metadata: Metadata = {
  title: 'Kitchen display',
  description: 'Device-authenticated restaurant kitchen display.',
};

export default function KdsPage() {
  return <KdsBoard />;
}
