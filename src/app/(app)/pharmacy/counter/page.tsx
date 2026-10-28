import type { Metadata } from 'next';

import { PharmacyCounterConsole } from '@/components/pharmacy/counter/counter-console';

export const metadata: Metadata = { title: 'Pharmacy counter' };

export default async function PharmacyCounterPage({
  searchParams,
}: {
  searchParams: Promise<{
    orderSaleId?: string | string[];
    branchId?: string | string[];
  }>;
}) {
  const { orderSaleId, branchId } = await searchParams;
  // Duplicate identifier parameters are ambiguous and therefore fail closed.
  // The counter will remain idle rather than selecting one attacker-controlled
  // value and attempting to recover a bill under it.
  return (
    <PharmacyCounterConsole
      initialSaleId={typeof orderSaleId === 'string' ? orderSaleId : undefined}
      initialBranchId={typeof branchId === 'string' ? branchId : undefined}
    />
  );
}
