import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export default function KhataLoading() {
  return (
    <div className="min-w-0 space-y-6" aria-busy="true">
      <PageHeader
        eyebrow="Pharmacy / customers"
        heading="Khata"
        description="See who owes what, collect payments and send WhatsApp reminders."
      />
      <SectionCard title="Loading Khata accounts" titleLevel={2}>
        <p role="status">Loading branch balances. Please wait.</p>
      </SectionCard>
    </div>
  );
}
