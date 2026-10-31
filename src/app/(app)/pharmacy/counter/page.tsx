import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';

import { PharmacyCounterConsole } from '@/components/pharmacy/counter/counter-console';

export const metadata: Metadata = { title: 'Pharmacy counter' };

export default async function PharmacyCounterPage({
  searchParams,
}: {
  searchParams: Promise<{ orderSaleId?: string; branchId?: string }>;
}) {
  const { orderSaleId, branchId } = await searchParams;
  return (
    <>
      <PharmacyCounterConsole initialSaleId={orderSaleId} initialBranchId={branchId} />
      <div className="p-4">
        <Link
          className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
          href={`/pharmacy/counter/visits${branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''}`}
        >
          Record served visit / walk-out
        </Link>
      </div>
    </>
  );
}
