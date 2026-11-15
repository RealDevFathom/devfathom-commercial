import { can } from '@/lib/abac';
import type { Action } from '@/lib/abac/policies';
import type { Subject } from '@/lib/abac/types';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';
import { hash as bcryptHash } from 'bcryptjs';
import {
  clearLockout,
  isLockedOut,
  OPERATOR_CREDENTIAL_BCRYPT_COST,
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
  /** The PIN credential that proved the approval; null for the pharmacist on duty. */
  credentialId: string | null;
};

/**
 * #520: discount and FEFO-override approvals were caller-supplied text. The approver is now
 * resolved here from a credential the server verifies; callers never name the approver.
 *
 * - DISCOUNT needs a different active member holding `pharmacy:manage`, proven by their PIN.
 *   Solo rule: when nobody else active in the organization holds that capability, the actor
 *   may approve their own discount by re-entering their own PIN (recorded as self-approved).
 * - FEFO_OVERRIDE is a pharmacist's decision: an actor holding `pharmacy:dispense` approves it
 *   as the pharmacist on duty; anyone else needs an active pharmacist's PIN.
 */
export const COUNTER_APPROVAL_CAPABILITY: Record<CounterApprovalKind, Action> = {
  DISCOUNT: 'pharmacy:manage',
  FEFO_OVERRIDE: 'pharmacy:dispense',
};

/**
 * The `approvalPolicy` stored on an allocation-override row for a server-verified FEFO
 * approval. The row's `actorId` names the operator; a different approver is named here.
 */
export function fefoOverrideApprovalPolicy(approval: CounterApproval, actorId: string): string {
  return approval.approvedByUserId === actorId
    ? approval.approvalPolicy
    : `${approval.approvalPolicy}:${approval.approvedByUserId}`;
}

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
 * Resolve the approval BEFORE the sale transaction opens. PIN checks run in their own tenant
 * transaction so a refusal (or a later sale failure) never rolls back the credential's
 * failed-attempt counter and lockout, and no request holds a sale connection while it waits
 * for a credential connection. `confirmCounterApproval` re-checks the result inside the sale.
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
      credentialId: null,
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

/**
 * Inside the sale transaction, before stock is allocated: the approver resolved by
 * `authorizeCounterApproval` must still be an active member holding the capability, and the
 * PIN credential that proved it must still be live on an active staff profile of theirs.
 */
export async function confirmCounterApproval(
  db: ScopedDb,
  scope: LedgerScope,
  kind: CounterApprovalKind,
  approval: CounterApproval
): Promise<void> {
  const approver = (await db.user.findFirst({
    where: {
      id: approval.approvedByUserId,
      organizationId: scope.organizationId,
      status: 'ACTIVE',
    },
  })) as ActiveUser | null;
  if (!approver || !(await can(approver, COUNTER_APPROVAL_CAPABILITY[kind], undefined, { db }))) {
    throw new CounterApprovalDenied(kind);
  }
  if (approval.credentialId === null) return;
  const credential = await db.restaurantOperatorCredential.findFirst({
    where: {
      id: approval.credentialId,
      organizationId: scope.organizationId,
      type: 'PIN',
      revokedAt: null,
      deviceId: null,
      staffProfile: { status: 'ACTIVE', userId: approval.approvedByUserId },
    },
    select: { id: true },
  });
  if (!credential) throw new CounterApprovalDenied(kind);
}

/**
 * A constant bcrypt hash at the real cost factor. Ineligible or unknown staff profiles burn a
 * compare against it so their timing matches a wrong PIN on an eligible profile.
 */
let dummyCredentialHash: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummyCredentialHash ??= bcryptHash('counter-approval-dummy', OPERATOR_CREDENTIAL_BCRYPT_COST);
  return dummyCredentialHash;
}

async function refuseAfterDummyCompare(pin: string): Promise<null> {
  await verifyOperatorCredential('PIN', pin, await dummyHash());
  return null;
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
    return refuseAfterDummyCompare(input.pin);
  }
  const selfApproved = approver.id === scope.actorId;
  if (selfApproved && !(await isSoleApprover(db, scope, capability, now)))
    return refuseAfterDummyCompare(input.pin);
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
  const approvalPolicy = selfApproved
    ? 'SOLE_APPROVER_PIN_REAUTH'
    : kind === 'DISCOUNT'
      ? 'MANAGER_PIN'
      : 'PHARMACIST_PIN';
  return {
    approvedByUserId: approver.id,
    approvalPolicy,
    selfApproved,
    credentialId: credential.id,
  };
}

/**
 * True when nobody else could approve: approval needs an active member with an active staff
 * profile and a live counter PIN, so only those members are checked for the capability.
 */
async function isSoleApprover(db: ScopedDb, scope: LedgerScope, capability: Action, now: Date) {
  const credentials = await db.restaurantOperatorCredential.findMany({
    where: {
      organizationId: scope.organizationId,
      type: 'PIN',
      revokedAt: null,
      deviceId: null,
      staffProfile: {
        status: 'ACTIVE',
        user: {
          organizationId: scope.organizationId,
          status: 'ACTIVE',
          id: { not: scope.actorId },
        },
      },
    },
    include: { staffProfile: { include: { user: true } } },
  });
  const checked = new Set<string>();
  for (const credential of credentials) {
    const other = credential.staffProfile.user;
    if (!other || other.id === scope.actorId || checked.has(other.id)) continue;
    checked.add(other.id);
    if (await can(other, capability, undefined, { db, now })) return false;
  }
  return true;
}
