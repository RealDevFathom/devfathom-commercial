import { ReadinessChecklistSkeleton } from '@/components/onboarding/readiness-checklist';
import { PageHeader } from '@/components/ui/page-header';

export default function PharmacyOnboardingLoading() {
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Onboarding"
        description="The twelve steps between a new pharmacy workspace and its first legal sale."
      />
      <ReadinessChecklistSkeleton rowCount={12} />
    </div>
  );
}
