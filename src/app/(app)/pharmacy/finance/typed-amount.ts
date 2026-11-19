import { amountInputError, amountInputToMinor } from '@/lib/money-input';

/**
 * DEV-942: the rupee amounts typed on the finance page (posting, matching and bank statement
 * lines) are read by `src/lib/money-input.ts`, the same exact reader as the counter. A refused
 * entry carries a plain message from fixed copy, and the page sends nothing.
 */
export type FinanceAmount =
  { status: 'OK'; minor: number } | { status: 'REFUSED'; message: string };

const EMPTY_MESSAGE = 'Enter an amount, for example 125.50.';
const BANK_LINE_FORMAT_MESSAGE =
  'Enter an amount like 125.50, with a minus sign in front for money out, for example -125.50.';

const refused = (message: string): FinanceAmount => ({ status: 'REFUSED', message });

/** A posting or matching amount, in paisa. */
export function financeAmountMinor(raw: string): FinanceAmount {
  const parsed = amountInputToMinor(raw);
  if (parsed.status === 'OK') return parsed;
  return refused(parsed.status === 'EMPTY' ? EMPTY_MESSAGE : amountInputError(parsed.reason));
}

/**
 * A bank statement line amount, in paisa. Money out is typed with one leading minus sign
 * directly before the digits ("-125.50"), so the amount itself is read by the shared reader and
 * only the sign is handled here.
 */
export function bankLineAmountMinor(raw: string): FinanceAmount {
  const text = raw.trim();
  const negative = text.startsWith('-');
  const digits = negative ? text.slice(1) : text;
  if (negative && digits !== digits.trimStart()) return refused(BANK_LINE_FORMAT_MESSAGE);
  const parsed = amountInputToMinor(digits);
  if (parsed.status === 'OK')
    return { status: 'OK', minor: negative && parsed.minor > 0 ? -parsed.minor : parsed.minor };
  if (parsed.status === 'EMPTY') return refused(EMPTY_MESSAGE);
  return refused(
    parsed.reason === 'NEGATIVE' || parsed.reason === 'FORMAT'
      ? BANK_LINE_FORMAT_MESSAGE
      : amountInputError(parsed.reason)
  );
}
