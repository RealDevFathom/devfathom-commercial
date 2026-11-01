import { PageHeader } from '@/components/ui/page-header';
import { PointsSettings } from '@/components/pharmacy/points-settings';

export default function LoyaltySettingsPage() {
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy / settings"
        heading="Loyalty settings"
        description="Control points earned on completed sales and their checkout value."
      />
      <PointsSettings />
    </main>
  );
}
