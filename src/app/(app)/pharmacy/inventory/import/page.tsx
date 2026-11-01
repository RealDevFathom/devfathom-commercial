import type { Metadata } from 'next';
import { OwnerImportWizard } from '@/components/pharmacy/owner-import-wizard';

export const metadata: Metadata = { title: 'Import opening stock · Pharmacy inventory' };

export default function OwnerOpeningStockImportPage() {
  return <OwnerImportWizard />;
}
