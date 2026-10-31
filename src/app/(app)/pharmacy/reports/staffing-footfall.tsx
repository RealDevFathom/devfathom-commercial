import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';

type Report = {
  period: { days: number; timezone: string };
  config: { receiptsPerStaffHour: number };
  hours: Array<{
    hourLocal: number;
    receiptCount: number;
    averageReceipts: number;
    suggestedStaff: number;
  }>;
};

const hour = (value: number) =>
  `${String(value).padStart(2, '0')}:00–${String((value + 1) % 24).padStart(2, '0')}:00`;

export function StaffingFootfall({ report, failed }: { report: Report | null; failed: boolean }) {
  return (
    <SectionCard title="Hourly footfall staffing suggestions" titleLevel={2}>
      {!report ? (
        <p className="text-sm text-text-muted" role={failed ? 'alert' : 'status'}>
          {failed
            ? 'Staffing suggestions could not be calculated; retry with an authorized branch and valid assumptions.'
            : 'Choose one authorized branch to calculate hourly suggestions.'}
        </p>
      ) : (
        <>
          <p className="mb-4 text-sm text-text-muted">
            Suggestion only. Completed receipts are an estimated footfall proxy, not a door count or
            staffing requirement. Hours and calendar days use {report.period.timezone}. Adjust the
            planning assumptions in the report filters; no rota or staff record is changed.
          </p>
          <div className="mb-4 grid gap-4 sm:grid-cols-3">
            <Stat
              label="Observed receipts"
              value={report.hours.reduce((n, row) => n + row.receiptCount, 0)}
            />
            <Stat label="Selected days" value={report.period.days} />
            <Stat
              label="Capacity assumption"
              value={`${report.config.receiptsPerStaffHour}/staff hour`}
            />
          </div>
          <div className="overflow-x-auto rounded-md border border-border-subtle">
            <table className="w-full min-w-lg text-left text-sm">
              <thead className="bg-surface-sunken font-mono text-xs uppercase text-text-muted">
                <tr>
                  <th className="px-4 py-3">Local hour</th>
                  <th className="px-4 py-3 text-right">Receipts</th>
                  <th className="px-4 py-3 text-right">Daily average</th>
                  <th className="px-4 py-3 text-right">Suggested staff</th>
                </tr>
              </thead>
              <tbody>
                {report.hours.map((row) => (
                  <tr className="border-t border-border-subtle" key={row.hourLocal}>
                    <td className="px-4 py-3 tabular-nums">{hour(row.hourLocal)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.receiptCount}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {row.averageReceipts.toFixed(1)}
                    </td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums">
                      {row.suggestedStaff}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </SectionCard>
  );
}
