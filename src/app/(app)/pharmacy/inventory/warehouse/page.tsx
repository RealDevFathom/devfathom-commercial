import type { Metadata } from 'next';

import { WarehouseWorkspace } from '@/components/pharmacy/warehouse/workspace';
import { PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Warehouse' };

export default async function WarehousePage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string }>;
}) {
  const { branch } = await searchParams;
  return (
    <div className="min-w-0 space-y-5">
      <PageHeader
        eyebrow="Pharmacy operations"
        heading="Warehouse"
        description="Select your assigned site to open its warehouse or quality work queue."
      />
      <WarehouseWorkspace initialBranchId={branch} />
    </div>
  );
}
