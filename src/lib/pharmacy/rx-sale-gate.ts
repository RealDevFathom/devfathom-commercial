import { can } from '@/lib/abac';
import { capabilityMatches } from '@/lib/abac/capabilities';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { assertBranchAssignment } from './branch-assignment';
import type { LedgerScope } from './stock-ledger';

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

export const RX_LINE_APPROVAL = 'PHARMACY:RX_LINE_APPROVED';

/** Delegation supplies a missing clinical grant; it never overrides a DENY. */
export async function assertRxDelegationAllowed(db: ScopedDb, scope: LedgerScope) {
  const actor = await db.user.findUnique({
    where: { id: scope.actorId, organizationId: scope.organizationId, status: 'ACTIVE' },
    select: {
      organizationRole: { select: { permissions: { select: { capability: true, effect: true } } } },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  if (
    !actor ||
    [...actor.permissionOverrides, ...(actor.organizationRole?.permissions ?? [])].some(
      (rule) =>
        rule.effect === 'DENY' && capabilityMatches(rule.capability, 'pharmacy:dispense', 'DENY')
    )
  )
    throw new PharmacyRxSaleDenied();
}

type ApprovedLine = {
  id: string;
  medicineId: string;
  presentationId: string;
  canonicalUnits: number;
  prescriptionLineId?: string | null;
  medicine: { rx: boolean; restricted: boolean; controlled: boolean };
};

/** Revalidate line-specific pharmacist evidence before payment and completion.
 * Approval belongs to the requesting cashier, exact line and quantity; another
 * cart, cashier or a now-ineligible pharmacist cannot reuse it.
 */
export async function assertRxSaleLinesAllowed(
  db: ScopedDb,
  scope: LedgerScope,
  sale: { id: string; createdByUserId: string; lines: readonly ApprovedLine[] }
): Promise<Map<string, string>> {
  const checkers = new Map<string, string>();
  const lines = sale.lines.filter(
    (line) => needsRxSaleGrant(line.medicine) || line.prescriptionLineId
  );
  if (!lines.length) return checkers;
  const actorCanDispense = await can(
    { id: scope.actorId, role: 'EMPLOYEE', organizationId: scope.organizationId },
    'pharmacy:dispense',
    undefined,
    { db }
  );
  if (actorCanDispense) return checkers;
  await assertRxDelegationAllowed(db, scope);
  for (const line of lines) {
    const approval = await db.auditLog.findFirst({
      where: {
        organizationId: scope.organizationId,
        action: RX_LINE_APPROVAL,
        targetType: 'PharmacySaleLine',
        targetId: line.id,
        AND: [
          { metadata: { path: ['saleId'], equals: sale.id } },
          { metadata: { path: ['branchId'], equals: scope.branchId } },
          { metadata: { path: ['requestedById'], equals: scope.actorId } },
          { metadata: { path: ['medicineId'], equals: line.medicineId } },
          { metadata: { path: ['presentationId'], equals: line.presentationId } },
          { metadata: { path: ['canonicalUnits'], equals: line.canonicalUnits } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: { actorId: true },
    });
    if (!approval) throw new PharmacyRxSaleDenied();
    const checkerId = approval.actorId;
    if (!checkerId) throw new PharmacyRxSaleDenied();
    if (checkerId !== scope.actorId) {
      const checker = await db.user.findFirst({
        where: { id: checkerId, organizationId: scope.organizationId, status: 'ACTIVE' },
        select: { organizationRole: { select: { key: true } } },
      });
      if (checkerId === sale.createdByUserId || checker?.organizationRole?.key !== 'pharmacist')
        throw new PharmacyRxSaleDenied();
    }
    await assertBranchAssignment(db, { ...scope, actorId: checkerId });
    await assertRxSaleAllowed(db, { actorId: checkerId }, [line.medicine]);
    if (
      line.prescriptionLineId &&
      !(await can(
        { id: checkerId, role: 'EMPLOYEE', organizationId: scope.organizationId },
        'pharmacy:dispense',
        undefined,
        { db }
      ))
    )
      throw new PharmacyRxSaleDenied();
    checkers.set(line.id, checkerId);
  }
  return checkers;
}
