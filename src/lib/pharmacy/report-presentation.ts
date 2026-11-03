import { formatMinor } from './counter-receipt';
import { workspaceTimezone } from '@/lib/timezone';
import { zonedWallTimeToUtc } from '@/lib/restaurant/sop-recurrence';

export function reportMoney(value: number | bigint | null, currency?: string | null): string {
  if (value === null) return 'Unavailable';
  if (
    typeof value === 'bigint' &&
    (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
  )
    return 'Unavailable (amount exceeds safe bounds)';
  const minor = Number(value);
  if (!Number.isSafeInteger(minor)) return 'Unavailable (invalid minor amount)';
  return `${currency || 'Currency not configured'} ${formatMinor(minor)}`;
}

export function reportDate(
  value: Date | string | null | undefined,
  timezone?: string | null
): string {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Invalid date';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: workspaceTimezone(timezone),
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function reportDayStart(value: string, timezone: string): Date {
  return zonedWallTimeToUtc(value, 0, workspaceTimezone(timezone)).instant;
}

const labels: Record<string, string> = {
  PHARMACY_REFUND: 'Refund',
  PHARMACY_TENDER: 'Payment',
  PHARMACY_SALE_LINE: 'Medicine sale',
  PHARMACY_SALE_RETURN_LINE: 'Medicine return',
  PHARMACY_UNIDENTIFIED_RETURN_HOLD: 'Return without batch',
  PHARMACY_GOODS_RECEIPT_LINE: 'Stock received',
  PHARMACY_INVENTORY_COUNT_LINE: 'Stock count',
  PHARMACY_DAILY_CLOSE: 'Daily close',
  COST_OF_GOODS_SOLD: 'Cost of medicines sold',
  SALES_CLEARING: 'Sales awaiting payment',
  ACCOUNTS_RECEIVABLE: 'Customer balances',
  ACCOUNTS_PAYABLE: 'Supplier balances',
  GOODS_RECEIVED_ACCRUAL: 'Stock received, not yet invoiced',
  INVENTORY_SHRINKAGE: 'Stock lost less stock found',
  INVENTORY_WRITE_OFF: 'Stock written off',
  CREDIT: 'Customer credit',
  LOYALTY: 'Loyalty points',
};
export function reportLabel(value: string): string {
  return (
    labels[value] ??
    value
      .replace(/^PHARMACY_/, '')
      .toLowerCase()
      .replaceAll('_', ' ')
      .replace(/^./, (c) => c.toUpperCase())
  );
}
