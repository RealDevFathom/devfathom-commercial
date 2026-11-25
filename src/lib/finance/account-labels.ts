import type { FinanceAccountCode } from '@/generated/prisma/client';

/** Plain-language names for every account in the canonical chart of accounts. */
export const FINANCE_ACCOUNT_LABELS = {
  CARD_REFUNDS_PAYABLE: 'Card refunds payable (provider)',
  CUSTOMER_PREPAID: 'Customer prepaid balance',
  INVENTORY: 'Inventory',
  INVENTORY_IN_TRANSIT: 'Inventory in transit',
  GOODS_RECEIVED_ACCRUAL: 'Goods received accrual',
  SALES_CLEARING: 'Sales clearing',
  SALES_REVENUE: 'Sales revenue',
  SALES_DISCOUNT: 'Sales discounts',
  COST_OF_GOODS_SOLD: 'Cost of goods sold',
  INVENTORY_WRITE_OFF: 'Stock written off',
  INVENTORY_SHRINKAGE: 'Inventory shrinkage',
  OPERATING_EXPENSE: 'Operating expenses',
  SUPPLIER_CLAIM_RECEIVABLE: 'Supplier claims receivable',
  CASH: 'Cash',
  BANK: 'Bank',
  ACCOUNTS_RECEIVABLE: 'Accounts receivable',
  LOYALTY_REDEMPTION: 'Loyalty redemptions',
  ACCOUNTS_PAYABLE: 'Accounts payable',
  CASH_OVER_SHORT: 'Cash over or short',
  OPENING_BALANCE_EQUITY: 'Opening balance equity',
  MANUAL_NONTRADE_ACCRUAL: 'Non-trade accruals',
} as const satisfies Readonly<Record<FinanceAccountCode, string>>;

/**
 * Returns the curated account name, or a readable sentence-case label for codes
 * supplied by a newer or external financial source.
 */
export function financeAccountLabel(code: string): string {
  if (Object.hasOwn(FINANCE_ACCOUNT_LABELS, code)) {
    return FINANCE_ACCOUNT_LABELS[code as FinanceAccountCode];
  }

  const words = code.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Unknown account';
}
