import { z } from 'zod';
import {
  recordScimEvent,
  requestBaseUrl,
  SCIM_GROUP_SCHEMA,
  SCIM_PATCH_SCHEMA,
  scimError,
  scimJson,
  scimPatchGroupMembers,
  ScimOwnerAccessRefusal,
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
      // DEV-974: plan every operation before writing any, so a PATCH is all or
      // nothing. A refusal is still recorded as a SCIM event.
      const refuse = async (status: number, detail: string, scimType: string) => {
        await recordScimEvent(ctx, request, {
          operation: 'PATCH',
          resourceType: 'Group',
          status: 'FAILED',
          payload: { groupId: role.id },
          error: detail,
        });
        return scimError(status, detail, scimType);
      };
      const operations: Array<{ op: 'add' | 'replace' | 'remove'; ids: string[] }> = [];
      for (const operation of input.Operations) {
        if (!operation.path?.toLowerCase().startsWith('members')) {
          return refuse(400, `Unsupported PATCH path: ${operation.path}`, 'invalidPath');
        }
        if (operation.op !== 'add' && operation.op !== 'replace' && operation.op !== 'remove') {
          return refuse(400, `Unsupported PATCH operation: ${operation.op}`, 'invalidValue');
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
      // DEV-974: the owner-level check runs inside, before any write (see scim.ts).
      try {
        await scimPatchGroupMembers(ctx, role.id, operations);
      } catch (error) {
        if (error instanceof ScimOwnerAccessRefusal) {
          return refuse(403, error.message, 'mutability');
        }
        throw error;
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
