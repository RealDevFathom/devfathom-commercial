import { describe, expect, it } from 'vitest';
import { FinanceAccountCode } from '@/generated/prisma/enums';
import { FINANCE_ACCOUNT_LABELS, financeAccountLabel } from './account-labels';

describe('financeAccountLabel', () => {
  it('provides a curated plain-language label for every canonical account code', () => {
    expect(Object.keys(FINANCE_ACCOUNT_LABELS).sort()).toEqual(
      Object.values(FinanceAccountCode).sort()
    );
    expect(financeAccountLabel('COST_OF_GOODS_SOLD')).toBe('Cost of goods sold');
    expect(financeAccountLabel('SALES_CLEARING')).toBe('Sales clearing');
    expect(financeAccountLabel('INVENTORY_WRITE_OFF')).toBe('Stock written off');
  });

  it.each([
    ['UNKNOWN_RAW_CODE', 'Unknown raw code'],
    ['new-account-code', 'New account code'],
    ['  MIXED__SPACING  ', 'Mixed spacing'],
    ['', 'Unknown account'],
    ['___---  ', 'Unknown account'],
    ['__proto__', 'Proto'],
    ['constructor', 'Constructor'],
    ['toString', 'Tostring'],
  ])('turns unrecognised code %j into a readable fallback', (code, expected) => {
    expect(financeAccountLabel(code)).toBe(expected);
  });
});
