import { actorCanProcure } from './procurement-access';
import { TRPCError } from '@trpc/server';
import { assertBranchAssignment } from './branch-assignment';
import { can } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { authorizeSoloApproval, verifyPharmacyUserPin } from './solo-approval';

export type PharmacyApprovalKind =
  'RX' | 'OVERRIDE' | 'REFUND' | 'RETURN' | 'DISCOUNT' | 'ADJUSTMENT' | 'PURCHASE';

const NON_CLINICAL_APPROVAL_CAPABILITY = {
  OVERRIDE: 'pharmacy:counter',
  REFUND: 'pharmacy:counter',
  RETURN: 'pharmacy:counter',
  DISCOUNT: 'pharmacy:counter',
  ADJUSTMENT: 'pharmacy:inventory',
} as const satisfies Record<Exclude<PharmacyApprovalKind, 'RX' | 'PURCHASE'>, string>;
/** Call inside the document transaction. Identity and roles always come from storage. */
export async function enforceOperatingMode(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string | null; actorId: string },
  input: {
    kind: PharmacyApprovalKind;
    makerIds: Array<string | null>;
    targetType: string;
    targetId: string;
    pin?: string;
    checkerId?: string;
  }
) {
  const readMode = async () =>
    (
      await db.organization.findFirstOrThrow({
        where: { id: scope.organizationId, vertical: 'PHARMACY' },
        select: { pharmacyOperatingMode: true },
      })
    ).pharmacyOperatingMode;
  let mode = await readMode();
  // Only SOLO evidence depends on the mode at commit (pharmacy_solo_mode_audit), so
  // only SOLO approvals hold the organization row. STAFFED approvals need an
  // independent checker whatever the mode becomes, so concurrent counters do not
  // serialize on one tenant row. A concurrent switch to SOLO can only make this
  // approval stricter.
  if (mode === 'SOLO') {
    await db.$queryRaw`SELECT id FROM organizations WHERE id=${scope.organizationId} FOR NO KEY UPDATE`;
    // Roster writers take the shared roster lock, not the organization row: hold the
    // exclusive one so the singleton-owner check cannot race a staff activation.
    await db.$queryRaw`SELECT pharmacy_lock_solo_roster(${scope.organizationId})::text`;
    mode = await readMode();
  }
  if (
    mode === 'SOLO' &&
    (input.checkerId ?? scope.actorId) === scope.actorId &&
    input.makerIds.includes(scope.actorId)
  ) {
    const capable =
      input.kind === 'PURCHASE'
        ? await actorCanProcure(db, scope.actorId)
        : await can(
            { id: scope.actorId, role: 'EMPLOYEE', organizationId: scope.organizationId },
            input.kind === 'RX'
              ? 'pharmacy:dispense'
              : NON_CLINICAL_APPROVAL_CAPABILITY[input.kind],
            undefined,
            { db }
          );
    if (!capable)
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Approval capability required.' });
    if (
      await authorizeSoloApproval(
        db,
        scope,
        { type: input.targetType, id: input.targetId },
        input.pin
      )
    )
      return { actorId: scope.actorId, policy: 'PHARMACY:SOLO_OWNER_PIN' };
  } else {
    const checkerId = input.checkerId ?? scope.actorId;
    // Organization-wide documents (for example the default pack price) have no
    // branch. Branch-scoped documents still require a live assignment.
    if (scope.branchId)
      await assertBranchAssignment(db, { ...scope, branchId: scope.branchId, actorId: checkerId });
    const actor = await db.user.findFirst({
      where: { id: checkerId, organizationId: scope.organizationId, status: 'ACTIVE' },
      select: { organizationRole: { select: { key: true } } },
    });
    if (!actor)
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Active checker membership required.' });
    const role = actor.organizationRole?.key;
    // Rx is a clinical grant, not a role name: any live pharmacy:dispense holder
    // (including a custom pharmacist role or a pharmacist-owner) may check it.
    const eligible =
      input.kind === 'RX'
        ? (await can(
            { id: checkerId, role: 'EMPLOYEE', organizationId: scope.organizationId },
            'pharmacy:dispense',
            undefined,
            { db }
          ))
        : input.kind === 'PURCHASE'
          ? await actorCanProcure(db, checkerId)
          : (role === 'owner' || role === 'manager') &&
            (await can(
              { id: checkerId, role: 'EMPLOYEE', organizationId: scope.organizationId },
              NON_CLINICAL_APPROVAL_CAPABILITY[input.kind],
              undefined,
              { db }
            ));
    // A dispense-qualified seller approving their own Rx line is the pharmacist
    // dispensing, as before operating modes. Only a delegated checker needs a PIN;
    // cashiers still need an independent dispense holder.
    const selfDispense = input.kind === 'RX' && checkerId === scope.actorId;
    if (eligible && (selfDispense || !input.makerIds.includes(checkerId))) {
      if (
        checkerId !== scope.actorId &&
        !(await verifyPharmacyUserPin({ ...scope, actorId: checkerId }, input.pin, scope.actorId))
      )
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Checker PIN re-authentication required.',
        });
      const policy = `PHARMACY:STAFFED:${input.kind}`;
      await db.auditLog.create({
        data: {
          organizationId: scope.organizationId,
          actorId: checkerId,
          source: 'TRPC',
          category: 'PHARMACY',
          action: policy,
          targetType: input.targetType,
          targetId: input.targetId,
          metadata: {
            branchId: scope.branchId,
            operatingMode: 'STAFFED',
            makerIds: input.makerIds,
            ...(selfDispense && input.makerIds.includes(checkerId) ? { selfDispense: true } : {}),
          },
        },
      });
      return { actorId: checkerId, policy };
    }
  }
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'Independent authorized approval or SOLO owner PIN re-authentication required.',
  });
}
