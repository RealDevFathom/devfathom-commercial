import { z } from 'zod';

const id = z.string().min(1);
const units = z.number().int().positive().safe();
const allocationSchema = z
  .object({
    allocationId: id,
    inventoryLotId: id,
    // DEV-853: null when legacy opening stock never recorded it. The receipt
    // says "Batch not recorded" / "Expiry not recorded" in plain words.
    batchNumber: id.nullable(),
    expiresAt: z.iso.datetime().nullable(),
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
    presentation: id,
    /** #708: absent on snapshots issued before manufacturers were recorded. */
    manufacturer: z.string().trim().min(1).max(300).optional(),
    allocations: z.array(allocationSchema).min(1),
  })
  .strict();
const snapshotSchema = z
  .object({
    receiptIdentitySnapshotVersion: z.literal(1),
    cashMemoIdentity: z
      .object({
        address: z.string().nullable().optional(),
        phone: z.string().nullable().optional(),
        licenceNumber: z.string().nullable().optional(),
        ntn: z.string().nullable(),
        strn: z.string().nullable(),
        provinceCode: z.string().nullable().optional(),
        licenceValidFrom: z.iso.datetime().nullable().optional(),
        licenceValidTo: z.iso.datetime().nullable().optional(),
        pharmacistRegistration: z.string().nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    saleId: id,
    receiptNumber: units,
    /** DEV-637: the number printed offline when replay gave the sale a fresh number. */
    offlineReference: units.optional(),
    offlineSoldDay: z.iso.date().optional(),
    deviceId: id,
    businessDate: z.iso.date(),
    issuedAt: z.iso.datetime(),
    /** #708: the buyer the cash memo names; absent for an unnamed walk-in. */
    buyerName: z.string().trim().min(1).max(200).optional(),
    lines: z.array(lineSchema).min(1),
  })
  .strict();

export type ReceiptIdentitySnapshot = z.infer<typeof snapshotSchema>;
export type ReceiptIdentityAllocation = z.infer<typeof allocationSchema>;
export type ReceiptIdentityFacts = {
  id: string;
  receiptNumber: number | null;
  receiptDeviceId: string | null;
  /** DEV-637: compared only when the caller read it. */
  offlineReceiptReference?: number | null;
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
    snapshot.lines.length !== sale.lines.length ||
    (sale.offlineReceiptReference !== undefined &&
      (snapshot.offlineReference ?? null) !== sale.offlineReceiptReference)
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
