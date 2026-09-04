import type { Metadata } from 'next';
import { PharmacistQueueConsole } from '@/components/pharmacy/dispensing/pharmacist-queue-console';
export const metadata: Metadata = { title: 'Pharmacist queue' };
export default function PharmacistQueuePage() {
  return <PharmacistQueueConsole />;
}
