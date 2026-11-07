import { buttonVariants } from '@/components/ui/button';
import type { PharmacyReportExport } from '@/lib/pharmacy/report-csv';

/**
 * Download link for a Reports table as CSV, carrying the screen's current filters. Render it only
 * for users with reports:financial; the export route enforces the same rule on the server.
 */
export function ReportExportLink({
  report,
  branch,
  from,
  to,
  table,
}: {
  report: PharmacyReportExport;
  branch?: string;
  from: string;
  to: string;
  /** Table name for screen readers, e.g. "branch comparison". */
  table: string;
}) {
  const params = new URLSearchParams({ report, ...(branch ? { branch } : {}), from, to });
  return (
    <a
      className={buttonVariants({ variant: 'outline', className: 'min-h-11 shrink-0' })}
      download
      href={`/api/pharmacy/reports/export?${params.toString()}`}
    >
      Export CSV<span className="sr-only">: {table}</span>
    </a>
  );
}
