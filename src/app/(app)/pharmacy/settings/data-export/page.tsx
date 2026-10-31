import type { Metadata } from 'next';

import { DataExportConsole } from '@/components/pharmacy/data-export-console';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { pharmacyDataExportRouter } from '@/server/routers/pharmacy-data-export';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Download my data' };

/**
 * #716 — the owner's "no lock-in" export. The session organization is the only
 * tenant; a non-owner sees the permission-denied card in the same geometry as
 * the loaded page.
 */
export default async function PharmacyDataExportPage() {
  const ctx = await createTRPCContext();
  const caller = pharmacyDataExportRouter.createCaller(ctx);
  let initial: Awaited<ReturnType<typeof caller.list>>;
  try {
    initial = await caller.list();
  } catch {
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy"
          heading="Download my data"
          description="A complete copy of your pharmacy's data, in files you can open anywhere."
        />
        <SectionCard title="Only the workspace owner can export data" titleLevel={2}>
          <p className="text-sm text-text-muted">
            Ask the owner of this pharmacy workspace to download the export.
          </p>
        </SectionCard>
      </main>
    );
  }

  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Download my data"
        description="A ZIP of CSV files: medicines and packs, stock lots, customers and khata, suppliers and balances, sales, purchases and GRNs, and the controlled register. The columns match DevFathom's import headers, and a README explains each one."
      />
      <SectionCard title="Your exports" titleLevel={2}>
        <DataExportConsole initial={initial} />
      </SectionCard>
      <SectionCard title="How it works" titleLevel={2}>
        <ul className="list-disc space-y-1 pl-5 text-sm text-text-body">
          <li>The archive is prepared in the background, usually within a few minutes.</li>
          <li>Its download link works for 24 hours, then the file is deleted.</li>
          <li>
            Every request and download is recorded in the audit log. Spreadsheet formulas in text
            cells are neutralised so the files are safe to open in Excel.
          </li>
        </ul>
      </SectionCard>
    </main>
  );
}
