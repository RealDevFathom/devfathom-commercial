import { can } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** #518: refused because the actor may not sell this prescription-only line. */
export class PharmacyRxSaleDenied extends Error {
  constructor() {
    super(
      'Selling a prescription-only or restricted medicine needs the pharmacist dispensing permission.'
    );
    this.name = 'PharmacyRxSaleDenied';
  }
}

/** Rx or restricted, and not controlled (controlled lines keep their own register gate). */
export function needsRxSaleGrant(
  medicine: { rx: boolean; restricted: boolean; controlled: boolean } | null | undefined
): boolean {
  // Sale reads always include the line's medicine (a required relation).
  if (!medicine) return false;
  return (medicine.rx || medicine.restricted) && !medicine.controlled;
}

/**
 * #518: only someone central ABAC allows the exact pharmacy:dispense grant may sell an Rx or
 * restricted, non-controlled line: persisted role and user overrides, an explicit DENY wins, and
 * wildcards never qualify. There is deliberately no other way through (no owner policy, session
 * role or setting).
 */
export async function assertRxSaleAllowed(
  db: ScopedDb,
  scope: { actorId: string },
  medicines: ReadonlyArray<{ rx: boolean; restricted: boolean; controlled: boolean } | undefined>
): Promise<void> {
  if (!medicines.some(needsRxSaleGrant)) return;
  if (await can({ id: scope.actorId, role: 'EMPLOYEE' }, 'pharmacy:dispense', undefined, { db }))
    return;
  throw new PharmacyRxSaleDenied();
}
