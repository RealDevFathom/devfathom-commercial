import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { duplicateSaltGroups, type DuplicateSaltGroup } from './duplicate-salt';

export class DuplicateSaltAcknowledgementError extends Error {
  constructor(readonly reason: 'NOT_FOUND' | 'NOT_DUPLICATE') {
    super(reason);
    this.name = 'DuplicateSaltAcknowledgementError';
  }
}

export type DuplicateSaltAcknowledgement = {
  saleId: string;
  branchId: string;
  ingredientKey: string;
  ingredientName: string;
  medicines: DuplicateSaltGroup['medicines'];
  acknowledgedByUserId: string;
  acknowledgedAt: string;
};

/**
 * #724: confirm the duplicate-salt warning the operator acknowledged really
 * exists on this bill in this branch. The duplicate group is recomputed from the
 * stored sale lines, so a client cannot acknowledge a warning it invented or one
 * on another tenant's or branch's sale. Read-only: the caller audit-logs the
 * returned record, and the sale itself is never mutated or blocked.
 */
export async function verifyDuplicateSaltAcknowledgement(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string; actorId: string },
  input: { saleId: string; ingredientKey: string },
  at = new Date()
): Promise<DuplicateSaltAcknowledgement> {
  const sale = await db.pharmacySale.findFirst({
    where: { id: input.saleId, organizationId: scope.organizationId, branchId: scope.branchId },
    select: {
      id: true,
      lines: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          medicineId: true,
          medicine: {
            select: {
              productName: true,
              strengths: {
                select: { ingredientId: true, ingredient: { select: { name: true } } },
              },
            },
          },
        },
      },
    },
  });
  if (!sale) throw new DuplicateSaltAcknowledgementError('NOT_FOUND');

  const group = duplicateSaltGroups(
    sale.lines.map((line) => ({
      ref: line.id,
      medicineId: line.medicineId,
      displayName: line.medicine.productName,
      activeIngredients: line.medicine.strengths.map((component) => ({
        ingredientId: component.ingredientId,
        name: component.ingredient.name,
      })),
    }))
  ).find((candidate) => candidate.ingredientKey === input.ingredientKey);
  if (!group) throw new DuplicateSaltAcknowledgementError('NOT_DUPLICATE');

  return {
    saleId: sale.id,
    branchId: scope.branchId,
    ingredientKey: group.ingredientKey,
    ingredientName: group.ingredientName,
    medicines: group.medicines,
    acknowledgedByUserId: scope.actorId,
    acknowledgedAt: at.toISOString(),
  };
}
