import type { Metadata } from 'next';

import { PharmacyCounterConsole } from '@/components/pharmacy/counter/counter-console';

export const metadata: Metadata = { title: 'Pharmacy counter' };

export default function PharmacyCounterPage() {
  return <PharmacyCounterConsole />;
}
