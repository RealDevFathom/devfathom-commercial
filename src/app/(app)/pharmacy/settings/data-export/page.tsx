import type { Metadata } from 'next';

import { OwnerDataExportConsole } from '@/components/pharmacy/owner-data-export';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { hasModule } from '@/lib/entitlements';
import { isLiveOrganizationOwner, listOwnerDataExports } from '@/lib/pharmacy/owner-data-export';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Download my data' };

const HEADER = {
  eyebrow: 'Pharmacy',
  heading: 'Download my data',
  description:
    'Your data is yours. Export every medicine, stock lot, customer, supplier, sale, purchase and controlled-register entry as CSV files you can open anywhere or import back in.',
};

/**
 * DEV-93 — the owner's "no lock-in" export. Only the live owner identity may
 * request or download it; the API route enforces the same check on every call.
 */
export default async function PharmacyDataExportPage() {
  const ctx = await createTRPCContext();
  const user = ctx.session?.user;
  const organizationId = ctx.organization?.id;
  const owner =
    !!user?.id &&
    !!organizationId &&
    ctx.entitlements.organizationId === organizationId &&
    !user.isSupportSession &&
    hasModule(ctx.entitlements, 'pharmacy-core') &&
    (await isLiveOrganizationOwner(ctx.db, organizationId, user.id));

  if (!owner) {
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader {...HEADER} />
        <SectionCard title="Only the pharmacy owner can export all data" titleLevel={2}>
          <p className="text-sm text-text-muted">
            The full export includes customer balances and the controlled register, so it is limited
            to the owner. Ask the owner to download it.
          </p>
        </SectionCard>
      </main>
    );
  }

  const initial = await listOwnerDataExports(organizationId);
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader {...HEADER} />
      <SectionCard title="Export everything" titleLevel={2}>
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            The export is prepared in the background as a ZIP of UTF-8 CSV files with a README
            explaining every column. When it is ready, download it here. The link works for 24
            hours, and every request and download is recorded in the audit log.
          </p>
          <OwnerDataExportConsole initial={initial} timeZone={ctx.organization?.timezone} />
        </div>
      </SectionCard>
    </main>
  );
}
