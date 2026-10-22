import { can, type Subject } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export type RxSaleGateInput = {
  organizationId: string;
  actor: Subject;
  prescriptionId: string;
  now?: Date;
};

/**
 * Decide whether an actor may release a prescription sale.
 *
 * This boundary deliberately has no organization-policy or owner fallback:
 * `pharmacy:dispense` is an exact-grant-only capability and the central ABAC
 * decision is authoritative (including its DENY-wins behaviour).
 *
 * The prescription lookup is part of the gate rather than a later convenience
 * read. Consequently an absent, stale, or cross-tenant reference cannot be
 * used to turn an otherwise valid dispense grant into an Rx sale.
 */
export async function canReleaseRxSale(
  db: ScopedDb,
  input: RxSaleGateInput
): Promise<boolean> {
  if (
    !(await can(input.actor, 'pharmacy:dispense', undefined, {
      db,
      now: input.now,
    }))
  ) {
    return false;
  }

  const prescription = await db.prescription.findFirst({
    where: {
      id: input.prescriptionId,
      organizationId: input.organizationId,
    },
    select: { id: true },
  });

  return prescription !== null;
}
