import { workspaceMinuteInput } from '@/lib/timezone';

/** Keep the month names, spacing and punctuation identical during server and browser rendering. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatOrderMoney(minor: number, currency: string): string {
  const negative = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const whole = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${currency} ${groupThousands(String(whole))}.${cents}`;
}

/** Old callers use the original Karachi clock. The workspace console supplies its own zone. */
export function formatOrderDateTime(
  value: Date | string | number,
  timeZone = 'Asia/Karachi'
): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return '';
  const local = new Date(workspaceMinuteInput(instant, timeZone) + ':00Z');
  const hours24 = local.getUTCHours();
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minutes = String(local.getUTCMinutes()).padStart(2, '0');
  const meridiem = hours24 < 12 ? 'am' : 'pm';
  return `${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]} ${local.getUTCFullYear()}, ${hours12}:${minutes} ${meridiem}`;
}
