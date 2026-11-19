/**
 * DEV-959B — ticking a pharmacy member's sub-roles, for one person.
 *
 * Storage: a tick is a per-person exception (`user_permission_overrides`, one row per exact
 * action) on top of the person's ready-made or custom role, the same rows `can()` already
 * reads on every request. A row is written only where the ticked state differs from what the
 * role gives; where the role already gives it, no row is kept, so a later change to the
 * ready-made role still reaches the person. The screen's ticks are then read back through
 * `can()`, so the screen and the server decide from the same data.
 *
 * Every change runs in one tenant transaction that locks the organization row (serialising
 * concurrent edits and the owner count), decides every sub-role before and after with
 * `can()`, refuses anything the rules below forbid (rolling the write back), and writes its
 * audit row in that same transaction:
 *
 *  - only the owner, or a member with administrator access, edits; nobody edits themselves,
 *    and an administrator who is not the owner edits only members below them;
 *  - nobody gives a sub-role they cannot use themselves; an administrator who is not the owner
 *    takes away only what they can use;
 *  - deny wins: a refusal in the role or another exception is never overridden;
 *  - ticking cannot end an owner's owner access, and at least one active owner always remains;
 *  - giving a weighty sub-role needs the editor's fresh PIN, checked before the transaction
 *    by the shared approval path (`verifyOwnerExportPin` -> `verifyApprovalSecret`, with its
 *    lockout strikes).
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
import {
  isWeightyPharmacySubRole,
  PHARMACY_WEIGHTY_SUB_ROLES,
} from '@/lib/abac/pharmacy-sub-role-weight';
import { approvalAuthenticatorPartySelect } from '@/lib/approval-authenticator';
import type { AuthzDb } from '@/lib/authz';
import { verifyOwnerExportPin } from '@/lib/pharmacy/owner-data-export-pin';
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** The approval action recorded with the editor's PIN check. */
export const SUB_ROLE_PIN_ACTION = 'organizationAdmin.setMemberSubRole';

type Party = {
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
  const base = approvalAuthenticatorPartySelect(now);
  return { ...base, name: true, department: true, organizationRoleId: true } as const;
}

async function loadParty(
  db: ScopedDb,
  organizationId: string,
  userId: string,
  now: Date
): Promise<Party | null> {
  return (await db.user.findFirst({
    where: { id: userId, organizationId },
    select: partySelect(now),
  })) as Party | null;
}

function subjectOf(party: Party) {
  return {
    id: party.id,
    role: party.role,
    department: party.department,
    status: party.status,
  };
}

/** Every sub-role's state for a person, each action decided by `can()` (deny wins). */
async function subRoleStates(
  db: ScopedDb,
  party: Party,
  now: Date
): Promise<Map<string, PharmacySubRoleState>> {
  const allowed = new Set<Action>();
  // Sequential: one interactive transaction.
  for (const action of PHARMACY_SUB_ROLE_ACTIONS) {
    if (
      await can(subjectOf(party), action, undefined, {
        db: db as unknown as AuthzDb,
        now,
        source: 'TRPC',
      })
    )
      allowed.add(action);
  }
  return pharmacySubRoleStates(allowed);
}

async function holds(db: ScopedDb, party: Party, action: Action, now: Date): Promise<boolean> {
  return can(subjectOf(party), action, undefined, {
    db: db as unknown as AuthzDb,
    now,
    source: 'TRPC',
  });
}

/** The live all-capability owners of the organization (`hasAllCapabilityAccess`). */
async function activeOwnerIds(db: ScopedDb, organizationId: string, now: Date) {
  const candidates = (await db.user.findMany({
    where: {
      organizationId,
      status: 'ACTIVE',
      OR: [{ role: 'ADMIN' }, { organizationRole: { key: 'owner', isSystem: true } }],
    },
    select: partySelect(now),
  })) as Party[];
  return candidates.filter((party) => hasAllCapabilityAccess(party)).map((party) => party.id);
}

export type SubRoleEditor = {
  id: string;
  status: string;
  /** The live all-capability owner. */
  owner: boolean;
  /** `can(actor, 'admin:access')`. */
  admin: boolean;
};

export type SubRoleEditTarget = { id: string; role: string; owner: boolean };

/** Whether `actor` may change `target`'s ticks at all; a refusal, or null. */
export function subRoleEditRefusal(
  actor: SubRoleEditor,
  target: SubRoleEditTarget,
  supportSession: boolean
): string | null {
  if (supportSession) return 'A support session cannot change what a person may do.';
  if (actor.status !== 'ACTIVE' || !(actor.owner || actor.admin))
    return 'Only the owner or an administrator can change what a person may do.';
  if (actor.id === target.id)
    return 'Nobody changes their own sub-roles. Another owner can change yours.';
  if (actor.owner) return null;
  if (target.owner || target.role === 'ADMIN')
    return 'Only the owner can change what this person may do.';
  return null;
}

export type SubRoleChangeCheck = {
  actorOwner: boolean;
  /** Sub-role keys the editor can use themselves, decided by `can()`. */
  actorHolds: ReadonlySet<string>;
  before: ReadonlyMap<string, PharmacySubRoleState>;
  after: ReadonlyMap<string, PharmacySubRoleState>;
  targetOwnerBefore: boolean;
  targetOwnerAfter: boolean;
  ownersAfter: number;
  pinVerified: boolean;
  /** `tick` changes one sub-role; `role` starts the person from a ready-made role. */
  mode: 'tick' | 'role';
};

export type SubRoleChangeRefusal = {
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
export function subRoleChangeRefusal(check: SubRoleChangeCheck): SubRoleChangeRefusal | null {
  const changed = changedSubRoles(check.before, check.after);
  const given = changed.filter((key) => check.after.get(key) !== 'off');
  for (const key of changed) {
    const giving = given.includes(key);
    if ((giving || !check.actorOwner) && !check.actorHolds.has(key))
      return {
        code: 'FORBIDDEN',
        message: giving
          ? `You can only give what you can do yourself, and you cannot ${labelOf(key).toLowerCase()}.`
          : `You can only take away what you can do yourself, and you cannot ${labelOf(key).toLowerCase()}.`,
      };
  }
  if (check.targetOwnerBefore && !check.targetOwnerAfter && check.mode === 'tick')
    return {
      code: 'OWNER_ACCESS',
      message:
        'This person is an owner. Unticking would end their owner access; choose a different ready-made role for them instead.',
    };
  if (!check.targetOwnerBefore && check.targetOwnerAfter && !check.actorOwner)
    return { code: 'FORBIDDEN', message: 'Only the owner can make someone an owner.' };
  if (check.ownersAfter < 1)
    return { code: 'LAST_OWNER', message: 'At least one active owner must remain.' };
  if (given.some(isWeightyPharmacySubRole) && !check.pinVerified)
    return {
      code: 'PIN_REQUIRED',
      message: 'Enter your PIN to give this. It carries extra weight.',
    };
  return null;
}

export type SubRoleChangeResult = {
  changed: string[];
  before: Record<string, PharmacySubRoleState>;
  after: Record<string, PharmacySubRoleState>;
};

class SubRoleChangeError extends Error {
  constructor(readonly refusal: SubRoleChangeRefusal) {
    super(refusal.message);
  }
}

function asTrpcError(error: unknown): never {
  if (error instanceof SubRoleChangeError) {
    const { code, message } = error.refusal;
    throw new TRPCError({
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
  throw error;
}

type EditInput = {
  organizationId: string;
  actorId: string;
  targetId: string;
  supportSession: boolean;
  /** The editor's PIN, when they are giving a weighty sub-role. */
  pin?: string | null;
  now?: Date;
};

/** The PIN check on the shared approval path, in its own transaction so strikes commit. */
async function verifyEditorPin(input: EditInput): Promise<boolean> {
  if (!input.pin) return false;
  const result = await verifyOwnerExportPin(
    {
      organizationId: input.organizationId,
      userId: input.actorId,
      pin: input.pin,
      action: SUB_ROLE_PIN_ACTION,
    },
    input.now
  );
  if (result === 'NO_PIN')
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Set your own PIN under Your PIN first.',
    });
  if (result === 'LOCKED')
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'Your PIN is locked after too many wrong tries. Try again later.',
    });
  if (result !== 'OK')
    throw new TRPCError({ code: 'FORBIDDEN', message: 'That PIN is not right.' });
  return true;
}

type Loaded = {
  actor: Party;
  target: Party;
  actorOwner: boolean;
  targetOwnerBefore: boolean;
  before: Map<string, PharmacySubRoleState>;
};

/** Locks, loads and authorizes inside the write transaction, against the live rows. */
async function begin(tx: ScopedDb, input: EditInput, now: Date): Promise<Loaded> {
  await tx.$queryRaw`SELECT "id" FROM "organizations" WHERE "id" = ${input.organizationId} FOR UPDATE`;
  const [actor, target] = await Promise.all([
    loadParty(tx, input.organizationId, input.actorId, now),
    loadParty(tx, input.organizationId, input.targetId, now),
  ]);
  if (!actor) throw new TRPCError({ code: 'FORBIDDEN', message: 'No active tenant actor.' });
  if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found.' });
  const actorOwner = hasAllCapabilityAccess(actor);
  const targetOwnerBefore = hasAllCapabilityAccess(target);
  const refusal = subRoleEditRefusal(
    {
      id: actor.id,
      status: actor.status,
      owner: actorOwner,
      admin: await holds(tx, actor, 'admin:access', now),
    },
    { id: target.id, role: target.role, owner: targetOwnerBefore },
    input.supportSession
  );
  if (refusal) throw new TRPCError({ code: 'FORBIDDEN', message: refusal });
  return {
    actor,
    target,
    actorOwner,
    targetOwnerBefore,
    before: await subRoleStates(tx, target, now),
  };
}

async function finish(
  tx: ScopedDb,
  input: EditInput,
  loaded: Loaded,
  pinVerified: boolean,
  mode: 'tick' | 'role',
  now: Date
): Promise<{ after: Map<string, PharmacySubRoleState>; changed: string[] }> {
  const target = await loadParty(tx, input.organizationId, input.targetId, now);
  if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found.' });
  const after = await subRoleStates(tx, target, now);
  const changed = changedSubRoles(loaded.before, after);
  const actorStates = await subRoleStates(tx, loaded.actor, now);
  const refusal = subRoleChangeRefusal({
    actorOwner: loaded.actorOwner,
    actorHolds: new Set([...actorStates].filter(([, state]) => state === 'on').map(([key]) => key)),
    before: loaded.before,
    after,
    targetOwnerBefore: loaded.targetOwnerBefore,
    targetOwnerAfter: hasAllCapabilityAccess(target),
    ownersAfter: (await activeOwnerIds(tx, input.organizationId, now)).length,
    pinVerified,
    mode,
  });
  if (refusal) throw new SubRoleChangeError(refusal);
  return { after, changed };
}

async function writeAudit(
  tx: ScopedDb,
  input: EditInput,
  loaded: Loaded,
  detail: {
    action: string;
    description: string;
    after: Map<string, PharmacySubRoleState>;
    changed: string[];
    pinVerified: boolean;
    metadata: Record<string, unknown>;
  },
  now: Date
) {
  const pick = (states: Map<string, PharmacySubRoleState>) =>
    Object.fromEntries(detail.changed.map((key) => [key, states.get(key) ?? 'off']));
  await tx.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorId: loaded.actor.id,
      actorName: loaded.actor.name,
      actorRole: loaded.actor.role,
      source: 'TRPC',
      category: 'TEAM',
      operation: 'UPDATE',
      action: detail.action,
      description: detail.description,
      targetType: 'User',
      targetId: loaded.target.id,
      targetLabel: loaded.target.name,
      changes: { subRoles: { before: pick(loaded.before), after: pick(detail.after) } },
      metadata: {
        ...detail.metadata,
        changedSubRoles: detail.changed,
        pinVerified: detail.pinVerified,
        changedAt: now.toISOString(),
      },
    },
  });
}

function result(
  loaded: Loaded,
  after: Map<string, PharmacySubRoleState>,
  changed: string[]
): SubRoleChangeResult {
  return {
    changed,
    before: Object.fromEntries(loaded.before),
    after: Object.fromEntries(after),
  };
}

/**
 * Tick (`ticked: true`) or untick one sub-role for one person. Idempotent: asking for the
 * state the person already has changes and records nothing.
 */
export async function setPharmacyMemberSubRole(
  db: ScopedDb,
  input: EditInput & { subRoleKey: string; ticked: boolean }
): Promise<SubRoleChangeResult> {
  const now = input.now ?? new Date();
  const subRole = PHARMACY_SUB_ROLES.find((candidate) => candidate.key === input.subRoleKey);
  if (!subRole || subRole.actions.length !== 1)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown sub-role.' });
  const action = subRole.actions[0];
  const pinVerified = input.ticked ? await verifyEditorPin(input) : false;
  try {
    return await db.$transaction(async (transaction) => {
      const tx = transaction as unknown as ScopedDb;
      const loaded = await begin(tx, input, now);
      const wanted: PharmacySubRoleState = input.ticked ? 'on' : 'off';
      if (loaded.before.get(subRole.key) === wanted) return result(loaded, loaded.before, []);

      const key = { userId_capability: { userId: loaded.target.id, capability: action } };
      const existing = await tx.userPermissionOverride.findUnique({ where: key });
      if (existing) await tx.userPermissionOverride.delete({ where: { id: existing.id } });
      // Keep a personal exception only where the role alone does not already give the tick.
      let exception: { effect: 'ALLOW' | 'DENY' } | null = null;
      if ((await holds(tx, loaded.target, action, now)) !== input.ticked) {
        exception = { effect: input.ticked ? 'ALLOW' : 'DENY' };
        await tx.userPermissionOverride.create({
          data: {
            organizationId: input.organizationId,
            userId: loaded.target.id,
            capability: action,
            effect: exception.effect,
            reason: input.ticked ? 'Ticked on the team screen' : 'Unticked on the team screen',
            createdById: loaded.actor.id,
          },
        });
      }
      // Deny wins: a refusal in the role or another exception is never overridden.
      if ((await holds(tx, loaded.target, action, now)) !== input.ticked)
        throw new SubRoleChangeError({
          code: 'FORBIDDEN',
          message: `Their role or another personal exception refuses ${subRole.label.toLowerCase()}, and a refusal always wins.`,
        });

      const { after, changed } = await finish(tx, input, loaded, pinVerified, 'tick', now);
      await writeAudit(
        tx,
        input,
        loaded,
        {
          action: 'organizationAdmin.setMemberSubRole',
          description: `${input.ticked ? 'Ticked' : 'Unticked'} ${subRole.label} for ${loaded.target.name}`,
          after,
          changed,
          pinVerified,
          metadata: {
            subRole: subRole.key,
            ticked: input.ticked,
            exceptionBefore: existing
              ? { effect: existing.effect, expiresAt: existing.expiresAt?.toISOString() ?? null }
              : null,
            exceptionAfter: exception,
          },
        },
        now
      );
      return result(loaded, after, changed);
    });
  } catch (error) {
    asTrpcError(error);
  }
}

/** The ready-made pharmacy roles a person can be started from. */
export const PHARMACY_STARTING_ROLE_KEYS: readonly string[] = PHARMACY_ROLE_TEMPLATES.map(
  (template) => template.key
);

/**
 * Start a person from a ready-made role: give them the role and clear their personal
 * exceptions on sub-role actions, so exactly that role's sub-roles are ticked. Other
 * exceptions (anything outside the sub-roles) are kept.
 */
export async function applyPharmacyMemberRoleTemplate(
  db: ScopedDb,
  input: EditInput & { roleKey: string }
): Promise<SubRoleChangeResult> {
  const now = input.now ?? new Date();
  if (!PHARMACY_STARTING_ROLE_KEYS.includes(input.roleKey))
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown ready-made role.' });
  const pinVerified = await verifyEditorPin(input);
  try {
    return await db.$transaction(async (transaction) => {
      const tx = transaction as unknown as ScopedDb;
      const loaded = await begin(tx, input, now);
      const role = await tx.organizationRole.findFirst({
        where: { organizationId: input.organizationId, key: input.roleKey, isSystem: true },
        select: { id: true, name: true },
      });
      if (!role)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This ready-made role is not set up.',
        });
      const cleared = await tx.userPermissionOverride.findMany({
        where: {
          organizationId: input.organizationId,
          userId: loaded.target.id,
          capability: { in: [...PHARMACY_SUB_ROLE_ACTIONS] },
        },
        select: { id: true, capability: true, effect: true, expiresAt: true },
      });
      if (cleared.length > 0)
        await tx.userPermissionOverride.deleteMany({
          where: { id: { in: cleared.map((row) => row.id) } },
        });
      if (loaded.target.organizationRoleId !== role.id)
        await tx.user.update({
          where: { id: loaded.target.id },
          data: { organizationRoleId: role.id },
          select: { id: true },
        });
      if (cleared.length === 0 && loaded.target.organizationRoleId === role.id)
        return result(loaded, loaded.before, []);

      const { after, changed } = await finish(tx, input, loaded, pinVerified, 'role', now);
      await writeAudit(
        tx,
        input,
        loaded,
        {
          action: 'organizationAdmin.applyMemberRoleTemplate',
          description: `Started ${loaded.target.name} from the ${role.name} role`,
          after,
          changed,
          pinVerified,
          metadata: {
            roleKey: input.roleKey,
            roleBefore: loaded.target.organizationRole?.key ?? null,
            exceptionsCleared: cleared.map((row) => ({
              capability: row.capability,
              effect: row.effect,
              expiresAt: row.expiresAt?.toISOString() ?? null,
            })),
          },
        },
        now
      );
      return result(loaded, after, changed);
    });
  } catch (error) {
    asTrpcError(error);
  }
}

export type PharmacyMemberTicking = {
  /** Whether the viewer may change this person's ticks, and why not. */
  editing: { allowed: boolean; reason: string | null };
  viewerIsOwner: boolean;
  /** Sub-role keys the viewer can use themselves (and so may give). */
  viewerHolds: string[];
  /** The person's own exception on a sub-role, where they have one (live rows only). */
  personal: Record<string, 'ALLOW' | 'DENY'>;
  /** The ready-made role the person holds, or null for a custom role or none. */
  roleKey: string | null;
  startingRoles: { key: string; name: string }[];
  /** The one line shown before a weighty sub-role is given. */
  weighty: Record<string, string>;
};

/** What the viewer may change for a person, for the screen; the server re-checks on write. */
export async function readPharmacyMemberTicking(
  db: ScopedDb,
  input: { organizationId: string; actorId: string; targetId: string; supportSession: boolean },
  now: Date = new Date()
): Promise<PharmacyMemberTicking> {
  const actor = await loadParty(db, input.organizationId, input.actorId, now);
  const target = await loadParty(db, input.organizationId, input.targetId, now);
  if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found.' });
  const viewerIsOwner = actor ? hasAllCapabilityAccess(actor) : false;
  const reason = actor
    ? subRoleEditRefusal(
        {
          id: actor.id,
          status: actor.status,
          owner: viewerIsOwner,
          admin: await holds(db, actor, 'admin:access', now),
        },
        { id: target.id, role: target.role, owner: hasAllCapabilityAccess(target) },
        input.supportSession
      )
    : 'Only the owner or an administrator can change what a person may do.';
  const viewerStates = actor ? await subRoleStates(db, actor, now) : new Map();
  const personal: Record<string, 'ALLOW' | 'DENY'> = {};
  for (const subRole of PHARMACY_SUB_ROLES) {
    const row = (target.permissionOverrides ?? []).find(
      (rule) => rule.capability === subRole.actions[0]
    );
    if (row) personal[subRole.key] = row.effect === 'DENY' ? 'DENY' : 'ALLOW';
  }
  const role = target.organizationRole;
  return {
    editing: { allowed: reason === null, reason },
    viewerIsOwner,
    viewerHolds: [...viewerStates].filter(([, state]) => state === 'on').map(([key]) => key),
    personal,
    roleKey:
      role?.isSystem && role.key && PHARMACY_STARTING_ROLE_KEYS.includes(role.key)
        ? role.key
        : null,
    startingRoles: PHARMACY_ROLE_TEMPLATES.map((template) => ({
      key: template.key,
      name: template.name,
    })),
    weighty: { ...PHARMACY_WEIGHTY_SUB_ROLES },
  };
}
