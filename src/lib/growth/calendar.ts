// Editable Pakistan calendar. 2027 lunar dates are provisional until moon sighting.
// Sources: https://www.cabinet.gov.pk/Detail/OTE2ODBiYmItZmI0MS00NDAwLWE5NGUtYmE1MGVjYzllMzAz
// https://holibase.org/public-holidays/pk/
import holidays from './holidays.json';
import { z } from 'zod';
export const DAY = 86_400_000;
// Pakistan pharmacy pilot uses Asia/Karachi (UTC+5, no DST).
export function localDate(now: Date) {
  return new Date(now.getTime() + 5 * 3600000);
}
export function weekStart(now: Date) {
  const d = localDate(now);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - 5 * 3600000);
}
const custom = z.array(z.object({ date: z.iso.date(), name: z.string().min(1).max(160) })).max(366);
export function calendar(now: Date, customDates: unknown) {
  const dates = [...holidays, ...(custom.safeParse(customDates).data ?? [])];
  return Array.from({ length: 14 }, (_, i) => {
    const date = localDate(new Date(now.getTime() + i * DAY))
      .toISOString()
      .slice(0, 10);
    return { date, holidays: dates.filter((h) => h.date === date) };
  });
}
export function outsideQuietHours(date: Date, start: number, end: number) {
  const local = localDate(date);
  const hour = local.getUTCHours();
  if (start === end) return date;
  if (start > end ? hour >= start || hour < end : hour >= start && hour < end) {
    if (start > end && hour >= start) local.setUTCDate(local.getUTCDate() + 1);
    local.setUTCHours(end, 0, 0, 0);
  }
  return new Date(local.getTime() - 5 * 3600000);
}
