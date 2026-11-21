import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { RefundBranchPicker } from './refund-workspace';

export const metadata: Metadata = { title: 'Card provider refunds · Pharmacy accounts' };
export default function ProviderRefundsPage() {
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Card provider refunds"
        description="Review amounts owed to customers and record settlements from the provider statement."
      />
      <RefundBranchPicker />
    </div>
  );
}
