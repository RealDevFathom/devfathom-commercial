import type { Metadata } from 'next';
import { PrescriptionsConsole } from '@/components/pharmacy/dispensing/prescriptions-console';
export const metadata: Metadata = { title: 'Pharmacy prescriptions' };
export default function PrescriptionsPage() {
  return <PrescriptionsConsole />;
}
