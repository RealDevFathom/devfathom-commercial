import type { Metadata } from 'next';
import { CustomerRequests } from '@/components/pharmacy/customer-requests';

export const metadata: Metadata = { title: 'Pharmacy customer requests' };
export default function CustomerRequestsPage() {
  return <CustomerRequests />;
}
