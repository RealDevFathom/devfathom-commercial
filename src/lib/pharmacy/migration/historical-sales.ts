import 'server-only';

/** Imported records participate in behavioural analytics, never operational ledgers. */
export const importedSalesAnalyticsSql = `
  SELECT "customerId", "occurredAt", "totalMinor"
  FROM "pharmacy_imported_sales"
  WHERE "organizationId" = $1 AND "branchId" = $2 AND imported = true
`;

export function importedLoyaltyPoints(input: {
  ownerOptIn: boolean;
  netPaidMinor: bigint;
  minorPerPoint: bigint;
}): number {
  if (!input.ownerOptIn || input.netPaidMinor <= 0n || input.minorPerPoint <= 0n) return 0;
  return Number(input.netPaidMinor / input.minorPerPoint);
}

/** Sources used by churn/win-back reads; imported history is an explicit baseline. */
export const CUSTOMER_ACTIVITY_SOURCES = Object.freeze([
  'pharmacy_sales',
  'pharmacy_imported_sales',
] as const);
