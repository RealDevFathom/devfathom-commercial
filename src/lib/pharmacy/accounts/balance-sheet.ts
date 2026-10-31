export type PostedAccountBalance = {
  accountCode: string;
  currency: string;
  openingMinor: string;
  debitMinor: string;
  creditMinor: string;
  closingMinor: string;
};

export type BalanceSheetSection = 'assets' | 'liabilities' | 'openingEquity' | 'currentResult';

type Classification = { section: BalanceSheetSection; normalSide: 'DEBIT' | 'CREDIT' };

const CLASSIFICATIONS: Record<string, Classification> = {
  CASH: { section: 'assets', normalSide: 'DEBIT' },
  BANK: { section: 'assets', normalSide: 'DEBIT' },
  INVENTORY: { section: 'assets', normalSide: 'DEBIT' },
  INVENTORY_IN_TRANSIT: { section: 'assets', normalSide: 'DEBIT' },
  ACCOUNTS_RECEIVABLE: { section: 'assets', normalSide: 'DEBIT' },
  SUPPLIER_CLAIM_RECEIVABLE: { section: 'assets', normalSide: 'DEBIT' },
  SALES_CLEARING: { section: 'assets', normalSide: 'DEBIT' },
  ACCOUNTS_PAYABLE: { section: 'liabilities', normalSide: 'CREDIT' },
  GOODS_RECEIVED_ACCRUAL: { section: 'liabilities', normalSide: 'CREDIT' },
  OPENING_BALANCE_EQUITY: { section: 'openingEquity', normalSide: 'CREDIT' },
  SALES_REVENUE: { section: 'currentResult', normalSide: 'CREDIT' },
  COST_OF_GOODS_SOLD: { section: 'currentResult', normalSide: 'DEBIT' },
  SALES_DISCOUNT: { section: 'currentResult', normalSide: 'DEBIT' },
  LOYALTY_REDEMPTION: { section: 'currentResult', normalSide: 'DEBIT' },
  INVENTORY_WRITE_OFF: { section: 'currentResult', normalSide: 'DEBIT' },
  INVENTORY_SHRINKAGE: { section: 'currentResult', normalSide: 'DEBIT' },
  OPERATING_EXPENSE: { section: 'currentResult', normalSide: 'DEBIT' },
  CASH_OVER_SHORT: { section: 'currentResult', normalSide: 'DEBIT' },
};

export type ClassifiedBalance = PostedAccountBalance & {
  section: BalanceSheetSection | 'unmapped';
  normalSide: 'DEBIT' | 'CREDIT' | null;
  normalBalanceMinor: string;
};

export type CurrencyBalanceSheet = {
  currency: string;
  accounts: ClassifiedBalance[];
  assetsMinor: string;
  liabilitiesMinor: string;
  openingEquityMinor: string;
  currentResultMinor: string;
  liabilitiesAndEquityMinor: string;
  reconciliationGapMinor: string;
  equationBalanced: boolean;
  unmappedAccountCodes: string[];
  reconciled: boolean;
};

/**
 * Classifies the canonical all-time closing balances returned by financialStatements.
 * Values remain exact signed debit balances; no residual is plugged into equity.
 */
export function classifyBalanceSheet(accounts: PostedAccountBalance[]): CurrencyBalanceSheet[] {
  const zero = BigInt(0);
  const currencies = new Map<string, PostedAccountBalance[]>();
  for (const account of accounts) {
    const rows = currencies.get(account.currency) ?? [];
    rows.push(account);
    currencies.set(account.currency, rows);
  }

  return [...currencies.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, rows]) => {
      let assets = zero;
      let liabilities = zero;
      let openingEquity = zero;
      let currentResult = zero;
      const unmapped = new Set<string>();
      const classified = rows.map((account): ClassifiedBalance => {
        const closing = BigInt(account.closingMinor);
        const classification = CLASSIFICATIONS[account.accountCode];
        if (!classification) {
          if (closing !== zero) unmapped.add(account.accountCode);
          return {
            ...account,
            section: 'unmapped',
            normalSide: null,
            normalBalanceMinor: account.closingMinor,
          };
        }
        const normal = classification.normalSide === 'DEBIT' ? closing : -closing;
        if (classification.section === 'assets') assets += normal;
        if (classification.section === 'liabilities') liabilities += normal;
        if (classification.section === 'openingEquity') openingEquity += normal;
        if (classification.section === 'currentResult') {
          currentResult += classification.normalSide === 'CREDIT' ? normal : -normal;
        }
        return {
          ...account,
          ...classification,
          normalBalanceMinor: normal.toString(),
        };
      });
      const liabilitiesAndEquity = liabilities + openingEquity + currentResult;
      const gap = assets - liabilitiesAndEquity;
      return {
        currency,
        accounts: classified,
        assetsMinor: assets.toString(),
        liabilitiesMinor: liabilities.toString(),
        openingEquityMinor: openingEquity.toString(),
        currentResultMinor: currentResult.toString(),
        liabilitiesAndEquityMinor: liabilitiesAndEquity.toString(),
        reconciliationGapMinor: gap.toString(),
        equationBalanced: gap === zero,
        unmappedAccountCodes: [...unmapped].sort(),
        reconciled: gap === zero && unmapped.size === 0,
      };
    });
}
