/** Separate ticks for opening accounts and changing their financial records. */
export const PHARMACY_FINANCE_READ = 'finance:read';
export const PHARMACY_FINANCE_MANAGE = 'finance:manage';
export type PharmacyFinanceAction = typeof PHARMACY_FINANCE_READ | typeof PHARMACY_FINANCE_MANAGE;
export const isPharmacyFinanceAction = (action: string): action is PharmacyFinanceAction =>
  action === PHARMACY_FINANCE_READ || action === PHARMACY_FINANCE_MANAGE;
