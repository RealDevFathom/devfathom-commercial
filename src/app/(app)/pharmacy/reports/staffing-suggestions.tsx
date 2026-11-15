import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { STAFFING_LIMITS, type readStaffingSuggestions } from '@/lib/pharmacy/staffing-suggestions';
import { workspaceZoneLabel } from '@/lib/timezone';

type Suggestions = Awaited<ReturnType<typeof readStaffingSuggestions>>;

const hourLabel = (hour: number) =>
  `${String(hour).padStart(2, '0')}:00–${String((hour + 1) % 24).padStart(2, '0')}:00`;

export function StaffingSuggestions({
  report,
  failed,
  selected,
  timeZone,
  carry,
  receiptsPerStaffHour,
  minimumStaff,
}: {
  report: Suggestions | null;
  failed: boolean;
  selected: boolean;
  timeZone: string | null | undefined;
  /** Report filters kept when the owner changes the staffing assumptions. */
  carry: Record<string, string>;
  receiptsPerStaffHour: number;
  minimumStaff: number;
}) {
  const busy = report?.hours.filter((row) => row.suggestedStaff !== null) ?? [];
  const peak = busy.reduce<(typeof busy)[number] | null>(
    (best, row) => (!best || row.averagePerDay > best.averagePerDay ? row : best),
    null
  );
  const zone = workspaceZoneLabel(timeZone);
  return (
    <SectionCard title="Staffing suggestions by hourly footfall" titleLevel={2}>
      {!report ? (
        <p className="text-sm text-text-muted" role={failed ? 'alert' : 'status'}>
          {failed
            ? 'Staffing suggestions unavailable. Access, the period or the assumptions could not be verified; retry.'
            : selected
              ? 'Staffing suggestions unavailable for this branch or date range.'
              : 'Choose one authorized branch to view hourly footfall and staffing suggestions.'}
        </p>
      ) : (
        <>
          <p className="mb-4 text-sm text-text-muted">
            Suggestions only; no roster or shift is changed. Footfall is completed receipts per hour
            in {zone}, averaged over {report.days} calendar {report.days === 1 ? 'day' : 'days'}.
            Excludes {report.exclusions.join(', ')}.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Stat label="Receipts in period" value={report.totalReceipts} />
            <Stat label="Busiest hour" value={peak ? hourLabel(peak.hour) : '—'} />
          </div>
          {!busy.length ? (
            <p className="mt-4 text-sm text-text-muted">
              No completed receipts in this period, so no staffing suggestion is made.
            </p>
          ) : (
            <div
              role="region"
              aria-label="Hourly staffing suggestions"
              tabIndex={0}
              className="mt-4 overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <table className="w-full text-left text-sm">
                <thead className="font-mono text-xs uppercase text-text-muted">
                  <tr>
                    <th className="p-3">Hour ({zone})</th>
                    <th className="p-3 text-right">Receipts</th>
                    <th className="p-3 text-right">Average per day</th>
                    <th className="p-3 text-right">Busiest day</th>
                    <th className="p-3 text-right">Suggested staff</th>
                  </tr>
                </thead>
                <tbody>
                  {busy.map((row) => (
                    <tr
                      key={row.hour}
                      className="border-t border-border-subtle hover:bg-surface-sunken"
                    >
                      <td className="whitespace-nowrap p-3 font-mono text-xs">
                        {hourLabel(row.hour)}
                      </td>
                      <td className="p-3 text-right">{row.receipts}</td>
                      <td className="p-3 text-right">{row.averagePerDay.toFixed(2)}</td>
                      <td className="p-3 text-right">{row.busiestDay}</td>
                      <td className="p-3 text-right">{row.suggestedStaff}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <form action="/pharmacy/reports" className="mt-6 grid gap-4 sm:grid-cols-[1fr_1fr_auto]">
        {Object.entries(carry).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <label className="block text-sm">
          Assumed receipts per staff per hour (estimate)
          <Input
            name="staffCapacity"
            type="number"
            min={STAFFING_LIMITS.receiptsPerStaffHour.min}
            max={STAFFING_LIMITS.receiptsPerStaffHour.max}
            defaultValue={receiptsPerStaffHour}
            required
            className="mt-1 min-h-11"
          />
        </label>
        <label className="block text-sm">
          Minimum staff in a trading hour
          <Input
            name="staffMinimum"
            type="number"
            min={STAFFING_LIMITS.minimumStaff.min}
            max={STAFFING_LIMITS.minimumStaff.max}
            defaultValue={minimumStaff}
            required
            className="mt-1 min-h-11"
          />
        </label>
        <Button type="submit" variant="outline" className="min-h-11 self-end">
          Update suggestions
        </Button>
      </form>
      <p className="mt-3 text-xs text-text-muted">
        Suggested staff = the larger of the minimum and average receipts per day ÷ assumed receipts
        per staff hour, rounded up. The capacity is your estimate; adjust it to your counter.
      </p>
    </SectionCard>
  );
}
