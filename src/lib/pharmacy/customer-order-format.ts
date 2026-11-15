/**
 * Deterministic formatters for the customer ordering console. They avoid `Intl`
 * so server-rendered and browser-rendered text always match (React hydration #418),
 * regardless of the ICU data each runtime ships.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;

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

/** "2 Nov 2026, 11:08 pm" in Asia/Karachi (UTC+5, no DST). */
export function formatOrderDateTime(value: Date | string | number): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return '';
  const local = new Date(instant.getTime() + KARACHI_OFFSET_MS);
  const hours24 = local.getUTCHours();
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minutes = String(local.getUTCMinutes()).padStart(2, '0');
  const meridiem = hours24 < 12 ? 'am' : 'pm';
  return `${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]} ${local.getUTCFullYear()}, ${hours12}:${minutes} ${meridiem}`;
}
