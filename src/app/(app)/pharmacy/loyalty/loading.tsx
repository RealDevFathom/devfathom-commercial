import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export default function LoyaltyLoading() {
  return (
    <main className="min-w-0 space-y-6" aria-busy="true">
      <PageHeader
        eyebrow="Pharmacy / customers"
        heading="Loyalty points"
        description="Review points balances and the receipts behind each change."
      />
      <SectionCard title="Loading loyalty points" titleLevel={2}>
        <p role="status">Loading customers and points history. Please wait.</p>
      </SectionCard>
    </main>
  );
}
