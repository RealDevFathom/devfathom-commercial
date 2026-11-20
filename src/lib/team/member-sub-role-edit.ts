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
 * Every change, here and on every other path that changes a pharmacy member's role or access,
 * runs through `guardPharmacyAccessChange` (`pharmacy-access-guard.ts`), which holds the rules.
 */
import 'server-only';

import { TRPCError } from '@trpc/server';
import {
  PHARMACY_SUB_ROLES,
  PHARMACY_SUB_ROLE_ACTIONS,
  pharmacyActionsAllowedByRules,
  pharmacySubRoleStates,
} from '@/lib/abac/pharmacy-sub-roles';
import {
  PHARMACY_WEIGHTY_SUB_ROLES,
  isWeightyPharmacySubRole,
} from '@/lib/abac/pharmacy-sub-role-weight';
import { verifyOwnerExportPin } from '@/lib/pharmacy/owner-data-export-pin';
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  AccessChangeError,
  accessChangeTrpcError,
  accessEditRefusal,
  accessStates,
  guardPharmacyAccessChange,
  isAccessOwner,
  loadAccessParty,
  partyHolds,
  type AccessChangeResult,
} from './pharmacy-access-guard';

/** The approval action recorded with the editor's PIN check. */
export const SUB_ROLE_PIN_ACTION = 'organizationAdmin.setMemberSubRole';

export type SubRoleChangeResult = AccessChangeResult;

/**
 * The editor's PIN on the shared approval path (`verifyOwnerExportPin` ->
 * `verifyApprovalSecret`), in its own transaction so a wrong-PIN strike commits even though
 * the change is then refused. Returns false when no PIN was given.
 */
/** The refusal a support session gets on any member-access change. */
export const SUPPORT_SESSION_ACCESS_REFUSAL =
  'A support session cannot change what a person may do.';

/**
 * A support session is refused before any PIN is checked, so it can never strike, and so
 * lock, the approval PIN of the member it is acting as.
 */
export function refuseSupportSessionPin(input: { supportSession: boolean }): void {
  if (input.supportSession)
    throw new TRPCError({ code: 'FORBIDDEN', message: SUPPORT_SESSION_ACCESS_REFUSAL });
}

export async function verifyAccessPin(input: {
  organizationId: string;
  actorId: string;
  pin?: string | null;
  action?: string;
  now?: Date;
}): Promise<boolean> {
  if (!input.pin) return false;
  const result = await verifyOwnerExportPin(
    {
      organizationId: input.organizationId,
      userId: input.actorId,
      pin: input.pin,
      action: input.action ?? SUB_ROLE_PIN_ACTION,
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

/** Turns a guard refusal into the tRPC error the screen shows; other errors pass through. */
export function rethrowAccessChange(error: unknown): never {
  if (error instanceof AccessChangeError) throw accessChangeTrpcError(error);
  throw error;
}

type EditInput = {
  organizationId: string;
  actorId: string;
  targetId: string;
  supportSession: boolean;
  /** The editor's PIN, when the change touches a weighty sub-role. */
  pin?: string | null;
  now?: Date;
};

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
  refuseSupportSessionPin(input);
  const pinVerified = await verifyAccessPin({ ...input, now });
  try {
    return await db.$transaction(async (transaction) => {
      const tx = transaction as unknown as ScopedDb;
      let exceptionBefore: { effect: string; expiresAt: string | null } | null = null;
      let exceptionAfter: { effect: 'ALLOW' | 'DENY' } | null = null;
      const { result } = await guardPharmacyAccessChange(
        tx,
        {
          organizationId: input.organizationId,
          actor: { kind: 'member', id: input.actorId, supportSession: input.supportSession },
          targetId: input.targetId,
          pinVerified,
          mode: 'tick',
          action: 'organizationAdmin.setMemberSubRole',
          describe: (name) =>
            `${input.ticked ? 'Ticked' : 'Unticked'} ${subRole.label} for ${name}`,
          metadata: {
            subRole: subRole.key,
            ticked: input.ticked,
            get exceptionBefore() {
              return exceptionBefore;
            },
            get exceptionAfter() {
              return exceptionAfter;
            },
          },
          now,
        },
        async ({ target, before }) => {
          const person = target!;
          if (before.get(subRole.key) === (input.ticked ? 'on' : 'off'))
            return { targetId: person.id, value: null };
          const key = { userId_capability: { userId: person.id, capability: action } };
          const existing = await tx.userPermissionOverride.findUnique({ where: key });
          if (existing) {
            exceptionBefore = {
              effect: existing.effect,
              expiresAt: existing.expiresAt?.toISOString() ?? null,
            };
            await tx.userPermissionOverride.delete({ where: { id: existing.id } });
          }
          // Keep a personal exception only where the role alone does not already give it.
          if ((await partyHolds(tx, person, action, now)) !== input.ticked) {
            exceptionAfter = { effect: input.ticked ? 'ALLOW' : 'DENY' };
            await tx.userPermissionOverride.create({
              data: {
                organizationId: input.organizationId,
                userId: person.id,
                capability: action,
                effect: exceptionAfter.effect,
                reason: input.ticked ? 'Ticked on the team screen' : 'Unticked on the team screen',
                createdById: input.actorId,
              },
            });
          }
          // Deny wins: a refusal in the role or another exception is never overridden.
          if ((await partyHolds(tx, person, action, now)) !== input.ticked)
            throw new AccessChangeError({
              code: 'FORBIDDEN',
              message: `Their role or another personal exception refuses ${subRole.label.toLowerCase()}, and a refusal always wins.`,
            });
          return { targetId: person.id, value: null };
        }
      );
      return result;
    });
  } catch (error) {
    rethrowAccessChange(error);
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
  refuseSupportSessionPin(input);
  const pinVerified = await verifyAccessPin({ ...input, now });
  try {
    return await db.$transaction(async (transaction) => {
      const tx = transaction as unknown as ScopedDb;
      const role = await tx.organizationRole.findFirst({
        where: { organizationId: input.organizationId, key: input.roleKey, isSystem: true },
        select: { id: true, name: true },
      });
      if (!role)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This ready-made role is not set up.',
        });
      let cleared: { capability: string; effect: string; expiresAt: string | null }[] = [];
      let roleBefore: string | null = null;
      const { result } = await guardPharmacyAccessChange(
        tx,
        {
          organizationId: input.organizationId,
          actor: { kind: 'member', id: input.actorId, supportSession: input.supportSession },
          targetId: input.targetId,
          pinVerified,
          mode: 'role',
          action: 'organizationAdmin.applyMemberRoleTemplate',
          describe: (name) => `Started ${name} from the ${role.name} role`,
          metadata: {
            roleKey: input.roleKey,
            get roleBefore() {
              return roleBefore;
            },
            get exceptionsCleared() {
              return cleared;
            },
          },
          now,
        },
        async ({ target }) => {
          const person = target!;
          roleBefore = person.organizationRole?.key ?? null;
          // The Owner role is ownership only for a workspace administrator: without
          // admin:access the new owner could not administer the workspace at all.
          if (input.roleKey === 'owner' && person.role !== 'ADMIN')
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message:
                'Make this person a workspace administrator before giving them the Owner role.',
            });
          const rows = await tx.userPermissionOverride.findMany({
            where: {
              organizationId: input.organizationId,
              userId: person.id,
              capability: { in: [...PHARMACY_SUB_ROLE_ACTIONS] },
            },
            select: { id: true, capability: true, effect: true, expiresAt: true },
          });
          cleared = rows.map((row) => ({
            capability: row.capability,
            effect: row.effect,
            expiresAt: row.expiresAt?.toISOString() ?? null,
          }));
          if (rows.length > 0)
            await tx.userPermissionOverride.deleteMany({
              where: { id: { in: rows.map((row) => row.id) } },
            });
          if (person.organizationRoleId !== role.id)
            await tx.user.update({
              where: { id: person.id },
              data: { organizationRoleId: role.id },
              select: { id: true },
            });
          return { targetId: person.id, value: null };
        }
      );
      return result;
    });
  } catch (error) {
    rethrowAccessChange(error);
  }
}

export type PharmacyMemberTicking = {
  /** Whether the viewer may change this person's ticks, and why not. */
  editing: { allowed: boolean; reason: string | null };
  /** The owner may change every box; an administrator only non-weighty ones they hold. */
  viewerIsOwner: boolean;
  /** Sub-role keys the viewer can use themselves. */
  viewerHolds: string[];
  /** The person's own exception on a sub-role, where they have one (live rows only). */
  personal: Record<string, 'ALLOW' | 'DENY'>;
  /** The ready-made role the person holds, or null for a custom role or none. */
  roleKey: string | null;
  /** The organization's ready-made roles, each with the weighty sub-roles it gives. */
  startingRoles: { key: string; name: string; weighty: string[] }[];
  /** The one line shown before a weighty sub-role is changed. */
  weighty: Record<string, string>;
};

/** What the viewer may change for a person, for the screen; the server re-checks on write. */
export async function readPharmacyMemberTicking(
  db: ScopedDb,
  input: { organizationId: string; actorId: string; targetId: string; supportSession: boolean },
  now: Date = new Date()
): Promise<PharmacyMemberTicking> {
  const actor = await loadAccessParty(db, input.organizationId, input.actorId, now);
  const target = await loadAccessParty(db, input.organizationId, input.targetId, now);
  if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found.' });
  const viewerIsOwner = actor ? await isAccessOwner(db, actor, now) : false;
  const reason = actor
    ? accessEditRefusal(
        {
          id: actor.id,
          status: actor.status,
          owner: viewerIsOwner,
          admin: await partyHolds(db, actor, 'admin:access', now),
        },
        {
          id: target.id,
          owner: await isAccessOwner(db, target, now),
          admin: await partyHolds(db, target, 'admin:access', now),
        },
        input.supportSession
      )
    : 'Only the owner or an administrator can change what a person may do.';
  const viewerStates = actor ? await accessStates(db, actor, now) : new Map();
  const personal: Record<string, 'ALLOW' | 'DENY'> = {};
  for (const subRole of PHARMACY_SUB_ROLES) {
    const row = (target.permissionOverrides ?? []).find(
      (rule) => rule.capability === subRole.actions[0]
    );
    if (row) personal[subRole.key] = row.effect === 'DENY' ? 'DENY' : 'ALLOW';
  }
  const roles = await db.organizationRole.findMany({
    where: {
      organizationId: input.organizationId,
      isSystem: true,
      key: { in: [...PHARMACY_STARTING_ROLE_KEYS] },
    },
    select: { key: true, name: true, permissions: { select: { capability: true, effect: true } } },
  });
  const startingRoles = PHARMACY_STARTING_ROLE_KEYS.flatMap((key) => {
    const role = roles.find((candidate) => candidate.key === key);
    if (!role) return [];
    // What the role's own rules give (the server decides the rest when it is chosen).
    const states = pharmacySubRoleStates(pharmacyActionsAllowedByRules(role.permissions));
    const weighty = PHARMACY_SUB_ROLES.filter(
      (subRole) => isWeightyPharmacySubRole(subRole.key) && states.get(subRole.key) === 'on'
    ).map((subRole) => subRole.key);
    return [{ key, name: role.name, weighty }];
  });
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
    startingRoles,
    weighty: { ...PHARMACY_WEIGHTY_SUB_ROLES },
  };
}
