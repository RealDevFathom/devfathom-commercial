import type { Metadata } from 'next';
import { OwnerImportWizard } from '@/components/pharmacy/owner-import-wizard';

export const metadata: Metadata = { title: 'Import opening stock · Pharmacy inventory' };

export default async function OwnerOpeningStockImportPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string | string[] }>;
}) {
  const { branch } = await searchParams;
  // Only seeds the form; the importer still offers just the caller's own active branches.
  return <OwnerImportWizard initialBranchId={typeof branch === 'string' ? branch : undefined} />;
}
