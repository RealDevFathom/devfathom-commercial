import { z } from 'zod';

const id = z.string().min(1).max(160);
const safety = z
  .object({
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    recallVersion: z.number().int().nonnegative(),
    licenceVersion: z.number().int().nonnegative(),
    ruleVersion: z.number().int().nonnegative(),
  })
  .strict();
const kind = z.enum([
  'CATALOG',
  'PRICES',
  'TAX',
  'RULES',
  'LICENCE',
  'STAFF',
  'LOT_BALANCES',
  'CUSTOMER_CREDIT',
]);
const envelope = z
  .object({
    organizationId: id,
    branchId: id,
    deviceId: id,
    kind,
    version: z.number().int().positive(),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    safetyLease: safety,
    signingKeyId: id,
  })
  .strict();
const signedSnapshot = z
  .object({ id: id.optional(), envelope, signature: z.string().min(1).max(200), payload: z.json() })
  .strict();
const leasedReceipt = z
  .object({
    leaseId: id,
    receiptNumber: z.number().int().positive(),
    originalSaleAt: z.iso.datetime(),
    envelope,
    signature: z.string().min(1).max(200),
  })
  .strict();

/** The canonical, client-safe contract shared by queue persistence and replay. */
export const counterReplaySchema = z
  .object({
    sequence: z.number().int().positive(),
    idempotencyKey: id,
    action: z.enum(['CASH_OTC_SALE', 'CONTROLLED_MEDICINE_SALE']),
    leasedReceipt,
    snapshots: z.array(signedSnapshot).max(8),
    lines: z
      .array(
        z
          .object({
            medicineId: id,
            presentationId: id,
            packLevelId: id,
            saleUnit: z.enum(['PACK', 'STRIP', 'UNIT']),
            quantity: z.number().int().positive().max(1000),
            canonicalUnitsPerSaleUnit: z.number().int().positive().max(10000),
            inventoryLotId: id,
            stockLocationId: id,
          })
          .strict()
      )
      .min(1)
      .max(50),
    amountMinor: z.number().int().positive().safe(),
    cashReceivedMinor: z.number().int().positive().safe(),
  })
  .strict();

export type CounterReplay = z.infer<typeof counterReplaySchema>;
