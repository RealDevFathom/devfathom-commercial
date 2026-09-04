import type { Metadata } from 'next';

import { PharmacyCounterConsole } from '@/components/pharmacy/counter/counter-console';

export const metadata: Metadata = { title: 'Pharmacy counter' };

export default async function PharmacyCounterPage({
  searchParams,
}: {
  searchParams: Promise<{ orderSaleId?: string; branchId?: string }>;
}) {
  const { orderSaleId, branchId } = await searchParams;
  return <PharmacyCounterConsole initialSaleId={orderSaleId} initialBranchId={branchId} />;
}
