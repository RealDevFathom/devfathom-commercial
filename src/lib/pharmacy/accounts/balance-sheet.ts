export type PostedAccountBalance = {
  accountCode: string;
  currency: string;
  closingMinor: string;
};

export type BalanceSheetLine = PostedAccountBalance & {
  label: string;
  normalSide: 'DEBIT' | 'CREDIT';
  amountMinor: string;
};

export type ClassifiedBalanceSheet = {
  currency: string;
  assets: BalanceSheetLine[];
  liabilities: BalanceSheetLine[];
  openingEquity: BalanceSheetLine[];
  currentResultMinor: string;
  revenue: BalanceSheetLine[];
  expenses: BalanceSheetLine[];
  unmapped: PostedAccountBalance[];
  totals: {
    assetsMinor: string;
    liabilitiesMinor: string;
    openingEquityMinor: string;
    equityAndLiabilitiesMinor: string;
    reconciliationGapMinor: string;
  };
  status: 'reconciled' | 'gap' | 'incomplete';
};

const classifications = {
  CASH: ['assets', 'Cash', 'DEBIT'],
  BANK: ['assets', 'Bank', 'DEBIT'],
  INVENTORY: ['assets', 'Inventory', 'DEBIT'],
  INVENTORY_IN_TRANSIT: ['assets', 'Inventory in transit', 'DEBIT'],
  ACCOUNTS_RECEIVABLE: ['assets', 'Customer receivables', 'DEBIT'],
  SUPPLIER_CLAIM_RECEIVABLE: ['assets', 'Supplier claims receivable', 'DEBIT'],
  SALES_CLEARING: ['assets', 'Sales clearing', 'DEBIT'],
  ACCOUNTS_PAYABLE: ['liabilities', 'Invoiced accounts payable', 'CREDIT'],
  GOODS_RECEIVED_ACCRUAL: ['liabilities', 'Goods received accrual', 'CREDIT'],
  OPENING_BALANCE_EQUITY: ['openingEquity', 'Opening balance equity', 'CREDIT'],
  SALES_REVENUE: ['revenue', 'Sales revenue', 'CREDIT'],
  COST_OF_GOODS_SOLD: ['expenses', 'Cost of goods sold', 'DEBIT'],
  OPERATING_EXPENSE: ['expenses', 'Operating expense', 'DEBIT'],
  INVENTORY_WRITE_OFF: ['expenses', 'Inventory write-off', 'DEBIT'],
  INVENTORY_SHRINKAGE: ['expenses', 'Inventory shrinkage', 'DEBIT'],
  SALES_DISCOUNT: ['expenses', 'Sales discounts and returns', 'DEBIT'],
  LOYALTY_REDEMPTION: ['expenses', 'Loyalty redemption', 'DEBIT'],
  CASH_OVER_SHORT: ['expenses', 'Cash over / short', 'DEBIT'],
} as const;

const labelFor = (code: string) =>
  code
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/^./, (letter) => letter.toUpperCase());

/**
 * Classifies canonical all-time closing balances. Input values retain the ledger's signed
 * debit convention; presented amounts use each account's normal side. Nothing is plugged.
 */
export function classifyBalanceSheet(accounts: PostedAccountBalance[]): ClassifiedBalanceSheet[] {
  const currencies = new Map<string, PostedAccountBalance[]>();
  for (const account of accounts) {
    currencies.set(account.currency, [...(currencies.get(account.currency) ?? []), account]);
  }

  return [...currencies.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, rows]) => {
      const sections = {
        assets: [] as BalanceSheetLine[],
        liabilities: [] as BalanceSheetLine[],
        openingEquity: [] as BalanceSheetLine[],
        revenue: [] as BalanceSheetLine[],
        expenses: [] as BalanceSheetLine[],
      };
      const unmapped: PostedAccountBalance[] = [];

      for (const row of rows) {
        const classification = classifications[row.accountCode as keyof typeof classifications];
        if (!classification) {
          if (BigInt(row.closingMinor) !== 0n) unmapped.push(row);
          continue;
        }
        const [section, label, normalSide] = classification;
        const raw = BigInt(row.closingMinor);
        sections[section].push({
          ...row,
          label,
          normalSide,
          amountMinor: (normalSide === 'CREDIT' ? -raw : raw).toString(),
        });
      }

      const sum = (lines: BalanceSheetLine[]) =>
        lines.reduce((total, line) => total + BigInt(line.amountMinor), 0n);
      const assets = sum(sections.assets);
      const liabilities = sum(sections.liabilities);
      const openingEquity = sum(sections.openingEquity);
      const currentResult = sum(sections.revenue) - sum(sections.expenses);
      const equityAndLiabilities = liabilities + openingEquity + currentResult;
      const gap = assets - equityAndLiabilities;

      return {
        currency,
        ...sections,
        unmapped,
        currentResultMinor: currentResult.toString(),
        totals: {
          assetsMinor: assets.toString(),
          liabilitiesMinor: liabilities.toString(),
          openingEquityMinor: openingEquity.toString(),
          equityAndLiabilitiesMinor: equityAndLiabilities.toString(),
          reconciliationGapMinor: gap.toString(),
        },
        status: unmapped.length ? 'incomplete' : gap === 0n ? 'reconciled' : 'gap',
      };
    });
}

export const balanceSheetAccountLabel = labelFor;
