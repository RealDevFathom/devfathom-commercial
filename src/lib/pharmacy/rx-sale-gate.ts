import { can } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { readAllowCashierRxSale } from './owner-policy';

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
 * The exact pharmacy:dispense grant (central ABAC over persisted roles and overrides; a DENY
 * wins, wildcards never qualify), or the organization's allowCashierRxSale owner policy.
 */
export async function assertRxSaleAllowed(
  db: ScopedDb,
  scope: { organizationId: string; actorId: string },
  medicines: ReadonlyArray<{ rx: boolean; restricted: boolean; controlled: boolean } | undefined>
): Promise<void> {
  if (!medicines.some(needsRxSaleGrant)) return;
  if (await can({ id: scope.actorId, role: 'EMPLOYEE' }, 'pharmacy:dispense', undefined, { db }))
    return;
  if (await readAllowCashierRxSale(db, scope.organizationId)) return;
  throw new PharmacyRxSaleDenied();
}
