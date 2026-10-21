import type { Metadata } from 'next';
import { PharmacyDayCloseConsole } from '@/components/pharmacy/counter/day-close-console';
export const metadata: Metadata = { title: 'Pharmacy day close' };
export default function PharmacyDayClosePage() {
  return <PharmacyDayCloseConsole />;
}
