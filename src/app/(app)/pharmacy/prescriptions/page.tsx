import type { Metadata } from 'next';
import { PrescriptionsConsole } from '@/components/pharmacy/dispensing/prescriptions-console';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { can, subjectFromSession } from '@/lib/abac';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Pharmacy prescriptions' };

export default async function PrescriptionsPage() {
  const ctx = await createTRPCContext();
  const user = ctx.session?.user;
  const mayCapture =
    user?.role === 'ADMIN' ||
    (user
      ? await can(subjectFromSession(user), 'pharmacy:dispense', undefined, { db: ctx.db })
      : false);
  if (!mayCapture) {
    return (
      <main className="space-y-6">
        <PageHeader
          eyebrow="Pharmacy dispensing"
          heading="Prescriptions"
          description="Prescription capture is restricted to pharmacists and organization administrators."
        />
        <SectionCard title="Permission required">
          <p className="text-sm text-text-muted">
            Ask a pharmacist or organization administrator to capture the prescription.
          </p>
        </SectionCard>
      </main>
    );
  }
  return <PrescriptionsConsole />;
}
