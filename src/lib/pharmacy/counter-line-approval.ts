import { can } from '@/lib/abac';
import type { Action } from '@/lib/abac/policies';
import type { Subject } from '@/lib/abac/types';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';

/** A supervisor's staff profile and PIN, entered at the counter for this one line. */
export type CounterApprovalPin = { staffProfileId: string; pin: string };

export type CounterApprovalKind = 'DISCOUNT' | 'FEFO_OVERRIDE';

/** Server-derived approval evidence persisted on the sale line / allocation override. */
export type CounterApproval = {
  approvedByUserId: string;
  approvalPolicy: string;
  selfApproved: boolean;
};

/**
 * #520: discount and FEFO-override approvals were caller-supplied text. The approver is now
 * resolved here from a credential the server verifies; callers never name the approver.
 *
 * - DISCOUNT needs a different active member holding `pharmacy:manage`, proven by their PIN.
 *   The operator can never approve their own discount, even when they are the only holder.
 * - FEFO_OVERRIDE is a pharmacist's decision: an actor holding `pharmacy:dispense` approves it
 *   as the pharmacist on duty; anyone else needs an active pharmacist's PIN.
 */
export const COUNTER_APPROVAL_CAPABILITY: Record<CounterApprovalKind, Action> = {
  DISCOUNT: 'pharmacy:manage',
  FEFO_OVERRIDE: 'pharmacy:dispense',
};

export class CounterApprovalDenied extends Error {
  constructor(readonly kind: CounterApprovalKind) {
    super(
      kind === 'DISCOUNT'
        ? 'A discount needs a manager to approve it with their PIN.'
        : 'A non-FEFO batch needs a pharmacist to approve it with their PIN.'
    );
  }
}

type ActiveUser = Subject & { organizationId: string | null };

/**
 * Resolve the approval inside the sale transaction, before stock is allocated. PIN checks run
 * in their own tenant transaction so a refusal (or a later sale failure) never rolls back the
 * credential's failed-attempt counter and lockout.
 */
export async function authorizeCounterApproval(
  db: ScopedDb,
  scope: LedgerScope,
  kind: CounterApprovalKind,
  input?: CounterApprovalPin
): Promise<CounterApproval> {
  const capability = COUNTER_APPROVAL_CAPABILITY[kind];
  const actor = (await db.user.findFirst({
    where: { id: scope.actorId, organizationId: scope.organizationId, status: 'ACTIVE' },
  })) as ActiveUser | null;
  if (!actor) throw new CounterApprovalDenied(kind);
  if (kind === 'FEFO_OVERRIDE' && (await can(actor, capability, undefined, { db }))) {
    return {
      approvedByUserId: actor.id,
      approvalPolicy: 'PHARMACIST_ON_DUTY',
      selfApproved: false,
    };
  }
  if (!input) throw new CounterApprovalDenied(kind);
  const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
  const approval = await withTenantDb(
    scope.organizationId,
    (credentialDb) => verifyApproverPin(credentialDb, scope, kind, input),
    { userId: scope.actorId, skipDrain: true }
  );
  // Throw only after the credential transaction has committed any failed attempt.
  if (!approval) throw new CounterApprovalDenied(kind);
  return approval;
}

async function verifyApproverPin(
  db: ScopedDb,
  scope: LedgerScope,
  kind: CounterApprovalKind,
  input: CounterApprovalPin
): Promise<CounterApproval | null> {
  const capability = COUNTER_APPROVAL_CAPABILITY[kind];
  await db.$queryRaw`SELECT id FROM restaurant_operator_credentials WHERE "organizationId"=${scope.organizationId} AND "staffProfileId"=${input.staffProfileId} AND type='PIN' AND "revokedAt" IS NULL AND "deviceId" IS NULL FOR UPDATE`;
  const credential = await db.restaurantOperatorCredential.findFirst({
    where: {
      organizationId: scope.organizationId,
      staffProfileId: input.staffProfileId,
      type: 'PIN',
      revokedAt: null,
      deviceId: null,
    },
    include: { staffProfile: { include: { user: true } } },
  });
  const approver = credential?.staffProfile.user;
  const now = new Date();
  if (
    !credential ||
    credential.staffProfile.status !== 'ACTIVE' ||
    !approver ||
    approver.organizationId !== scope.organizationId ||
    approver.status !== 'ACTIVE' ||
    isLockedOut(credential, now) ||
    !(await can(approver, capability, undefined, { db, now }))
  ) {
    return null;
  }
  // The operator may never approve their own discount or override.
  if (approver.id === scope.actorId) return null;
  if (!(await verifyOperatorCredential('PIN', input.pin, credential.credentialHash))) {
    await db.restaurantOperatorCredential.update({
      where: { id: credential.id },
      data: registerFailedAttempt(credential, now),
    });
    return null;
  }
  await db.restaurantOperatorCredential.update({
    where: { id: credential.id },
    data: clearLockout(),
  });
  const approvalPolicy = kind === 'DISCOUNT' ? 'MANAGER_PIN' : 'PHARMACIST_PIN';
  return { approvedByUserId: approver.id, approvalPolicy, selfApproved: false };
}
