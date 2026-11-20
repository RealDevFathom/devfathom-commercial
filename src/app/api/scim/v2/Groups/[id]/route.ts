import { z } from 'zod';
import {
  recordScimEvent,
  requestBaseUrl,
  SCIM_GROUP_SCHEMA,
  SCIM_PATCH_SCHEMA,
  scimAccessChange,
  scimError,
  scimJson,
  withScimAuth,
} from '@/lib/scim';

async function loadRole(ctx: Parameters<Parameters<typeof withScimAuth>[1]>[0], id: string) {
  return ctx.db.organizationRole.findUnique({
    where: { id },
    include: { users: { select: { id: true, name: true } } },
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
      const operations: Array<{ op: 'add' | 'replace' | 'remove'; ids: string[] }> = [];
      for (const operation of input.Operations) {
        if (!operation.path?.toLowerCase().startsWith('members')) {
          return scimError(400, `Unsupported PATCH path: ${operation.path}`, 'invalidPath');
        }
        if (operation.op !== 'add' && operation.op !== 'replace' && operation.op !== 'remove') {
          return scimError(400, `Unsupported PATCH operation: ${operation.op}`, 'invalidValue');
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
        operations.push({ op: operation.op, ids });
      }
      // DEV-959B: everyone whose role this request can change — the group's current members
      // and every member named — passes the pharmacy access guard together.
      const named = [...new Set(operations.flatMap((operation) => operation.ids))];
      const affected = [
        ...new Set([
          ...role.users.map((user) => user.id),
          ...(
            await ctx.db.user.findMany({ where: { id: { in: named } }, select: { id: true } })
          ).map((user) => user.id),
        ]),
      ];
      await scimAccessChange(ctx, affected, 'scim.patchGroup', async () => {
        for (const operation of operations) {
          if (operation.op === 'add' || operation.op === 'replace') {
            if (operation.op === 'replace') {
              await ctx.db.user.updateMany({
                where: { organizationRoleId: role.id },
                data: { organizationRoleId: null },
              });
            }
            await ctx.db.user.updateMany({
              where: { id: { in: operation.ids } },
              data: { organizationRoleId: role.id },
            });
          } else {
            await ctx.db.user.updateMany({
              where: { id: { in: operation.ids }, organizationRoleId: role.id },
              data: { organizationRoleId: null },
            });
          }
        }
        return { targetIds: affected, value: null };
      });
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
