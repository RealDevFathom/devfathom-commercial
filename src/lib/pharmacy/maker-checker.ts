import { z } from 'zod';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { can } from '@/lib/abac';
import { assertBranchAssignment } from './branch-assignment';
import {
  authorizeSoloApproval,
  pinProfileBelongsToActor,
  verifySoloOwnerPin,
  soloOwnerEligible,
  SOLO_APPROVAL_POLICY,
} from './solo-approval';
export const SOLO_OWNER_POLICY = SOLO_APPROVAL_POLICY;
export const approvalPinSchema = z
  .object({ staffProfileId: z.string().min(1).optional(), pin: z.string().regex(/^\d{4,8}$/) })
  .strict();
export async function authorizeMakerChecker(
  db: ScopedDb,
  input: {
    organizationId: string;
    actorId: string;
    makerIds: Array<string | null>;
    targetType: string;
    targetId: string;
    pin?: z.infer<typeof approvalPinSchema>;
    requirePin?: boolean;
    requestedById?: string;
    branchId?: string;
  }
): Promise<{ policy: string } | { blocked: string; pinRejected?: true }> {
  const self = input.makerIds.includes(input.actorId);
  if (!self && !input.requirePin) return { policy: 'PUR-02:SEGREGATION_OF_DUTIES' };
  const blocked = { blocked: 'SELF_APPROVAL' };
  const scope = { ...input, branchId: input.branchId ?? null };
  if (!input.pin) return blocked;
  if (
    input.pin.staffProfileId &&
    !(await pinProfileBelongsToActor(db, scope, input.pin.staffProfileId))
  )
    return blocked;
  if (input.branchId) await assertBranchAssignment(db, { ...input, branchId: input.branchId });
  if (
    !(await can(
      { id: input.actorId, role: 'EMPLOYEE', organizationId: input.organizationId },
      'pharmacy:procurement',
      undefined,
      { db }
    ))
  )
    return blocked;
  if (self && !(await soloOwnerEligible(db, scope))) return blocked;
  if (self)
    return (await authorizeSoloApproval(
      db,
      scope,
      { type: input.targetType, id: input.targetId },
      input.pin.pin
    ))
      ? { policy: SOLO_OWNER_POLICY }
      : { ...blocked, pinRejected: true };
  return (await verifySoloOwnerPin(db, scope, input.pin.pin))
    ? { policy: 'PUR-02:SEGREGATION_OF_DUTIES' }
    : blocked;
}
