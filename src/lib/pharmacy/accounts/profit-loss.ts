import type { FinanceAccountCode } from '@/generated/prisma/client';

type Classification = 'revenue' | 'contra_revenue' | 'cogs' | 'expense' | 'balance_sheet';

// Exhaustive for today's chart. Future runtime codes remain visibly unmapped until classified.
export const profitAndLossClassification = {
  CARD_REFUNDS_PAYABLE: 'balance_sheet',
  CUSTOMER_PREPAID: 'balance_sheet',
  SALES_REVENUE: 'revenue',
  SALES_DISCOUNT: 'contra_revenue',
  COST_OF_GOODS_SOLD: 'cogs',
  INVENTORY_WRITE_OFF: 'expense',
  INVENTORY_SHRINKAGE: 'expense',
  OPERATING_EXPENSE: 'expense',
  LOYALTY_REDEMPTION: 'expense',
  CASH_OVER_SHORT: 'expense',
  INVENTORY: 'balance_sheet',
  INVENTORY_IN_TRANSIT: 'balance_sheet',
  GOODS_RECEIVED_ACCRUAL: 'balance_sheet',
  SALES_CLEARING: 'balance_sheet',
  SUPPLIER_CLAIM_RECEIVABLE: 'balance_sheet',
  CASH: 'balance_sheet',
  BANK: 'balance_sheet',
  ACCOUNTS_RECEIVABLE: 'balance_sheet',
  ACCOUNTS_PAYABLE: 'balance_sheet',
  OPENING_BALANCE_EQUITY: 'balance_sheet',
  MANUAL_NONTRADE_ACCRUAL: 'balance_sheet',
} as const satisfies Record<FinanceAccountCode, Classification>;

const profitAndLossAccounts = (
  Object.keys(profitAndLossClassification) as FinanceAccountCode[]
).filter((accountCode) => profitAndLossClassification[accountCode] !== 'balance_sheet');

type AccountMovement = {
  accountCode: string;
  currency: string;
  opening?: bigint;
  debit: bigint;
  credit: bigint;
};

/**
 * Period movements only; opening/closing balances never enter this projection.
 * Revenue is Cr−Dr; contra-revenue, COGS and expenses are Dr−Cr. Reversals and
 * gains retain their signed effect. Unmapped activity is disclosed, never guessed.
 */
export function projectProfitAndLoss(totals: AccountMovement[]) {
  const currencies = new Map<string, Map<string, { debit: bigint; credit: bigint }>>();
  for (const total of totals) {
    const classification = Object.hasOwn(profitAndLossClassification, total.accountCode)
      ? profitAndLossClassification[total.accountCode as FinanceAccountCode]
      : undefined;
    if (
      classification === 'balance_sheet' ||
      (total.debit === BigInt(0) && total.credit === BigInt(0))
    )
      continue;
    const values =
      currencies.get(total.currency) ?? new Map<string, { debit: bigint; credit: bigint }>();
    const previous = values.get(total.accountCode);
    values.set(total.accountCode, {
      debit: (previous?.debit ?? BigInt(0)) + total.debit,
      credit: (previous?.credit ?? BigInt(0)) + total.credit,
    });
    currencies.set(total.currency, values);
  }

  return [...currencies.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, values]) => {
      const amount = (accountCode: FinanceAccountCode) => {
        const value = values.get(accountCode);
        const debitBalance = (value?.debit ?? BigInt(0)) - (value?.credit ?? BigInt(0));
        return profitAndLossClassification[accountCode] === 'revenue'
          ? -debitBalance
          : debitBalance;
      };
      const rows = profitAndLossAccounts.map((accountCode) => ({
        accountCode,
        classification: profitAndLossClassification[accountCode],
        amountMinor: amount(accountCode).toString(),
      }));
      const sumClass = (classification: Classification) =>
        profitAndLossAccounts
          .filter((accountCode) => profitAndLossClassification[accountCode] === classification)
          .reduce((sum, accountCode) => sum + amount(accountCode), BigInt(0));
      const netRevenue = sumClass('revenue') - sumClass('contra_revenue');
      const grossProfit = netRevenue - sumClass('cogs');
      const expenses = sumClass('expense');
      const unmappedAccounts = [...values.entries()]
        .filter(([accountCode]) => !Object.hasOwn(profitAndLossClassification, accountCode))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([accountCode, value]) => ({
          accountCode,
          debitMinor: value.debit.toString(),
          creditMinor: value.credit.toString(),
          amountMinor: (value.debit - value.credit).toString(),
        }));
      return {
        currency,
        classificationCoverage:
          unmappedAccounts.length === 0 ? ('mapped' as const) : ('unmapped' as const),
        rows,
        netRevenueMinor: netRevenue.toString(),
        grossProfitMinor: grossProfit.toString(),
        postedExpensesMinor: expenses.toString(),
        netProfitMinor: (grossProfit - expenses).toString(),
        unmappedAccounts,
      };
    });
}
