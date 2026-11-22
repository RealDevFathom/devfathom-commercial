import 'server-only';

import { TRPCError } from '@trpc/server';
import { capabilityMatches, decideFromRules } from '@/lib/abac/capabilities';
import { approvalSecretKindFor } from '@/lib/approval-authenticator';
import {
  PHARMACY_SUB_ROLES,
  pharmacyActionsAllowedByRules,
  pharmacySubRoleGroups,
  type PharmacySubRole,
} from '@/lib/abac/pharmacy-sub-roles';
import {
  isWeightyPharmacySubRole,
  PHARMACY_WEIGHTY_SUB_ROLES,
} from '@/lib/abac/pharmacy-sub-role-weight';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  refuseSupportSessionPin,
  rethrowAccessChange,
  verifyAccessPin,
} from './member-sub-role-edit';
import {
  guardPharmacyAccessChanges,
  isAccessOwner,
  loadAccessParty,
} from './pharmacy-access-guard';

const editAction = 'organizationAdmin.setRoleSubRole';
type RoleRequest = {
  organizationId: string;
  actorId: string;
  roleId: string;
  supportSession: boolean;
};

async function roleForEditor(db: ScopedDb, input: RoleRequest, now: Date) {
  const role = await db.organizationRole.findFirst({
    where: { id: input.roleId, organizationId: input.organizationId },
    select: {
      id: true,
      key: true,
      isSystem: true,
      name: true,
      permissions: { select: { capability: true, effect: true } },
      _count: { select: { users: true } },
    },
  });
  if (!role) throw new TRPCError({ code: 'NOT_FOUND', message: 'Role not found.' });
  const actor = await loadAccessParty(db, input.organizationId, input.actorId, now);
  const refusal =
    input.supportSession || !actor || !(await isAccessOwner(db, actor, now))
      ? 'Only the workspace owner can change a role for everyone.'
      : actor.organizationRoleId === role.id
        ? 'Another owner must edit this role because you hold it yourself.'
        : null;
  return { role, refusal };
}

/** Only an exact rule on the requested action can be changed. Broader grants stay in place. */
function roleChange(
  { role, refusal }: Awaited<ReturnType<typeof roleForEditor>>,
  subRole: PharmacySubRole,
  ticked: boolean
) {
  const [action] = subRole.actions;
  const current = role.permissions.find((rule) => rule.capability === action)?.effect ?? null;
  const remaining = role.permissions.filter((rule) => rule.capability !== action);
  const inherited = decideFromRules(remaining, action) === true;
  const before = pharmacyActionsAllowedByRules(role.permissions);
  // Ask the same evaluator which other active sub-role grants this one. A namespace
  // wildcard may be masked, but an implied tick must be changed through its parent.
  const parents = PHARMACY_SUB_ROLES.filter((parent) =>
    parent.actions.some(
      (capability) =>
        capability !== action &&
        before.has(capability) &&
        decideFromRules([{ capability, effect: 'ALLOW' }], action) === true
    )
  );
  let effect: 'ALLOW' | 'DENY' | null = null;
  if (ticked && !inherited) effect = 'ALLOW';
  if (
    !ticked &&
    inherited &&
    !parents.length &&
    remaining.some(
      (rule) =>
        rule.effect === 'ALLOW' &&
        rule.capability.endsWith('*') &&
        capabilityMatches(rule.capability, action)
    )
  )
    effect = 'DENY';
  const after = pharmacyActionsAllowedByRules(
    effect ? [...remaining, { capability: action, effect }] : remaining
  );
  const changed = PHARMACY_SUB_ROLES.filter((item) =>
    item.actions.some((capability) => before.has(capability) !== after.has(capability))
  );
  const included =
    !ticked && parents.length
      ? `Included with ${parents.map((parent) => parent.label).join(' and ')}. Untick that first.`
      : null;
  let reason = refusal ?? included;
  if (!reason && after.has(action) !== ticked) reason = 'Another role rule refuses this sub-role.';
  if (!reason && role.isSystem && role.key === 'owner' && !ticked)
    reason = 'A refusal on the Owner role would remove ownership.';
  return { reason, included, effect, changed, alreadySet: before.has(action) === ticked, current };
}

export async function readPharmacyRoleAccess(db: ScopedDb, input: RoleRequest) {
  const context = await roleForEditor(db, input, new Date());
  const { role, refusal } = context;
  const allowed = pharmacyActionsAllowedByRules(role.permissions);
  const locked: Record<string, string | null> = {};
  const roleNotes: Record<string, string> = {};
  for (const item of PHARMACY_SUB_ROLES) {
    const action = item.actions[0];
    const ticked = allowed.has(action);
    const change = roleChange(context, item, !ticked);
    locked[item.key] = change.reason;
    if (refusal && change.included) {
      roleNotes[item.key] = change.included;
    } else if (decideFromRules(role.permissions, action) === false) {
      roleNotes[item.key] =
        'People on this role cannot receive this ability individually while it is unticked.';
    } else if (ticked && change.effect === 'DENY' && !change.reason) {
      roleNotes[item.key] =
        'Unticking also blocks individual grants of this ability for people on this role.';
    }
  }
  return {
    name: role.name,
    isSystem: role.isSystem,
    holderCount: role._count.users,
    refusal,
    locked,
    roleNotes,
    weighty: PHARMACY_WEIGHTY_SUB_ROLES,
    groups: pharmacySubRoleGroups(allowed),
  };
}

export async function setPharmacyRoleSubRole(
  db: ScopedDb,
  input: RoleRequest & { subRoleKey: string; ticked: boolean; pin?: string }
) {
  refuseSupportSessionPin(input);
  const subRole = PHARMACY_SUB_ROLES.find((item) => item.key === input.subRoleKey);
  if (!subRole || subRole.actions.length !== 1)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown sub-role.' });
  const action = subRole.actions[0];
  const pinVerified = await verifyAccessPin({ ...input, action: editAction });
  const now = new Date();
  try {
    return await db.$transaction(async (transaction) => {
      const tx = transaction as unknown as ScopedDb;
      const { value } = await guardPharmacyAccessChanges(
        tx,
        {
          organizationId: input.organizationId,
          actor: { kind: 'member', id: input.actorId, supportSession: input.supportSession },
          targetIds: async () =>
            (
              await tx.user.findMany({
                where: { organizationId: input.organizationId, organizationRoleId: input.roleId },
                select: { id: true },
              })
            ).map((holder) => holder.id),
          pinVerified,
          mode: 'tick',
          action: editAction,
          now,
          describe: (name) => `Changed ${subRole.label} through the role held by ${name}`,
          metadata: { roleId: input.roleId, subRole: subRole.key, ticked: input.ticked },
        },
        async (contexts) => {
          // The guard holds the same organization lock as member assignments. Check the role
          // itself here even when it has no holders, or personal exceptions mask the change.
          const context = await roleForEditor(tx, input, now);
          const { role } = context;
          const { reason, effect, changed, alreadySet, current } = roleChange(
            context,
            subRole,
            input.ticked
          );
          if (reason) throw new TRPCError({ code: 'FORBIDDEN', message: reason });
          const targetIds = contexts.map(({ target }) => target!.id);
          if (alreadySet) return { targetIds, value: { changed: [] as string[] } };
          if (
            !pinVerified &&
            (isWeightyPharmacySubRole(subRole.key) ||
              changed.some((item) => isWeightyPharmacySubRole(item.key)))
          ) {
            const kind = await approvalSecretKindFor(tx, input.organizationId);
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: `Enter your ${kind === 'CODE' ? 'approval code' : 'PIN'} to change this sub-role.`,
            });
          }
          const permission = { organizationRoleId: role.id, capability: action };
          if (effect === null) {
            await tx.organizationRolePermission.deleteMany({
              where: { organizationId: input.organizationId, ...permission },
            });
          } else {
            await tx.organizationRolePermission.upsert({
              where: { organizationRoleId_capability: permission },
              create: { organizationId: input.organizationId, ...permission, effect },
              update: { effect },
            });
          }
          const keys = changed.map((item) => item.key);
          await tx.auditLog.create({
            data: {
              organizationId: input.organizationId,
              actorId: input.actorId,
              actorType: 'USER',
              source: 'TRPC',
              category: 'TEAM',
              operation: 'UPDATE',
              action: editAction,
              targetType: 'OrganizationRole',
              targetId: role.id,
              targetLabel: role.name,
              description: `${input.ticked ? 'Ticked' : 'Unticked'} ${subRole.label} for the ${role.name} role`,
              changes: {
                capability: action,
                before: current,
                after: effect,
              },
              metadata: {
                subRole: subRole.key,
                changedSubRoles: keys,
                holderCount: targetIds.length,
                pinVerified,
              },
            },
          });
          return { targetIds, value: { changed: keys } };
        }
      );
      return value;
    });
  } catch (error) {
    rethrowAccessChange(error);
  }
}
