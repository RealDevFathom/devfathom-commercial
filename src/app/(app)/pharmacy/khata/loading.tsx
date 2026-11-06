import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export default function KhataLoading() {
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy / owner"
        heading="Khata balances"
        description="Review family account balances, limits and recent payments by branch."
      />
      <SectionCard title="Family accounts">
        <p role="status">Loading balances…</p>
      </SectionCard>
    </div>
  );
}
