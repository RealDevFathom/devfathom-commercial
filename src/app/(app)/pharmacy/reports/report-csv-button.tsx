'use client';

import { Button } from '@/components/ui/button';

export type ReportCsvRow = { label: string; figure: string };

function cell(value: string) {
  // Neutralise spreadsheet formula triggers, then quote.
  const safe = /^[=+@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function buildReportCsv(rows: ReportCsvRow[], context: Record<string, string>) {
  const lines = [
    ...Object.entries(context).map(([key, value]) => `${cell(key)},${cell(value)}`),
    `${cell('Metric')},${cell('Value')}`,
    ...rows.map((row) => `${cell(row.label)},${cell(row.figure)}`),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

/** Downloads the already-authorized summary figures; no extra server data is fetched. */
export function ReportCsvButton({
  rows,
  context,
  filename,
}: {
  rows: ReportCsvRow[];
  context: Record<string, string>;
  filename: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="lg"
      className="print:hidden"
      onClick={() => {
        const blob = new Blob([buildReportCsv(rows, context)], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
      }}
    >
      Export CSV
    </Button>
  );
}
