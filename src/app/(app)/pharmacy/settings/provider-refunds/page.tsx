import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { ProviderRefundAccount } from '@/components/pharmacy/refund-mapping-form';
export const metadata: Metadata = { title: 'Provider refund account' };
export default function ProviderRefundSettings() {
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy settings"
        heading="Provider refund account"
        description="The liability account used for money owed to customers through the card provider."
      />
      <SectionCard title="Liability account" titleLevel={2}>
        <ProviderRefundAccount />
      </SectionCard>
    </div>
  );
}
