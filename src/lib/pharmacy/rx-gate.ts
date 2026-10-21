/**
 * SEC (live High): server-side prescription gate for regulated sale lines.
 *
 * A medicine flagged `rx` or `restricted` (and not `controlled`, which has its
 * own register flow) may only sit on a payable bill when the line carries an
 * append-only `PharmacyRxLineAuthorization`: a linked prescription line, or an
 * audited pharmacist override with a reason. Controlled lines need the fill the
 * controlled path writes (`controlled:<saleLineId>`).
 *
 * Tender, complete and sandbox payment call `assertSaleLinesCleared`, which
 * locks the sale lines and re-reads the CURRENT medicine flags, so a line
 * inserted around `addLine` or a flag flipped after it is refused at payment.
 */
import { Prisma } from '@/generated/prisma/client';
import type { LedgerScope } from './stock-ledger';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export type RegulatedFlags = { rx: boolean; restricted: boolean; controlled: boolean };

export class PharmacySafetyBlockError extends Error {
  readonly reason = 'SAFETY_BLOCK' as const;
  constructor(readonly saleLineIds: string[]) {
    super('SAFETY_BLOCK');
    this.name = 'PharmacySafetyBlockError';
  }
}

export function needsPrescription(medicine: RegulatedFlags | null | undefined): boolean {
  return Boolean(medicine && (medicine.rx || medicine.restricted || medicine.controlled));
}

export function controlledFillKey(saleLineId: string): string {
  return `controlled:${saleLineId}`;
}

export async function assertSaleLinesCleared(
  db: ScopedDb,
  scope: LedgerScope,
  saleId: string
): Promise<void> {
  // One statement: lock this sale's lines and read the medicine flags as they are NOW.
  const lines = await db.$queryRaw<
    Array<{ id: string; rx: boolean; restricted: boolean; controlled: boolean }>
  >(
    Prisma.sql`SELECT l.id, m.rx, m.restricted, m.controlled
      FROM pharmacy_sale_lines AS l
      JOIN pharmacy_medicines AS m ON m.id = l."medicineId" AND m."organizationId" = l."organizationId"
      WHERE l."organizationId" = ${scope.organizationId} AND l."branchId" = ${scope.branchId} AND l."saleId" = ${saleId}
      FOR UPDATE OF l`
  );
  const regulated = (Array.isArray(lines) ? lines : []).filter((line) => needsPrescription(line));
  if (regulated.length === 0) return;
  const ids = regulated.map((line) => line.id);
  const [authorizations, fills] = await Promise.all([
    db.pharmacyRxLineAuthorization.findMany({
      where: { organizationId: scope.organizationId, saleLineId: { in: ids } },
      select: { saleLineId: true },
    }),
    db.prescriptionFill.findMany({
      where: {
        organizationId: scope.organizationId,
        idempotencyKey: { in: ids.map(controlledFillKey) },
      },
      select: { idempotencyKey: true },
    }),
  ]);
  const authorized = new Set(authorizations.map((row) => row.saleLineId));
  const filled = new Set(fills.map((row) => row.idempotencyKey));
  const refused = regulated
    .filter((line) =>
      line.controlled
        ? !filled.has(controlledFillKey(line.id))
        : !authorized.has(line.id) && !filled.has(controlledFillKey(line.id))
    )
    .map((line) => line.id);
  if (refused.length > 0) throw new PharmacySafetyBlockError(refused);
}
