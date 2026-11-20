import { z } from 'zod';
import {
  recordScimEvent,
  requestBaseUrl,
  SCIM_GROUP_SCHEMA,
  SCIM_PATCH_SCHEMA,
  scimError,
  scimJson,
  withScimAuth,
} from '@/lib/scim';
import { RESET_PARTY_SELECT } from '@/lib/auth/admin-password-reset';
import { holdsOwnerLevelAccess } from '@/lib/auth/member-email-change';

const OWNER_ACCESS_REFUSAL = 'Owner access can only be changed by the owner in DevFathom.';

async function loadRole(ctx: Parameters<Parameters<typeof withScimAuth>[1]>[0], id: string) {
  return ctx.db.organizationRole.findUnique({
    where: { id },
    include: {
      users: { select: { id: true, name: true } },
      permissions: { select: { capability: true, effect: true } },
    },
  });
}

function resource(role: NonNullable<Awaited<ReturnType<typeof loadRole>>>, baseUrl: string) {
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: role.id,
    displayName: role.name,
    members: role.users.map((user) => ({
      value: user.id,
      display: user.name,
      $ref: `${baseUrl}/api/scim/v2/Users/${user.id}`,
    })),
    meta: {
      resourceType: 'Group',
      created: role.createdAt.toISOString(),
      lastModified: role.updatedAt.toISOString(),
      version: `W/"${role.updatedAt.getTime()}"`,
      location: `${baseUrl}/api/scim/v2/Groups/${role.id}`,
    },
  };
}

export async function GET(request: Request, route: { params: Promise<{ id: string }> }) {
  return withScimAuth(request, async (ctx) => {
    const { id } = await route.params;
    const role = await loadRole(ctx, id);
    if (!role) return scimError(404, 'Group not found.');
    const body = resource(role, requestBaseUrl(request));
    return scimJson(body, 200, { ETag: body.meta.version });
  });
}

export async function PATCH(request: Request, route: { params: Promise<{ id: string }> }) {
  return withScimAuth(request, async (ctx) => {
    try {
      const { id } = await route.params;
      const input = z
        .object({
          schemas: z.array(z.string()).refine((items) => items.includes(SCIM_PATCH_SCHEMA)),
          Operations: z.array(
            z.object({
              op: z.string().transform((value) => value.toLowerCase()),
              path: z.string().optional(),
              value: z.unknown().optional(),
            })
          ),
        })
        .parse(await request.json());
      const role = await loadRole(ctx, id);
      if (!role) return scimError(404, 'Group not found.');
      for (const operation of input.Operations) {
        if (!operation.path?.toLowerCase().startsWith('members')) {
          return scimError(400, `Unsupported PATCH path: ${operation.path}`, 'invalidPath');
        }
        const values = Array.isArray(operation.value)
          ? operation.value
          : operation.value
            ? [operation.value]
            : [];
        const ids = values
          .map((value) =>
            typeof value === 'object' && value ? (value as { value?: unknown }).value : undefined
          )
          .filter((value): value is string => typeof value === 'string');
        // DEV-974: only the owner adds or removes owner-level access. Any administrator
        // can mint a SCIM token, so a directory may neither change the membership of an
        // owner-level role nor move an owner-level member into another role.
        if (holdsOwnerLevelAccess({ organizationRole: role, permissionOverrides: [] })) {
          return scimError(403, OWNER_ACCESS_REFUSAL, 'mutability');
        }
        const members = ids.length
          ? await ctx.db.user.findMany({ where: { id: { in: ids } }, select: RESET_PARTY_SELECT })
          : [];
        if (members.some((member) => holdsOwnerLevelAccess(member))) {
          return scimError(403, OWNER_ACCESS_REFUSAL, 'mutability');
        }
        if (operation.op === 'add' || operation.op === 'replace') {
          if (operation.op === 'replace') {
            await ctx.db.user.updateMany({
              where: { organizationRoleId: role.id },
              data: { organizationRoleId: null },
            });
          }
          await ctx.db.user.updateMany({
            where: { id: { in: ids } },
            data: { organizationRoleId: role.id },
          });
        } else if (operation.op === 'remove') {
          await ctx.db.user.updateMany({
            where: { id: { in: ids }, organizationRoleId: role.id },
            data: { organizationRoleId: null },
          });
        } else {
          return scimError(400, `Unsupported PATCH operation: ${operation.op}`, 'invalidValue');
        }
      }
      await recordScimEvent(ctx, request, {
        operation: 'PATCH',
        resourceType: 'Group',
        status: 'SUCCEEDED',
        payload: { groupId: role.id },
      });
      const updated = await loadRole(ctx, id);
      const body = resource(updated!, requestBaseUrl(request));
      return scimJson(body, 200, { ETag: body.meta.version });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return scimError(400, error.issues[0]?.message ?? 'Invalid group patch.', 'invalidValue');
      }
      throw error;
    }
  });
}

export async function DELETE() {
  return scimError(403, 'Groups are managed by organization administrators.', 'mutability');
}
