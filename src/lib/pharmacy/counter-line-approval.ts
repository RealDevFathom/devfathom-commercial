import { can } from '@/lib/abac';
import type { Action } from '@/lib/abac/policies';
import type { PharmacyApproverRight } from '@/lib/approval-approver-rights';
import type { Environment, Subject } from '@/lib/abac/types';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';
import { hash as bcryptHash } from 'bcryptjs';
import {
  clearLockout,
  isLockedOut,
  OPERATOR_CREDENTIAL_BCRYPT_COST,
  LOCKOUT_DURATION_MS,
  MAX_FAILED_ATTEMPTS,
  registerFailedAttempt,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';
import { rateLimit, refundRateLimit } from '@/lib/rate-limit';
import { counterBranchAssignmentDenial } from './counter-capability';
import { CounterApprovalChoice } from './counter-approval-choice';
import { verifyToken } from './counter-terminal-session';
import { pharmacyDeviceSecretExpired } from './device-secret-expiry';
import {
  spendApproverPinGuessTypedByAnother,
  refundApproverPinGuessTypedByAnother,
} from '@/lib/approver-pin-guess-budget';
import {
  approvalSecretKindFor,
  matchingApprovalStep,
  verifyApprovalSecret,
} from '@/lib/approval-authenticator';
import { COUNTER_DISCOUNT_APPROVAL_REQUIRED } from './counter-messages';

/** A supervisor's staff profile and PIN, entered at the counter for this one line. */
export type CounterApprovalPin = { staffProfileId: string; pin: string };
type CounterSession = { deviceId: string; sessionToken: string };
export type CounterApprovalInput =
  | CounterApprovalPin
  | {
      staffProfileId?: string;
      pin: string;
      counter: CounterSession;
    };

export type CounterApprovalKind =
  'DISCOUNT' | 'FEFO_OVERRIDE' | 'KHATA_OVER_LIMIT' | 'SCANNED_PACK_FEFO' | 'TENDER_DISCARD';

/** Server-derived approval evidence persisted on the sale line / allocation override. */
export type CounterApproval = {
  approvedByUserId: string;
  approvalPolicy: string;
  selfApproved: boolean;
  /** The PIN credential that proved the approval; null for the pharmacist on duty. */
  credentialId: string | null;
  /** Branch admission was part of a verified till approval and must still hold at use. */
  approvalBranchId?: string;
};

/**
 * #520: discount and FEFO-override approvals were caller-supplied text. The approver is now
 * resolved here from a credential the server verifies; callers never name the approver.
 *
 * - DISCOUNT needs a different active member holding `pharmacy:manage`, proven by their PIN.
 *   Solo rule: when nobody else active in the organization holds that capability, the actor
 *   may approve their own discount by re-entering their own PIN (recorded as self-approved).
 *   DEV-66: an actor the owner granted `pharmacy:discount` gives it without a PIN.
 * - FEFO_OVERRIDE is a pharmacist's decision: an actor holding `pharmacy:dispense` approves it
 *   as the pharmacist on duty; anyone else needs an active pharmacist's PIN.
 * - KHATA_OVER_LIMIT (DEV-290): charging a family Khata past its credit limit is approved at
 *   the cashier's till by a manager or owner (`pharmacy:manage`) with their own PIN, under the
 *   same different-person and solo rules as a discount.
 * - SCANNED_PACK_FEFO (DEV-843): selling a scanned serialized pack that is not from the
 *   earliest-expiry lot needs a manager or owner (`pharmacy:manage`) PIN. There is no
 *   on-duty default; the same different-person and solo rules as a discount apply.
 * - TENDER_DISCARD (DEV-712): discarding a counter payment attempt whose outcome is unknown
 *   is a manager's or owner's decision (`pharmacy:manage`), under the same rules.
 */
// DEV-961: each kind's capability is an approver right of the shared approval path, so the
// forced authenticator set-up asks everyone who can approve a counter line.
export const COUNTER_APPROVAL_CAPABILITY: Record<
  CounterApprovalKind,
  Extract<PharmacyApproverRight, Action>
> = {
  DISCOUNT: 'pharmacy:manage',
  FEFO_OVERRIDE: 'pharmacy:dispense',
  KHATA_OVER_LIMIT: 'pharmacy:manage',
  SCANNED_PACK_FEFO: 'pharmacy:manage',
  TENDER_DISCARD: 'pharmacy:manage',
};

/**
 * DEV-806: the one approver check every approval route shares: the till PIN route, the
 * signed-in password re-authentication route, the in-transaction re-check, the approver list
 * and both sole-approver (second-person) rules. Whether `subject` may approve `kind`: only a
 * live grant of the kind's capability counts, so an explicit DENY always wins and the tenant
 * ADMIN role on its own (`admin:access`) is not an approver.
 */
export async function mayApproveCounterLine(
  db: ScopedDb,
  subject: Subject,
  kind: CounterApprovalKind,
  options: { now?: Date; source?: Environment['source'] } = {}
): Promise<boolean> {
  return can(subject, COUNTER_APPROVAL_CAPABILITY[kind], undefined, {
    db,
    now: options.now,
    source: options.source,
  });
}

/**
 * DEV-66: the approval policy recorded when the operator holds `pharmacy:discount`, the
 * right the owner grants by name to a role so it may give discounts (up to the owner's
 * maximum, above the minimum margin) without a manager's PIN. Nobody holds it by default.
 */
export const DISCOUNT_RIGHT_APPROVAL_POLICY = 'DISCOUNT_RIGHT';

/** DEV-66: whether `subject` may give a discount without a manager's approval. */
export async function mayDiscountWithoutApproval(
  db: ScopedDb,
  subject: Subject,
  options: { now?: Date; source?: Environment['source'] } = {}
): Promise<boolean> {
  return can(subject, 'pharmacy:discount', undefined, {
    db,
    now: options.now,
    source: options.source,
  });
}

const DENIED_MESSAGE: Record<CounterApprovalKind, string> = {
  DISCOUNT: COUNTER_DISCOUNT_APPROVAL_REQUIRED,
  FEFO_OVERRIDE: 'A non-FEFO batch needs a pharmacist to approve it with their PIN.',
  KHATA_OVER_LIMIT:
    'Charging over the Khata credit limit needs a manager or owner to approve it with their PIN.',
  SCANNED_PACK_FEFO:
    'A scanned pack that is not from the earliest-expiry batch needs a manager or owner to approve it with their PIN.',
  TENDER_DISCARD:
    'Discarding a payment attempt needs a manager or owner to approve it with their PIN.',
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
  constructor(readonly kind: CounterApprovalKind, message = DENIED_MESSAGE[kind]) {
    super(message);
  }
}

export function counterProofRequired(kind: CounterApprovalKind) {
  return new CounterApprovalDenied(kind, 'This till could not verify its enrollment. Choose the approver by name to continue.');
}

type ActiveUser = Subject & { organizationId: string | null };

async function verifiedCounterId(db: ScopedDb, scope: LedgerScope, counter: CounterSession) {
  const device = await db.pharmacyRegisteredDevice.findFirst({
    where: {
      id: counter.deviceId,
      kind: 'PHARMACY_COUNTER',
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'ACTIVE',
      revokedAt: null,
    },
    select: { id: true, deviceSecretHash: true, secretExpiresAt: true },
  });
  if (!device || pharmacyDeviceSecretExpired(device, new Date()))
    return null;
  try {
    verifyToken(counter.sessionToken, {
      scope,
      deviceId: device.id,
      credentialHash: device.deviceSecretHash,
    });
  } catch {
    return null;
  }
  return device.id;
}

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
  input?: CounterApprovalInput
): Promise<CounterApproval> {
  const actor = (await db.user.findFirst({
    where: { id: scope.actorId, organizationId: scope.organizationId, status: 'ACTIVE' },
  })) as ActiveUser | null;
  if (!actor) throw new CounterApprovalDenied(kind);
  if (kind === 'FEFO_OVERRIDE' && (await mayApproveCounterLine(db, actor, kind))) {
    return {
      approvedByUserId: actor.id,
      approvalPolicy: 'PHARMACIST_ON_DUTY',
      selfApproved: false,
      credentialId: null,
    };
  }
  // DEV-66: a discount without a manager's PIN only when the owner granted this operator's
  // role (or this operator) the discount right. A PIN, when given, is always verified.
  if (kind === 'DISCOUNT' && !input && (await mayDiscountWithoutApproval(db, actor))) {
    return {
      approvedByUserId: actor.id,
      approvalPolicy: DISCOUNT_RIGHT_APPROVAL_POLICY,
      selfApproved: false,
      credentialId: null,
    };
  }
  if (!input) throw new CounterApprovalDenied(kind);
  // Reserve before looking up the profile. Changing the chosen name, branch or action
  // cannot buy the signed-in requester more guesses. An accepted approval refunds only
  // its own reservation so concurrent failures keep counting.
  const requesterKey = JSON.stringify([
    'pharmacy-approval-requester',
    scope.organizationId,
    scope.actorId,
  ]);
  const attempt = await rateLimit(requesterKey, MAX_FAILED_ATTEMPTS, LOCKOUT_DURATION_MS);
  if (!attempt.ok || !attempt.windowStartedAt) throw new CounterApprovalDenied(kind);
  const deviceId = 'counter' in input ? await verifiedCounterId(db, scope, input.counter) : null;
  // Named approvals also work when a browser sends a stale terminal session. Only
  // a verified session may charge a physical till or identify an unnamed approver.
  if (!input.staffProfileId && !deviceId) throw counterProofRequired(kind);
  let counterReservation: { key: string; window: Date } | undefined;
  if (deviceId) {
    const key = JSON.stringify(['pharmacy-approval-counter', scope.organizationId, deviceId]);
    const reservation = await rateLimit(key, MAX_FAILED_ATTEMPTS, LOCKOUT_DURATION_MS);
    if (!reservation.ok || !reservation.windowStartedAt) throw new CounterApprovalDenied(kind);
    counterReservation = { key, window: reservation.windowStartedAt };
  }
  const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
  const approval = await withTenantDb(
    scope.organizationId,
    async (credentialDb) =>
      input.staffProfileId
        ? verifyApproverPin(
            credentialDb,
            scope,
            kind,
            { staffProfileId: input.staffProfileId, pin: input.pin },
            deviceId ? 'named-at-counter' : 'named'
          )
        : identifyCounterApprover(credentialDb, scope, kind, input.pin),
    { userId: scope.actorId, skipDrain: true }
  );
  // Throw only after the credential transaction has committed any failed attempt.
  if (!approval) throw new CounterApprovalDenied(kind);
  if (approval instanceof CounterApprovalChoice) throw approval;
  await refundRateLimit(requesterKey, LOCKOUT_DURATION_MS, attempt.windowStartedAt);
  if (counterReservation)
    await refundRateLimit(counterReservation.key, LOCKOUT_DURATION_MS, counterReservation.window);
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
  if (approval.approvalPolicy === DISCOUNT_RIGHT_APPROVAL_POLICY) {
    // DEV-66: the discount right is the operator's own, still held at the sale, never a PIN.
    if (
      kind !== 'DISCOUNT' ||
      approval.credentialId !== null ||
      approval.approvedByUserId !== scope.actorId ||
      !approver ||
      !(await mayDiscountWithoutApproval(db, approver))
    )
      throw new CounterApprovalDenied(kind);
    return;
  }
  if (!approver || !(await mayApproveCounterLine(db, approver, kind))) {
    throw new CounterApprovalDenied(kind);
  }
  if (
    approval.approvalBranchId !== undefined &&
    (approval.approvalBranchId !== scope.branchId ||
      (await counterBranchAssignmentDenial(db, approver, scope.organizationId, scope.branchId)))
  )
    throw new CounterApprovalDenied(kind);
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
  input: CounterApprovalPin,
  method: 'named' | 'named-at-counter' | { matchedUserId: string } = 'named'
): Promise<CounterApproval | null> {
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
    !(await mayApproveCounterLine(db, approver, kind, { now }))
  ) {
    return refuseAfterDummyCompare(input.pin);
  }
  if (typeof method === 'object' && method.matchedUserId !== approver.id) return null;
  if (
    method !== 'named' &&
    (await counterBranchAssignmentDenial(db, approver, scope.organizationId, scope.branchId))
  )
    return null;
  const selfApproved = approver.id === scope.actorId;
  if (selfApproved && !(await isSoleApprover(db, scope, kind, now)))
    return refuseAfterDummyCompare(input.pin);
  // A named entry and an unidentified code spend the same per-person guess budget. The
  // comparison in identifyCounterApprover already reserved it for each eligible person.
  const namedBudget =
    typeof method === 'string' && !selfApproved
      ? await spendApproverPinGuessTypedByAnother(scope.organizationId, approver.id)
      : undefined;
  if (namedBudget && !namedBudget.ok) return null;
  if (
    !(await verifyApprovalSecret(db, {
      organizationId: scope.organizationId,
      approverUserId: approver.id,
      authenticatorOnly: typeof method === 'object',
      credentialHash: credential.credentialHash,
      secret: input.pin,
      action: `pharmacy.counterApproval.${kind}`,
      approverRight: COUNTER_APPROVAL_CAPABILITY[kind],
      requestedById: scope.actorId,
      now,
    }))
  ) {
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
  if (namedBudget?.windowStartedAt)
    await refundApproverPinGuessTypedByAnother(
      scope.organizationId,
      approver.id,
      namedBudget.windowStartedAt
    );
  const approvalPolicy = selfApproved
    ? 'SOLE_APPROVER_PIN_REAUTH'
    : kind === 'FEFO_OVERRIDE'
      ? 'PHARMACIST_PIN'
      : 'MANAGER_PIN';
  return {
    approvedByUserId: approver.id,
    approvalPolicy,
    selfApproved,
    credentialId: credential.id,
    ...(method !== 'named' ? { approvalBranchId: scope.branchId } : {}),
  };
}

/**
 * Identify only inside the credential transaction, then use the normal locked verifier to
 * recheck authority, consume the step and audit exactly one person. Comparing candidates
 * does not consume a code or write a credential strike in somebody else's name.
 */
async function identifyCounterApprover(
  db: ScopedDb,
  scope: LedgerScope,
  kind: CounterApprovalKind,
  pin: string
) {
  if (!/^\d{6}$/.test(pin) || (await approvalSecretKindFor(db, scope.organizationId)) !== 'CODE')
    return null;
  const now = new Date();
  const credentials = await db.restaurantOperatorCredential.findMany({
    where: {
      organizationId: scope.organizationId,
      type: 'PIN',
      revokedAt: null,
      deviceId: null,
      staffProfile: {
        organizationId: scope.organizationId,
        status: 'ACTIVE',
        user: {
          organizationId: scope.organizationId,
          status: 'ACTIVE',
          OR: [
            { role: 'ADMIN' },
            {
              pharmacyBranchAssignments: {
                some: {
                  organizationId: scope.organizationId,
                  branchId: scope.branchId,
                  active: true,
                  branch: { organizationId: scope.organizationId, active: true },
                },
              },
            },
          ],
        },
      },
    },
    select: {
      staffProfileId: true,
      failedAttempts: true,
      lockedUntil: true,
      staffProfile: {
        select: {
          user: {
            select: { id: true, organizationId: true, status: true, role: true, department: true },
          },
        },
      },
    },
    orderBy: { id: 'asc' },
  });
  const eligible = new Map<string, string>();
  for (const credential of credentials) {
    const person = credential.staffProfile.user;
    if (!person || eligible.has(person.id) || isLockedOut(credential, now)) continue;
    if (!(await mayApproveCounterLine(db, person, kind, { now }))) continue;
    if (person.id === scope.actorId && !(await isSoleApprover(db, scope, kind, now))) continue;
    eligible.set(person.id, credential.staffProfileId);
  }
  if (!eligible.size) return null;
  const authenticators = await db.approvalAuthenticator.findMany({
    where: {
      organizationId: scope.organizationId,
      userId: { in: [...eligible.keys()] },
      enabledAt: { not: null },
    },
    select: { userId: true, encryptedSecret: true, lastUsedStep: true },
    orderBy: { userId: 'asc' },
  });
  const reservations = new Map<string, Date>();
  const releaseReservations = async () => {
    for (const [id, window] of reservations)
      await refundApproverPinGuessTypedByAnother(scope.organizationId, id, window);
  };
  for (const { userId } of authenticators) {
    const budget = await spendApproverPinGuessTypedByAnother(scope.organizationId, userId);
    if (!budget.ok || !budget.windowStartedAt) {
      await releaseReservations();
      return null;
    }
    reservations.set(userId, budget.windowStartedAt);
  }
  const matches: Array<{ userId: string; staffProfileId: string }> = [];
  let used = false;
  for (const auth of authenticators) {
    const step = matchingApprovalStep(auth.encryptedSecret, pin, now);
    if (step === null) continue;
    if (auth.lastUsedStep !== null && step <= auth.lastUsedStep) used = true;
    matches.push({ userId: auth.userId, staffProfileId: eligible.get(auth.userId)! });
  }
  if (used || matches.length === 0) return null;
  if (matches.length > 1)
    return new CounterApprovalChoice(matches.map((match) => match.staffProfileId));
  const [match] = matches;
  const result = await verifyApproverPin(
    db,
    scope,
    kind,
    { staffProfileId: match!.staffProfileId, pin },
    { matchedUserId: match!.userId }
  );
  if (result) await releaseReservations();
  return result;
}

/**
 * DEV-290: the staff profiles the counter may offer as approvers for `kind`: other active
 * members with an active staff profile and a live counter PIN who hold the capability. When
 * nobody else qualifies (solo rule), the actor's own eligible profiles are offered so they can
 * self-approve by re-entering their PIN. `verifyApproverPin` re-checks every rule on use.
 */
export async function listCounterApprovers(
  db: ScopedDb,
  scope: LedgerScope,
  kind: CounterApprovalKind
): Promise<Array<{ id: string; name: string; self: boolean }>> {
  const now = new Date();
  const profiles = await db.restaurantStaffProfile.findMany({
    where: {
      organizationId: scope.organizationId,
      status: 'ACTIVE',
      user: { organizationId: scope.organizationId, status: 'ACTIVE' },
      credentials: { some: { type: 'PIN', revokedAt: null, deviceId: null } },
    },
    select: { id: true, displayName: true, user: true },
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
  });
  const eligible: Array<{ id: string; name: string; self: boolean }> = [];
  const capable = new Map<string, boolean>();
  for (const profile of profiles) {
    const user = profile.user as ActiveUser | null;
    if (!user || user.organizationId !== scope.organizationId || user.status !== 'ACTIVE') continue;
    if (!capable.has(user.id))
      capable.set(user.id, await mayApproveCounterLine(db, user, kind, { now }));
    if (capable.get(user.id))
      eligible.push({ id: profile.id, name: profile.displayName, self: user.id === scope.actorId });
  }
  const others = eligible.filter((profile) => !profile.self);
  return others.length ? others : eligible;
}

/**
 * DEV-290: true when the actor is genuinely the only active member of the organization who
 * holds the approval capability for `kind`, whether or not anyone else has a counter PIN.
 * Approval routes that do not take a second person's PIN (the signed-in approver's fresh
 * password re-authentication) allow self-approval only in this case.
 */
export async function isSoleActiveApprover(
  db: ScopedDb,
  scope: LedgerScope,
  kind: CounterApprovalKind,
  now = new Date()
): Promise<boolean> {
  const others = (await db.user.findMany({
    where: { organizationId: scope.organizationId, status: 'ACTIVE', id: { not: scope.actorId } },
  })) as ActiveUser[];
  for (const other of others) {
    if (other.id === scope.actorId || other.organizationId !== scope.organizationId) continue;
    if (await mayApproveCounterLine(db, other, kind, { now })) return false;
  }
  return true;
}

/**
 * True when nobody else could approve: approval needs an active member with an active staff
 * profile and a live counter PIN, so only those members are checked for the capability.
 */
async function isSoleApprover(
  db: ScopedDb,
  scope: LedgerScope,
  kind: CounterApprovalKind,
  now: Date
) {
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
    if (await mayApproveCounterLine(db, other, kind, { now })) return false;
  }
  return true;
}
