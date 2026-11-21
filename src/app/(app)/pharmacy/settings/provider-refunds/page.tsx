import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { RefundMappingForm } from '@/components/pharmacy/refund-mapping-form';
import { FINANCE_ACCOUNT_LABELS } from '@/lib/finance/account-labels';
import { isBalanceSheetLiability } from '@/lib/pharmacy/accounts/balance-sheet';
import type { FinanceAccountCode } from '@/generated/prisma/client';

export const metadata: Metadata = { title: 'Provider refund account' };
export default function ProviderRefundSettings() {
  const accounts = (Object.keys(FINANCE_ACCOUNT_LABELS) as FinanceAccountCode[])
    .filter((code) => isBalanceSheetLiability(code) && code !== 'MANUAL_NONTRADE_ACCRUAL')
    .map((value) => ({ value, label: FINANCE_ACCOUNT_LABELS[value] }));
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy settings"
        heading="Provider refund account"
        description="The liability account used for money owed to customers through the card provider."
      />
      <SectionCard title="Liability account" titleLevel={2}>
        <RefundMappingForm accounts={accounts} />
      </SectionCard>
    </div>
  );
}
