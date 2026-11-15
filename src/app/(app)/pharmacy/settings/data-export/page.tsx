import type { Metadata } from 'next';

import { OwnerDataExportConsole } from '@/components/pharmacy/owner-data-export';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { hasModule } from '@/lib/entitlements';
import { isLiveOrganizationOwner, listOwnerDataExports } from '@/lib/pharmacy/owner-data-export';
import { auditOwnerDataExport } from '@/lib/pharmacy/owner-data-export-audit';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Download my data' };

const HEADER = {
  eyebrow: 'Pharmacy',
  heading: 'Download my data',
  description:
    'Your data is yours. Export every medicine, stock lot, customer, supplier, sale, purchase and controlled-register entry as CSV files you can open anywhere or import back in.',
};

const PAGE_PATH = '/pharmacy/settings/data-export';

/**
 * DEV-93 — the owner's "no lock-in" export. Only the live owner identity may
 * request or download it; the API route enforces the same check on every call.
 * DEV-783 — every opening of this list is audit-logged, refusals included, and
 * the list is not shown when its audit cannot be written.
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

  const audit = (status: number, metadata: Record<string, unknown>) =>
    auditOwnerDataExport(ctx, {
      path: PAGE_PATH,
      method: 'GET',
      action: 'pharmacy.dataExport.list',
      operation: 'READ',
      status,
      metadata: { via: 'page', ...metadata },
    });

  if (!owner) {
    await audit(403, {}).catch(() => undefined);
    return (
      <div className="min-w-0 space-y-6">
        <PageHeader {...HEADER} />
        <SectionCard title="Only the pharmacy owner can export all data" titleLevel={2}>
          <p className="text-sm text-text-muted">
            The full export includes customer balances and the controlled register, so it is limited
            to the owner. Ask the owner to download it.
          </p>
        </SectionCard>
      </div>
    );
  }

  const initial = await listOwnerDataExports(organizationId);
  try {
    await audit(200, { count: initial.length });
  } catch {
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader {...HEADER} />
        <SectionCard title="Your exports could not be shown" titleLevel={2}>
          <p role="alert" className="text-sm text-text-muted">
            Opening this page could not be recorded in the audit log, so your exports are hidden.
            Nothing has changed. Reload the page to try again.
          </p>
        </SectionCard>
      </main>
    );
  }
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader {...HEADER} />
      <SectionCard title="Export everything" titleLevel={2}>
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            The export is prepared in the background as a ZIP of UTF-8 CSV files with a README
            explaining every column. When it is ready, download it here. The link works for 24
            hours. Requesting and downloading both ask for your own PIN, and every visit to this
            page, request and download is recorded in the audit log.
          </p>
          <OwnerDataExportConsole initial={initial} />
        </div>
      </SectionCard>
    </div>
  );
}
