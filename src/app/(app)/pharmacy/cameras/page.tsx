import type { Metadata } from 'next';
import { PharmacyCamerasConsole } from '@/components/pharmacy/cameras/pharmacy-cameras-console';

export const metadata: Metadata = { title: 'Pharmacy cameras' };

export default function PharmacyCamerasPage() {
  return <PharmacyCamerasConsole />;
}
