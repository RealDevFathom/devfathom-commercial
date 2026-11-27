import { isPharmacyFinanceAction } from '@/lib/abac/pharmacy-finance-actions';
/**
 * DEV-959B — the one guard every change to a pharmacy member's access goes through.
 *
 * Ticking a sub-role, starting someone from a ready-made role, the member edit forms, adding
 * and inviting a member, laying someone off, the assistant's team tools, SCIM provisioning and
 * the platform console's member and exception commands all run their write inside
 * `guardPharmacyAccessChange`. The guard locks the organization row (serialising concurrent
 * edits and the owner count), decides every sub-role of the person before and after the write
 * with `can()`, refuses anything the rules below forbid (the caller's transaction then rolls the
 * write back), and records the change in the same transaction.
 *
 * Rules (owner's decision, 19 Nov 2026):
 *  - Who edits: the owner (the live all-capability identity who can administer the workspace),
 *    or a member with administrator access. Nobody changes their own access here. An
 *    administrator who is not the owner edits only members below them: never the owner, a
 *    workspace administrator, or anyone holding administrator access through an exception.
 *  - The owner may give any sub-role, including ones the Owner role does not hold.
 *  - An administrator who is not the owner changes only sub-roles that carry no extra weight
 *    and that they can use themselves, never makes anyone an administrator or an owner.
 *  - Weighty sub-roles are changed (given or taken away) only by the owner, with the owner's
 *    own fresh approval (`pinVerified`, checked by the caller through the shared verifier).
 *  - Ticking never ends an owner's owner access; at least one active owner always remains.
 *  - A path with no member behind it (SCIM, the platform console) may only take access away:
 *    it never gives a weighty sub-role, never makes an administrator or an owner, and never
 *    leaves the organization without an owner.
 */
import 'server-only';

import { TRPCError } from '@trpc/server';
import { can, type Action } from '@/lib/abac';
import { hasAllCapabilityAccess } from '@/lib/abac/owner-access';
import {
  PHARMACY_SUB_ROLES,
  PHARMACY_SUB_ROLE_ACTIONS,
  pharmacySubRoleStates,
  type PharmacySubRoleState,
} from '@/lib/abac/pharmacy-sub-roles';
import { isWeightyPharmacySubRole } from '@/lib/abac/pharmacy-sub-role-weight';
import { approvalAuthenticatorPartySelect } from '@/lib/approval-authenticator';
import type { AuthzDb } from '@/lib/authz';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { ACTIVE_STATUSES } from '@/lib/auth/session-state';

export type AccessParty = {
  id: string;
  name: string;
  role: string;
  status: string;
  department: string | null;
  organizationRoleId: string | null;
  organizationRole: {
    key: string;
    isSystem: boolean;
    permissions: { capability: string; effect: string }[];
  } | null;
  permissionOverrides: { capability: string; effect: string }[];
};

function partySelect(now: Date) {
  return {
    ...approvalAuthenticatorPartySelect(now),
    name: true,
    department: true,
    organizationRoleId: true,
  } as const;
}

export async function loadAccessParty(
  db: ScopedDb,
  organizationId: string,
  userId: string,
  now: Date
): Promise<AccessParty | null> {
  return (await db.user.findFirst({
    where: { id: userId, organizationId },
    select: partySelect(now),
  })) as AccessParty | null;
}

function subjectOf(party: AccessParty) {
  return { id: party.id, role: party.role, department: party.department, status: party.status };
}

export async function partyHolds(
  db: ScopedDb,
  party: AccessParty,
  action: Action,
  now: Date
): Promise<boolean> {
  return can(subjectOf(party), action, undefined, {
    ownerOnlyFallback: isPharmacyFinanceAction(action),
    db: db as unknown as AuthzDb,
    now,
    source: 'TRPC',
  });
}

/** Every sub-role's state for a person, each action decided by `can()` (deny wins). */
export async function accessStates(
  db: ScopedDb,
  party: AccessParty,
  now: Date
): Promise<Map<string, PharmacySubRoleState>> {
  const allowed = new Set<Action>();
  // Sequential: one interactive transaction.
  for (const action of PHARMACY_SUB_ROLE_ACTIONS)
    if (await partyHolds(db, party, action, now)) allowed.add(action);
  return pharmacySubRoleStates(allowed);
}

/** The owner: the live all-capability identity, active, who can administer the workspace. */
export async function isAccessOwner(db: ScopedDb, party: AccessParty, now: Date) {
  return hasAllCapabilityAccess(party) && (await partyHolds(db, party, 'admin:access', now));
}

async function activeOwnerCount(db: ScopedDb, organizationId: string, now: Date) {
  const candidates = (await db.user.findMany({
    where: {
      organizationId,
      status: 'ACTIVE',
      OR: [{ role: 'ADMIN' }, { organizationRole: { key: 'owner', isSystem: true } }],
    },
    select: partySelect(now),
  })) as AccessParty[];
  let owners = 0;
  for (const party of candidates) if (await isAccessOwner(db, party, now)) owners += 1;
  return owners;
}

/** Who is making the change: a signed-in member, or a path with no member behind it. */
export type AccessActor =
  | { kind: 'member'; id: string; supportSession: boolean }
  | { kind: 'system'; source: 'SCIM' | 'SSO' | 'PLATFORM' | 'RESIGNATION' };

export type AccessEditor = { id: string; status: string; owner: boolean; admin: boolean };
export type AccessTarget = { id: string; owner: boolean; admin: boolean };

/** Whether a member may change this person's access at all; a refusal, or null. */
export function accessEditRefusal(
  editor: AccessEditor,
  target: AccessTarget | null,
  supportSession: boolean
): string | null {
  if (supportSession) return 'A support session cannot change what a person may do.';
  if (editor.status !== 'ACTIVE' || !(editor.owner || editor.admin))
    return 'Only the owner or an administrator can change what a person may do.';
  if (target && editor.id === target.id)
    return 'Nobody changes their own access. Another owner can change yours.';
  if (editor.owner || !target) return null;
  if (target.owner || target.admin) return 'Only the owner can change what this person may do.';
  return null;
}

export type AccessChangeCheck = {
  editor:
    { kind: 'owner' } | { kind: 'administrator'; holds: ReadonlySet<string> } | { kind: 'system' };
  before: ReadonlyMap<string, PharmacySubRoleState>;
  after: ReadonlyMap<string, PharmacySubRoleState>;
  ownerBefore: boolean;
  ownerAfter: boolean;
  adminBefore: boolean;
  adminAfter: boolean;
  ownersBefore: number;
  ownersAfter: number;
  pinVerified: boolean;
  /** `tick` changes one sub-role; `role` changes a role, a status or a new member. */
  mode: 'tick' | 'role';
};

export type AccessChangeRefusal = {
  code: 'FORBIDDEN' | 'PIN_REQUIRED' | 'LAST_OWNER' | 'OWNER_ACCESS';
  message: string;
};

const labelOf = (key: string) =>
  PHARMACY_SUB_ROLES.find((subRole) => subRole.key === key)?.label ?? key;

/** The sub-role keys whose state differs between two decisions. */
export function changedSubRoles(
  before: ReadonlyMap<string, PharmacySubRoleState>,
  after: ReadonlyMap<string, PharmacySubRoleState>
): string[] {
  return PHARMACY_SUB_ROLES.map((subRole) => subRole.key).filter(
    (key) => (before.get(key) ?? 'off') !== (after.get(key) ?? 'off')
  );
}

/** The rules every change must pass, on the decided before and after; a refusal, or null. */
export function accessChangeRefusal(
  check: AccessChangeCheck,
  approvalSecret: 'approval code' | 'PIN' = 'approval code'
): AccessChangeRefusal | null {
  const changed = changedSubRoles(check.before, check.after);
  const given = changed.filter((key) => check.after.get(key) !== 'off');
  const weighty = changed.filter(isWeightyPharmacySubRole);
  const madeAdmin = check.adminAfter && !check.adminBefore;
  const madeOwner = check.ownerAfter && !check.ownerBefore;
  const { editor } = check;

  if (editor.kind === 'administrator') {
    for (const key of changed) {
      if (isWeightyPharmacySubRole(key))
        return {
          code: 'FORBIDDEN',
          message: `Only the owner can change ${labelOf(key)}: it carries extra weight.`,
        };
      if (!editor.holds.has(key))
        return {
          code: 'FORBIDDEN',
          message: `You can only change what you can do yourself, and you cannot ${labelOf(key).toLowerCase()}.`,
        };
    }
    if (madeOwner)
      return { code: 'FORBIDDEN', message: 'Only the owner can make someone an owner.' };
    if (madeAdmin)
      return { code: 'FORBIDDEN', message: 'Only the owner can make someone an administrator.' };
  }
  if (editor.kind === 'system') {
    const weightyGiven = given.find(isWeightyPharmacySubRole);
    if (weightyGiven)
      return {
        code: 'FORBIDDEN',
        message: `${labelOf(weightyGiven)} carries extra weight: only the owner can give it, on the team screen.`,
      };
    if (madeOwner || madeAdmin)
      return {
        code: 'FORBIDDEN',
        message:
          'Only the owner can make someone an owner or an administrator, on the team screen.',
      };
  }
  if (check.ownerBefore && !check.ownerAfter && check.mode === 'tick')
    return {
      code: 'OWNER_ACCESS',
      message:
        'This person is an owner. Unticking would end their owner access; choose a different ready-made role for them instead.',
    };
  if (check.ownersAfter < 1 && check.ownersBefore >= 1)
    return { code: 'LAST_OWNER', message: 'At least one active owner must remain.' };
  if (editor.kind === 'owner' && weighty.length > 0 && !check.pinVerified)
    return {
      code: 'PIN_REQUIRED',
      message: `Enter your ${approvalSecret} to change ${weighty.map(labelOf).join(', ')}. It carries extra weight.`,
    };
  return null;
}

export class AccessChangeError extends Error {
  constructor(readonly refusal: AccessChangeRefusal) {
    super(refusal.message);
  }
}

/** The refusal as the error a tRPC caller (or the assistant) reports. */
export function accessChangeTrpcError(error: AccessChangeError): TRPCError {
  const { code, message } = error.refusal;
  return new TRPCError({
    code:
      code === 'PIN_REQUIRED'
        ? 'PRECONDITION_FAILED'
        : code === 'FORBIDDEN'
          ? 'FORBIDDEN'
          : 'BAD_REQUEST',
    message,
    cause: error,
  });
}

export type AccessChangeResult = {
  changed: string[];
  before: Record<string, PharmacySubRoleState>;
  after: Record<string, PharmacySubRoleState>;
};

export type AccessGuardInput = {
  organizationId: string;
  actor: AccessActor;
  /**
   * The person whose access changes; null when the write creates them. A function that finds
   * them runs only once the organisation lock is held.
   */
  targetId: string | null | (() => Promise<string | null>);
  pinVerified: boolean;
  mode: 'tick' | 'role';
  /** The audit row's action, e.g. `organizationAdmin.updateMember`. */
  action: string;
  describe: (targetName: string) => string;
  metadata?: Record<string, unknown>;
  /**
   * Record the owner's fresh approval of the person's weighty sub-roles even when nothing
   * changes (a re-sent invitation), so accepting it later can rely on that approval.
   */
  recordApproval?: boolean;
  /**
   * The write issues an invitation again (a re-send): everything the person would get is
   * checked as given now, so a re-send never carries an earlier approval forward.
   */
  reissue?: boolean;
  /**
   * The write is an invitee accepting: the audit row names the invitee as the actor, records
   * that no PIN was entered, and the owner approval the acceptance relied on.
   */
  acceptance?: {
    invitee: { id: string; name: string; role: string };
    ownerApprovalAuditId: string | null;
  };
  now?: Date;
};

export type AccessGuardContext = {
  /** The member making the change, when there is one, loaded live. */
  actor: AccessParty | null;
  target: AccessParty | null;
  before: ReadonlyMap<string, PharmacySubRoleState>;
};

/**
 * Runs `write` inside the caller's transaction and checks what it did to the person's access.
 * `write` returns the person's id (for a new person) and its own result. A refusal throws
 * `AccessChangeError` (or a `TRPCError` for an editor who may not edit at all); the caller's
 * transaction then rolls the write back. A write that changes nothing about the person's
 * access (a title, or the status of someone who is neither owner nor administrator) passes
 * without checks.
 */
export async function guardPharmacyAccessChange<T>(
  tx: ScopedDb,
  input: AccessGuardInput,
  write: (context: AccessGuardContext) => Promise<{ targetId: string; value: T }>
): Promise<{ value: T; result: AccessChangeResult }> {
  let newTargetId = '';
  const find = input.targetId;
  const { value, results } = await guardPharmacyAccessChanges(
    tx,
    {
      ...input,
      targetIds:
        typeof find === 'function'
          ? async () => {
              const found = await find();
              return found ? [found] : null;
            }
          : find
            ? [find]
            : null,
    },
    async (contexts) => {
      const written = await write(contexts[0]);
      newTargetId = written.targetId;
      return { targetIds: [written.targetId], value: written.value };
    }
  );
  return { value, result: results.get(newTargetId)! };
}

type Snapshot = {
  party: AccessParty | null;
  states: Map<string, PharmacySubRoleState>;
  owner: boolean;
  admin: boolean;
};

async function snapshot(
  tx: ScopedDb,
  organizationId: string,
  targetId: string | null,
  now: Date
): Promise<Snapshot> {
  const party = targetId ? await loadAccessParty(tx, organizationId, targetId, now) : null;
  if (targetId && !party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found.' });
  if (!party)
    return {
      party: null,
      states: new Map(PHARMACY_SUB_ROLES.map((subRole) => [subRole.key, 'off' as const])),
      owner: false,
      admin: false,
    };
  return {
    party,
    states: await accessStates(tx, party, now),
    owner: await isAccessOwner(tx, party, now),
    admin: await partyHolds(tx, party, 'admin:access', now),
  };
}

/**
 * The same guard for a write that changes several people at once (a custom role edited for
 * everyone who holds it, a SCIM group's members). `targetIds` null means the write creates
 * one new person. Every person changed passes every rule, or nothing is written.
 */
export async function guardPharmacyAccessChanges<T>(
  tx: ScopedDb,
  input: Omit<AccessGuardInput, 'targetId'> & {
    /**
     * The people the write can change, or a function that lists them. A function runs only
     * after the organisation lock is held, so nobody can join the list (a custom role's
     * holders, a group's members) between listing and writing: list people that way.
     */
    targetIds: string[] | null | (() => Promise<string[] | null>);
  },
  write: (contexts: AccessGuardContext[]) => Promise<{ targetIds: string[]; value: T }>
): Promise<{ value: T; results: Map<string, AccessChangeResult> }> {
  const now = input.now ?? new Date();
  const [organization] = await tx.$queryRaw<Array<{ requireApprovalAuthenticator: boolean }>>`
    SELECT "requireApprovalAuthenticator" FROM "organizations" WHERE "id" = ${input.organizationId} FOR UPDATE
  `;
  const approvalSecret =
    organization?.requireApprovalAuthenticator === false ? 'PIN' : 'approval code';
  const targetIdsInput =
    typeof input.targetIds === 'function' ? await input.targetIds() : input.targetIds;
  const actor =
    input.actor.kind === 'member'
      ? await loadAccessParty(tx, input.organizationId, input.actor.id, now)
      : null;
  if (input.actor.kind === 'member' && !actor)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'No active tenant actor.' });
  const befores = new Map<string, Snapshot>();
  const creating = targetIdsInput === null;
  for (const id of targetIdsInput ?? [])
    befores.set(id, await snapshot(tx, input.organizationId, id, now));
  const ownersBefore = await activeOwnerCount(tx, input.organizationId, now);
  const contexts: AccessGuardContext[] = creating
    ? [
        {
          actor,
          target: null,
          before: (await snapshot(tx, input.organizationId, null, now)).states,
        },
      ]
    : [...befores.values()].map((before) => ({
        actor,
        target: before.party,
        before: before.states,
      }));

  const { targetIds, value } = await write(contexts);

  let editor: AccessChangeCheck['editor'] | null = null;
  const editorFor = async () => {
    if (editor) return editor;
    if (input.actor.kind !== 'member' || !actor) return (editor = { kind: 'system' });
    if (await isAccessOwner(tx, actor, now)) return (editor = { kind: 'owner' });
    const actorStates = await accessStates(tx, actor, now);
    return (editor = {
      kind: 'administrator',
      holds: new Set([...actorStates].filter(([, state]) => state === 'on').map(([key]) => key)),
    });
  };
  const ownersAfter = await activeOwnerCount(tx, input.organizationId, now);
  const results = new Map<string, AccessChangeResult>();
  for (const targetId of targetIds) {
    const before = befores.get(targetId) ?? (await snapshot(tx, input.organizationId, null, now));
    const after = await snapshot(tx, input.organizationId, targetId, now);
    const targetBefore = before.party;
    const targetAfter = after.party!;
    const changed = changedSubRoles(before.states, after.states);
    const roleChanged =
      !targetBefore ||
      targetBefore.role !== targetAfter.role ||
      targetBefore.organizationRoleId !== targetAfter.organizationRoleId;
    const statusChanged = !!targetBefore && targetBefore.status !== targetAfter.status;
    // Bringing someone back (deactivated, laid off or invited, to active) gives them their
    // weighty sub-roles, administrator access and ownership again: check it as giving them.
    const reactivated =
      !!targetBefore &&
      !ACTIVE_STATUSES.has(targetBefore.status) &&
      ACTIVE_STATUSES.has(targetAfter.status);
    // Moving someone back to invited leads to active again on acceptance: the same rule.
    const madePending =
      !!targetBefore && targetBefore.status !== 'INVITED' && targetAfter.status === 'INVITED';
    const regains = reactivated || madePending;
    const reissued = input.reissue === true && !!targetBefore;
    const weightyOn = PHARMACY_SUB_ROLES.map((subRole) => subRole.key).filter(
      (key) => isWeightyPharmacySubRole(key) && after.states.get(key) !== 'off'
    );
    const checkBefore = reissued
      ? new Map([...before.states].map(([key]) => [key, 'off' as const]))
      : regains
        ? new Map(
            [...before.states].map(([key, state]) => [
              key,
              isWeightyPharmacySubRole(key) ? ('off' as const) : state,
            ])
          )
        : before.states;
    const givenAgain = regains || reissued;
    const editorKind = input.recordApproval ? (await editorFor()).kind : null;
    const approving = input.recordApproval === true && input.pinVerified && editorKind === 'owner';
    const relevant =
      changed.length > 0 ||
      roleChanged ||
      before.owner !== after.owner ||
      before.admin !== after.admin ||
      (statusChanged && (before.owner || before.admin)) ||
      (regains && (weightyOn.length > 0 || after.admin || after.owner)) ||
      reissued ||
      approving;
    results.set(targetId, {
      changed,
      before: Object.fromEntries(before.states),
      after: Object.fromEntries(after.states),
    });
    if (!relevant) continue;

    if (input.actor.kind === 'member' && actor) {
      const refusal = accessEditRefusal(
        {
          id: actor.id,
          status: actor.status,
          owner: (await editorFor()).kind === 'owner',
          admin: await partyHolds(tx, actor, 'admin:access', now),
        },
        targetBefore ? { id: targetBefore.id, owner: before.owner, admin: before.admin } : null,
        input.actor.supportSession
      );
      if (refusal) throw new TRPCError({ code: 'FORBIDDEN', message: refusal });
    }
    const refusal = accessChangeRefusal(
      {
        editor: await editorFor(),
        before: checkBefore,
        after: after.states,
        ownerBefore: givenAgain ? false : before.owner,
        ownerAfter: after.owner,
        adminBefore: givenAgain ? false : before.admin,
        adminAfter: after.admin,
        ownersBefore,
        ownersAfter,
        pinVerified: input.pinVerified,
        mode: input.mode,
      },
      approvalSecret
    );
    if (refusal) throw new AccessChangeError(refusal);

    const pick = (states: ReadonlyMap<string, PharmacySubRoleState>) =>
      Object.fromEntries(changed.map((key) => [key, states.get(key) ?? 'off']));
    await tx.auditLog.create({
      data: {
        organizationId: input.organizationId,
        actorType: input.actor.kind === 'member' || input.acceptance ? 'USER' : 'SYSTEM',
        // An acceptance is done by the invitee, never by the owner whose approval it used.
        actorId: input.acceptance?.invitee.id ?? actor?.id ?? null,
        actorName:
          input.acceptance?.invitee.name ??
          actor?.name ??
          (input.actor.kind === 'system' ? input.actor.source : null),
        actorRole: input.acceptance?.invitee.role ?? actor?.role ?? null,
        source:
          input.actor.kind === 'member'
            ? 'TRPC'
            : input.actor.source === 'SCIM'
              ? 'REST_API'
              : input.actor.source === 'SSO'
                ? 'AUTH'
                : 'SYSTEM',
        category: 'TEAM',
        operation: targetBefore ? 'UPDATE' : 'CREATE',
        action: input.action,
        description: input.describe(targetAfter.name),
        targetType: 'User',
        targetId: targetAfter.id,
        targetLabel: targetAfter.name,
        changes: {
          subRoles: { before: pick(before.states), after: pick(after.states) },
          ...(roleChanged
            ? {
                role: { before: targetBefore?.role ?? null, after: targetAfter.role },
                organizationRole: {
                  before: targetBefore?.organizationRole?.key ?? null,
                  after: targetAfter.organizationRole?.key ?? null,
                },
              }
            : {}),
          ...(statusChanged
            ? { status: { before: targetBefore?.status ?? null, after: targetAfter.status } }
            : {}),
        },
        metadata: {
          ...input.metadata,
          changedSubRoles: changed,
          ...(reactivated ? { reactivatedWeighty: weightyOn } : {}),
          ...(madePending ? { madePendingWeighty: weightyOn } : {}),
          ...(reissued ? { reissued: true } : {}),
          ...(input.acceptance
            ? {
                acceptedBy: input.acceptance.invitee.id,
                checkedAs: actor?.id ?? null,
                ownerApprovalAuditId: input.acceptance.ownerApprovalAuditId,
              }
            : {}),
          ...(approving ? { approvedSubRoles: weightyOn } : {}),
          owner: { before: before.owner, after: after.owner },
          administrator: { before: before.admin, after: after.admin },
          // Nobody enters a PIN when accepting an invitation.
          pinVerified: input.acceptance ? false : input.pinVerified,
          changedAt: now.toISOString(),
        },
      },
    });
  }
  return { value, results };
}

/** The organization's vertical, read live, for paths that have no tRPC entitlements. */
export async function isPharmacyOrganization(db: ScopedDb, organizationId: string) {
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { vertical: true },
  });
  return organization?.vertical === 'PHARMACY';
}

/** What an invitee sees when their invitation can no longer be accepted as it stands. */
export const INVITATION_NEEDS_OWNER_MESSAGE =
  'This invitation needs to be confirmed again. Ask the pharmacy owner to send you a new invitation.';

/**
 * The audit actions that issue (or re-send) an invitation with the issuer's own approval.
 * DEV-974: an email change made by someone else sends the member back to invited and issues
 * their invitation again, to the new address (`team.adminUpdateMember`); its audit row names
 * that issue with `INVITATION_ISSUED_AT_KEY` exactly as an invite does.
 */
export const INVITATION_ISSUE_ACTIONS = ['team.inviteMember', 'team.adminUpdateMember'] as const;

/**
 * The metadata key an invitation's issue records, set to the invitation row's `updatedAt`
 * after the write. Every re-send changes `updatedAt`, so an approval names exactly one issue.
 */
export const INVITATION_ISSUED_AT_KEY = 'invitationIssuedAt';

/**
 * DEV-959B: accepting an invitation into a pharmacy is checked again, as if the inviter were
 * adding the person now, so an invitation made before these rules shipped, or by someone who
 * has since lost the right, cannot be accepted. Weighty sub-roles also need the owner's own
 * approval of THIS issue of the invitation: the audit row the issue wrote, by the inviter, a
 * current owner who entered their PIN and approved each weighty sub-role. Approvals of earlier
 * issues, and acceptances, never count. Refusals throw `AccessChangeError` with
 * `INVITATION_NEEDS_OWNER_MESSAGE`, and the caller's transaction rolls the acceptance back.
 */
export async function guardPharmacyInvitationAcceptance<T>(
  tx: ScopedDb,
  input: {
    organizationId: string;
    userId: string;
    invitedById: string | null;
    /** The invitation row's `updatedAt`: when this issue (first send or latest re-send) was made. */
    issuedAt: Date;
    now?: Date;
  },
  write: () => Promise<T>
): Promise<T> {
  const now = input.now ?? new Date();
  const refuse = () =>
    new AccessChangeError({ code: 'FORBIDDEN', message: INVITATION_NEEDS_OWNER_MESSAGE });
  await tx.$queryRaw`SELECT "id" FROM "organizations" WHERE "id" = ${input.organizationId} FOR UPDATE`;
  const invitee = await loadAccessParty(tx, input.organizationId, input.userId, now);
  if (!invitee) throw refuse();
  const states = await accessStates(tx, invitee, now);
  const weighty = [...states]
    .filter(([key, state]) => state !== 'off' && isWeightyPharmacySubRole(key))
    .map(([key]) => key);

  const actorId = input.invitedById;
  let pinVerified = false;
  let ownerApprovalAuditId: string | null = null;
  if (weighty.length > 0) {
    if (!actorId) throw refuse();
    const approval = await tx.auditLog.findFirst({
      where: {
        organizationId: input.organizationId,
        targetId: input.userId,
        category: 'TEAM',
        action: { in: [...INVITATION_ISSUE_ACTIONS] },
        actorId,
        metadata: { path: [INVITATION_ISSUED_AT_KEY], equals: input.issuedAt.toISOString() },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, metadata: true },
    });
    const metadata = (approval?.metadata ?? {}) as Record<string, unknown>;
    const approved = new Set(
      Array.isArray(metadata.approvedSubRoles)
        ? (metadata.approvedSubRoles as unknown[]).filter(
            (key): key is string => typeof key === 'string'
          )
        : []
    );
    const issuer = await loadAccessParty(tx, input.organizationId, actorId, now);
    if (
      !approval ||
      metadata.pinVerified !== true ||
      weighty.some((key) => !approved.has(key)) ||
      !issuer ||
      !(await isAccessOwner(tx, issuer, now))
    )
      throw refuse();
    pinVerified = true;
    ownerApprovalAuditId = approval.id;
  }
  if (!actorId) throw refuse();
  try {
    const { value } = await guardPharmacyAccessChanges(
      tx,
      {
        organizationId: input.organizationId,
        actor: { kind: 'member', id: actorId, supportSession: false },
        // Checked as a new member: everything the invitation gives is given now.
        targetIds: null,
        pinVerified,
        mode: 'role',
        action: 'invitations.accept',
        describe: (name) => `${name} accepted their invitation`,
        acceptance: {
          invitee: { id: invitee.id, name: invitee.name, role: invitee.role },
          ownerApprovalAuditId,
        },
        now,
      },
      async () => ({ targetIds: [input.userId], value: await write() })
    );
    return value;
  } catch (error) {
    // The inviter may no longer edit anyone (left, deactivated, lost administrator access).
    if (
      error instanceof AccessChangeError ||
      (error instanceof TRPCError && error.code === 'FORBIDDEN')
    )
      throw refuse();
    throw error;
  }
}
