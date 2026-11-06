import type { Metadata } from 'next';
import { PendingOfflinePayments } from '@/components/pharmacy/counter/pending-offline-payments';

export const metadata: Metadata = { title: 'Pending offline payments' };

export default async function PendingPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ branchId?: string }>;
}) {
  return <PendingOfflinePayments initialBranchId={(await searchParams).branchId} />;
}
