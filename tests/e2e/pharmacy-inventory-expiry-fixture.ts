/**
 * WHA-1602 (PH-A5) — the expiry-board lots `pharmacy-inventory-expiry-seed.ts`
 * receives and `pharmacy-inventory-expiry.spec.ts` acts on. Import-free for the
 * same reason as `pharmacy-purchasing-fixture.ts`: the spec loads through
 * Playwright's CommonJS transform, which cannot reach the ESM-only Prisma client.
 */
export const EXPIRY_FIXTURE = {
  nearBatchPrefix: 'NX',
  expiredBatchPrefix: 'EX',
  nearUnits: 60,
  expiredUnits: 20,
  unitCostMinor: 2_500,
  /** PKR 320.00 per pack of 10. */
  printedMrpMinor: 32_000,
} as const;
