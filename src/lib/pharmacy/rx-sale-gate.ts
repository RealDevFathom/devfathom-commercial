import { randomUUID } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export class PharmacyRxSaleGateError extends Error {
  constructor(
    readonly code:
      | 'SALE_NOT_OPEN'
      | 'PRESCRIPTION_INVALID'
      | 'AUTHORIZATION_EXHAUSTED'
      | 'FILL_REQUIRED'
  ) {
    super(code);
    this.name = 'PharmacyRxSaleGateError';
  }
}

type DispensedFill = {
  id: string;
  saleLineId: string;
  prescriptionLineId: string;
  quantityCanonicalUnits: number;
};

/** Reserve an Rx-only sale line against its prescription. Both lifecycle rows are locked. */
export async function dispenseRxSaleLine(
  db: ScopedDb,
  input: {
    organizationId: string;
    branchId: string;
    saleLineId: string;
    prescriptionLineId: string;
    actorId: string;
    idempotencyKey: string;
    at?: Date;
  }
): Promise<DispensedFill> {
  const at = input.at ?? new Date();
  const sales = await db.$queryRaw<Array<{ status: string; canonicalUnits: number; medicineId: string; rx: boolean; controlled: boolean }>>(Prisma.sql`
    SELECT sale.status::text, line."canonicalUnits", line."medicineId", medicine.rx, medicine.controlled
      FROM pharmacy_sale_lines line
      JOIN pharmacy_sales sale ON sale."organizationId"=line."organizationId" AND sale.id=line."saleId" AND sale."branchId"=line."branchId"
      JOIN pharmacy_medicines medicine ON medicine.id=line."medicineId"
     WHERE line."organizationId"=${input.organizationId} AND line."branchId"=${input.branchId} AND line.id=${input.saleLineId}
     FOR UPDATE OF sale`);
  const sale = sales[0];
  if (!sale || sale.status !== 'OPEN') throw new PharmacyRxSaleGateError('SALE_NOT_OPEN');
  if (!sale.rx || sale.controlled) throw new PharmacyRxSaleGateError('PRESCRIPTION_INVALID');

  await db.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_prescription_lines WHERE "organizationId"=${input.organizationId} AND id=${input.prescriptionLineId} FOR UPDATE`);
  const prescriptions = await db.$queryRaw<Array<{ medicineId: string; validFrom: Date; validUntil: Date; authorizedCanonicalUnits: number; usedUnits: number; nextSequence: number }>>(Prisma.sql`
    SELECT line."medicineId", rx."validFrom", rx."validUntil", line."authorizedCanonicalUnits",
           COALESCE(SUM(fill."quantityCanonicalUnits") FILTER (WHERE fill."reversedAt" IS NULL AND fill."saleLineId" IS DISTINCT FROM ${input.saleLineId}),0)::int AS "usedUnits",
           (COALESCE(MAX(fill."fillSequence"),0)+1)::int AS "nextSequence"
      FROM pharmacy_prescription_lines line
      JOIN pharmacy_prescriptions rx ON rx."organizationId"=line."organizationId" AND rx.id=line."prescriptionId"
      LEFT JOIN pharmacy_prescription_fills fill ON fill."organizationId"=line."organizationId" AND fill."prescriptionLineId"=line.id
     WHERE line."organizationId"=${input.organizationId} AND line.id=${input.prescriptionLineId}
     GROUP BY line.id, line."medicineId", rx."validFrom", rx."validUntil", line."authorizedCanonicalUnits"`);
  const rx = prescriptions[0];
  if (!rx || rx.medicineId !== sale.medicineId || rx.validFrom > at || rx.validUntil <= at)
    throw new PharmacyRxSaleGateError('PRESCRIPTION_INVALID');
  if (rx.authorizedCanonicalUnits - rx.usedUnits < sale.canonicalUnits)
    throw new PharmacyRxSaleGateError('AUTHORIZATION_EXHAUSTED');

  const rows = await db.$queryRaw<DispensedFill[]>(Prisma.sql`
    INSERT INTO pharmacy_prescription_fills
      (id,"organizationId","prescriptionLineId","saleLineId","fillSequence","quantityCanonicalUnits","dispensedByUserId","dispensedAt","idempotencyKey")
    VALUES (${randomUUID()},${input.organizationId},${input.prescriptionLineId},${input.saleLineId},${rx.nextSequence},${sale.canonicalUnits},${input.actorId},${at},${input.idempotencyKey})
    ON CONFLICT ("organizationId","saleLineId") WHERE "saleLineId" IS NOT NULL DO NOTHING
    RETURNING id,"saleLineId","prescriptionLineId","quantityCanonicalUnits"`);
  if (rows[0]) return rows[0];
  const existing = await db.$queryRaw<DispensedFill[]>(Prisma.sql`SELECT id,"saleLineId","prescriptionLineId","quantityCanonicalUnits" FROM pharmacy_prescription_fills WHERE "organizationId"=${input.organizationId} AND "saleLineId"=${input.saleLineId}`);
  if (existing[0]?.prescriptionLineId !== input.prescriptionLineId || existing[0]?.quantityCanonicalUnits !== sale.canonicalUnits)
    throw new PharmacyRxSaleGateError('PRESCRIPTION_INVALID');
  return existing[0];
}

/** Checkout consumes the reservation; it never counts authorized units again. */
export async function assertRxSaleLinesReady(
  db: ScopedDb,
  organizationId: string,
  sale: { lines: Array<{ id: string; medicine: { rx: boolean; controlled: boolean } }> },
  at = new Date()
) {
  const required = sale.lines
    .filter((line) => line.medicine.rx && !line.medicine.controlled)
    .map((line) => line.id);
  if (!required.length) return;
  const rows = await db.$queryRaw<Array<{ saleLineId: string }>>(Prisma.sql`
    SELECT fill."saleLineId"
      FROM pharmacy_prescription_fills fill
      JOIN pharmacy_prescription_lines line ON line."organizationId"=fill."organizationId" AND line.id=fill."prescriptionLineId"
      JOIN pharmacy_prescriptions rx ON rx."organizationId"=line."organizationId" AND rx.id=line."prescriptionId"
      JOIN pharmacy_pharmacist_review_items review ON review."organizationId"=fill."organizationId" AND review."saleLineId"=fill."saleLineId" AND review."prescriptionLineId"=fill."prescriptionLineId"
      JOIN pharmacy_pharmacist_review_decisions decision ON decision."organizationId"=review."organizationId" AND decision."reviewItemId"=review.id AND decision.kind='SIGN' AND decision."signedAt" IS NOT NULL
     WHERE fill."organizationId"=${organizationId} AND fill."saleLineId" IN (${Prisma.join(required)}) AND fill."reversedAt" IS NULL
       AND rx."validFrom" <= ${at} AND rx."validUntil" > ${at}
     GROUP BY fill."saleLineId" HAVING COUNT(DISTINCT fill.id)=1`);
  if (new Set(rows.map((row) => row.saleLineId)).size !== required.length)
    throw new PharmacyRxSaleGateError('FILL_REQUIRED');
}

export async function reverseSaleFills(
  db: ScopedDb,
  organizationId: string,
  saleId: string,
  actorId: string
) {
  await db.$executeRaw(Prisma.sql`UPDATE pharmacy_prescription_fills fill SET "reversedAt"=now(), "reversedByUserId"=${actorId} FROM pharmacy_sale_lines line WHERE line."organizationId"=${organizationId} AND line."saleId"=${saleId} AND fill."organizationId"=line."organizationId" AND fill."saleLineId"=line.id AND fill."reversedAt" IS NULL`);
}
