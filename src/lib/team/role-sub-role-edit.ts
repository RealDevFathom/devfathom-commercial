import 'server-only';

import { TRPCError } from '@trpc/server';
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
  accessStates,
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
  const held = actor && !refusal ? await accessStates(db, actor, now) : new Map<string, string>();
  return { role, refusal, held };
}

/** Preview the exact same persisted-rule transition used by the write, including implied grants. */
function roleChange(
  { role, refusal, held }: Awaited<ReturnType<typeof roleForEditor>>,
  subRole: PharmacySubRole,
  ticked: boolean
) {
  const action = subRole.actions[0];
  const before = pharmacyActionsAllowedByRules(role.permissions);
  const effect = ticked ? ('ALLOW' as const) : ('DENY' as const);
  const after = pharmacyActionsAllowedByRules([
    ...role.permissions.filter((rule) => rule.capability !== action),
    { capability: action, effect },
  ]);
  const changed = PHARMACY_SUB_ROLES.filter((item) =>
    item.actions.some((capability) => before.has(capability) !== after.has(capability))
  );
  let reason = refusal;
  if (!reason && after.has(action) !== ticked) reason = 'Another role rule refuses this sub-role.';
  if (
    !reason &&
    changed.some(
      (item) =>
        item.actions.some((capability) => after.has(capability)) && held.get(item.key) !== 'on'
    )
  )
    reason = 'You can only give sub-roles you can use yourself.';
  if (!reason && role.isSystem && role.key === 'owner' && !ticked)
    reason = 'A refusal on the Owner role would remove ownership.';
  return { reason, effect, changed, alreadySet: before.has(action) === ticked };
}

export async function readPharmacyRoleAccess(db: ScopedDb, input: RoleRequest) {
  const context = await roleForEditor(db, input, new Date());
  const { role, refusal } = context;
  const allowed = pharmacyActionsAllowedByRules(role.permissions);
  return {
    name: role.name,
    holderCount: role._count.users,
    refusal,
    locked: Object.fromEntries(
      PHARMACY_SUB_ROLES.map((item) => [
        item.key,
        roleChange(context, item, !allowed.has(item.actions[0])).reason,
      ])
    ),
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
          const { reason, effect, changed, alreadySet } = roleChange(
            context,
            subRole,
            input.ticked
          );
          if (reason) throw new TRPCError({ code: 'FORBIDDEN', message: reason });
          const targetIds = contexts.map(({ target }) => target!.id);
          if (alreadySet) return { targetIds, value: { changed: [] as string[] } };
          if (changed.some((item) => isWeightyPharmacySubRole(item.key)) && !pinVerified)
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'Enter your PIN to change this sub-role.',
            });
          // Only the requested exact rule changes. Other template grants and personal
          // exceptions stay in place and continue through the same deny-first evaluator.
          await tx.organizationRolePermission.upsert({
            where: {
              organizationRoleId_capability: { organizationRoleId: role.id, capability: action },
            },
            create: {
              organizationId: input.organizationId,
              organizationRoleId: role.id,
              capability: action,
              effect,
            },
            update: { effect },
          });
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
                before: role.permissions.find((rule) => rule.capability === action)?.effect ?? null,
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
