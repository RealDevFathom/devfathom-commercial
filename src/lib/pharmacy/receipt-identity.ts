import { z } from 'zod';

const id = z.string().min(1);
const units = z.number().int().positive().safe();
const allocationSchema = z
  .object({
    allocationId: id,
    inventoryLotId: id,
    batchNumber: id,
    expiresAt: z.iso.datetime(),
    canonicalUnits: units,
  })
  .strict();
const lineSchema = z
  .object({
    saleLineId: id,
    medicineId: id,
    presentationId: id,
    medicineName: id,
    strength: id.nullable(),
    /**
     * #708: the catalog manufacturer as issued, so a reprint of a Sindh cash memo
     * shows the manufacturer printed originally. Optional: snapshots issued before
     * #708 carry no manufacturer and render it as unavailable, never as today's.
     */
    manufacturer: z.string().min(1).max(200).nullable().optional(),
    presentation: id,
    allocations: z.array(allocationSchema).min(1),
  })
  .strict();
const snapshotSchema = z
  .object({
    receiptIdentitySnapshotVersion: z.literal(1),
    saleId: id,
    receiptNumber: units,
    deviceId: id,
    businessDate: z.iso.date(),
    issuedAt: z.iso.datetime(),
    // Absent only on legacy snapshots. Explicit null freezes a non-Sindh receipt too.
    cashMemo: z
      .object({
        template: z.literal('SINDH_CASH_MEMO'),
        licenceNumber: id.nullable(),
        licenceValidFrom: z.iso.datetime().nullable(),
        licenceValidTo: z.iso.datetime().nullable(),
        pharmacistRegistration: id.nullable(),
      })
      .strict()
      .nullable()
      .optional(),
    lines: z.array(lineSchema).min(1),
  })
  .strict();

export type ReceiptIdentitySnapshot = z.infer<typeof snapshotSchema>;
export type ReceiptIdentityAllocation = z.infer<typeof allocationSchema>;
export type ReceiptIdentityFacts = {
  id: string;
  receiptNumber: number | null;
  receiptDeviceId: string | null;
  businessDate: Date | null;
  completedAt: Date | null;
  lines: readonly {
    id: string;
    medicineId: string;
    presentationId: string;
    canonicalUnits: number;
    allocations: readonly { id: string; inventoryLotId: string; canonicalUnits: number }[];
  }[];
};

export class PharmacyReceiptIdentityError extends Error {
  constructor() {
    super('INVALID_RECEIPT_IDENTITY');
  }
}

/** Validate immutable correspondence, never compare issued labels to today's catalog. */
export function validateReceiptIdentity(payload: unknown, sale: ReceiptIdentityFacts) {
  const parsed = snapshotSchema.safeParse(payload);
  if (!parsed.success) throw new PharmacyReceiptIdentityError();
  const snapshot = parsed.data;
  const refuse = () => {
    throw new PharmacyReceiptIdentityError();
  };
  if (
    snapshot.saleId !== sale.id ||
    snapshot.receiptNumber !== sale.receiptNumber ||
    snapshot.deviceId !== sale.receiptDeviceId ||
    snapshot.businessDate !== sale.businessDate?.toISOString().slice(0, 10) ||
    snapshot.issuedAt !== sale.completedAt?.toISOString() ||
    snapshot.lines.length !== sale.lines.length
  )
    refuse();
  const lineIds = new Set<string>();
  const allocationIds = new Set<string>();
  for (const line of snapshot.lines) {
    const fact = sale.lines.find((row) => row.id === line.saleLineId);
    if (!fact || lineIds.has(line.saleLineId)) return refuse();
    lineIds.add(line.saleLineId);
    if (
      line.medicineId !== fact.medicineId ||
      line.presentationId !== fact.presentationId ||
      line.allocations.length !== fact.allocations.length
    )
      refuse();
    let total = 0;
    for (const allocation of line.allocations) {
      const actual = fact.allocations.find((row) => row.id === allocation.allocationId);
      if (
        !actual ||
        allocationIds.has(allocation.allocationId) ||
        actual.inventoryLotId !== allocation.inventoryLotId ||
        actual.canonicalUnits !== allocation.canonicalUnits
      )
        refuse();
      allocationIds.add(allocation.allocationId);
      total += allocation.canonicalUnits;
    }
    if (!Number.isSafeInteger(total) || total !== fact.canonicalUnits) refuse();
  }
  return snapshot;
}

/** Status-only COMPLETED events are not evidence of numbered issuance. */
export function readReceiptIdentity(
  events: readonly { payload: unknown }[],
  sale: ReceiptIdentityFacts
) {
  const candidates = events.filter(
    ({ payload }) =>
      payload !== null &&
      typeof payload === 'object' &&
      Object.prototype.hasOwnProperty.call(payload, 'receiptIdentitySnapshotVersion')
  );
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) throw new PharmacyReceiptIdentityError();
  return validateReceiptIdentity(candidates[0]!.payload, sale);
}
