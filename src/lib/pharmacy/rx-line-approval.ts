import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { prescriptionReferenceFillKey } from './rx-prescription-reference';
import { assertRxSaleAllowed, needsRxSaleGrant } from './rx-sale-gate';
import type { LedgerScope } from './stock-ledger';

const REASONS = {
  LINE_NOT_FOUND: 'That line is not on this bill at this branch.',
  SALE_NOT_OPEN: 'This bill is no longer open, so its lines cannot be approved.',
  NOT_APPLICABLE:
    'Only a prescription-only or restricted, non-controlled line takes a pharmacist approval.',
} as const;

/** #341: a pharmacist approval that cannot be recorded for this line. */
export class PharmacyRxApprovalError extends Error {
  constructor(readonly reason: keyof typeof REASONS) {
    super(REASONS[reason]);
    this.name = 'PharmacyRxApprovalError';
  }
}

/**
 * #341: a pharmacist approves one prescription-only or restricted, non-controlled line of an
 * open bill, with a reason. The approver must pass the #518 gate (the exact pharmacy:dispense
 * grant, DENY wins), and the approval only clears the counter's POS-09 missing-prescription
 * block for that line: it never lets anyone without the grant add, pay for or complete it.
 * Append-only; approving an approved line again changes nothing.
 */
export async function approveRxLine(
  db: ScopedDb,
  scope: LedgerScope,
  input: { saleId: string; saleLineId: string; reason: string }
): Promise<{ saleLineId: string; approvedAt: Date; replayed: boolean }> {
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_sales WHERE id=${input.saleId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`
  );
  const line = await db.pharmacySaleLine.findFirst({
    where: {
      id: input.saleLineId,
      saleId: input.saleId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
    select: {
      id: true,
      sale: { select: { status: true } },
      medicine: { select: { rx: true, restricted: true, controlled: true } },
    },
  });
  if (!line) throw new PharmacyRxApprovalError('LINE_NOT_FOUND');
  if (line.sale.status !== 'OPEN') throw new PharmacyRxApprovalError('SALE_NOT_OPEN');
  if (!needsRxSaleGrant(line.medicine)) throw new PharmacyRxApprovalError('NOT_APPLICABLE');
  await assertRxSaleAllowed(db, scope, [line.medicine]);
  const inserted = await db.$queryRaw<Array<{ approvedAt: Date }>>(
    Prisma.sql`INSERT INTO pharmacy_rx_line_approvals ("organizationId", "saleLineId", "pharmacistUserId", "reason")
      VALUES (${scope.organizationId}, ${line.id}, ${scope.actorId}, ${input.reason.trim()})
      ON CONFLICT ("organizationId", "saleLineId") DO NOTHING
      RETURNING "approvedAt"`
  );
  if (inserted[0])
    return { saleLineId: line.id, approvedAt: inserted[0].approvedAt, replayed: false };
  const [existing] = await db.$queryRaw<Array<{ approvedAt: Date }>>(
    Prisma.sql`SELECT "approvedAt" FROM pharmacy_rx_line_approvals WHERE "organizationId"=${scope.organizationId} AND "saleLineId"=${line.id}`
  );
  return { saleLineId: line.id, approvedAt: existing!.approvedAt, replayed: true };
}

/**
 * #341: which of these sale lines a pharmacist has approved, or dispensed against a prescription
 * reference the server validated (#518). Either clears the line's POS-09 prescription block.
 */
export async function approvedRxLineIds(
  db: ScopedDb,
  organizationId: string,
  saleLineIds: readonly string[]
): Promise<Set<string>> {
  if (saleLineIds.length === 0) return new Set();
  const approvals = await db.$queryRaw<Array<{ saleLineId: string }>>(
    Prisma.sql`SELECT "saleLineId" FROM pharmacy_rx_line_approvals WHERE "organizationId"=${organizationId} AND "saleLineId" IN (${Prisma.join([...saleLineIds])})`
  );
  const byFillKey = new Map(saleLineIds.map((id) => [prescriptionReferenceFillKey(id), id]));
  const fills = await db.prescriptionFill.findMany({
    where: { organizationId, idempotencyKey: { in: [...byFillKey.keys()] } },
    select: { idempotencyKey: true },
  });
  return new Set([
    ...approvals.map((row) => row.saleLineId),
    ...fills.map((fill) => byFillKey.get(fill.idempotencyKey)!),
  ]);
}
