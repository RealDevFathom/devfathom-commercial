import { AbuzarImportForm } from '@/components/pharmacy/abuzar-import-form';
import type { Metadata } from 'next';
import { OwnerImportWizard } from '@/components/pharmacy/owner-import-wizard';

export const metadata: Metadata = { title: 'Import opening stock · Pharmacy inventory' };

export default function OwnerOpeningStockImportPage() {
  return (
    <div className="grid gap-6">
      <OwnerImportWizard />
      <AbuzarImportForm />
    </div>
  );
}
