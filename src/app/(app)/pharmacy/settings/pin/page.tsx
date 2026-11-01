import type { Metadata } from 'next';
import { PharmacyPinEnrollment } from '@/components/pharmacy/pin-enrollment';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export const metadata: Metadata = { title: 'Pharmacy approval PIN' };

export default function PharmacyPinPage() {
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Approval PIN"
        description="Enroll your personal PIN before confirming sensitive pharmacy decisions."
      />
      <SectionCard title="Your approval PIN">
        <PharmacyPinEnrollment />
      </SectionCard>
    </main>
  );
}
