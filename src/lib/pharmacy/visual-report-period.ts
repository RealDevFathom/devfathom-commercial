import { shiftPharmacyDay } from './business-day';

export const REPORT_PRESETS = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'This week',
  month: 'This month',
  lastMonth: 'Last month',
  year: 'This year',
  custom: 'Custom',
} as const;
export type ReportPreset = keyof typeof REPORT_PRESETS;
export type ReportPeriod = { from: string; to: string };

function daysInPeriod({ from, to }: ReportPeriod) {
  for (const day of [from, to]) {
    const instant = new Date(day + 'T00:00:00Z');
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(+instant) ||
      instant.toISOString().slice(0, 10) !== day
    )
      throw new RangeError('Choose valid start and end dates.');
  }
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  if (days < 1 || days > 366) throw new RangeError('Choose a period of 1 to 366 days.');
  return days;
}

export function reportPeriod(
  preset: ReportPreset,
  today: string,
  custom?: ReportPeriod
): ReportPeriod {
  const monthStart = today.slice(0, 7) + '-01';
  switch (preset) {
    case 'custom':
      if (!custom) throw new RangeError('Choose both dates.');
      daysInPeriod(custom);
      return custom;
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const day = shiftPharmacyDay(today, -1);
      return { from: day, to: day };
    }
    case 'week':
      return { from: shiftPharmacyDay(today, -((new Date(today).getUTCDay() + 6) % 7)), to: today };
    case 'month':
      return { from: monthStart, to: today };
    case 'lastMonth': {
      const to = shiftPharmacyDay(monthStart, -1);
      return { from: to.slice(0, 7) + '-01', to };
    }
    case 'year':
      return { from: today.slice(0, 4) + '-01-01', to: today };
  }
}

export function previousReportPeriod(period: ReportPeriod): ReportPeriod {
  return {
    from: shiftPharmacyDay(period.from, -daysInPeriod(period)),
    to: shiftPharmacyDay(period.from, -1),
  };
}
