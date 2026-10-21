import { lockOrganizationSeat } from '@/lib/organization-seat';
import { z } from 'zod';
import {
  recordScimEvent,
  requestBaseUrl,
  SCIM_PATCH_SCHEMA,
  scimError,
  scimJson,
  scimRole,
  scimUser,
  withScimAuth,
} from '@/lib/scim';
import { emailSchema, normalizeEmail } from '@/lib/email-address';

const replaceSchema = z.object({
  // D10: normalized at the schema layer — see the create route.
  userName: emailSchema,
  displayName: z.string().trim().min(1).max(200).optional(),
  name: z.object({ formatted: z.string().trim().min(1).max(200).optional() }).optional(),
  active: z.boolean().default(true),
  roles: z.array(z.object({ value: z.string() })).optional(),
});

const patchSchema = z.object({
  schemas: z.array(z.string()).refine((schemas) => schemas.includes(SCIM_PATCH_SCHEMA)),
  Operations: z
    .array(
      z.object({
        op: z
          .enum(['add', 'replace', 'remove'])
          .or(z.string().transform((value) => value.toLowerCase() as 'add')),
        path: z.string().optional(),
        value: z.unknown().optional(),
      })
    )
    .min(1)
    .max(50),
});

async function loadUser(ctx: Parameters<Parameters<typeof withScimAuth>[1]>[0], id: string) {
  return ctx.db.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function GET(request: Request, route: { params: Promise<{ id: string }> }) {
  return withScimAuth(request, async (ctx) => {
    const { id } = await route.params;
    const user = await loadUser(ctx, id);
    if (!user) return scimError(404, 'User not found.');
    const body = scimUser(user, requestBaseUrl(request));
    return scimJson(body, 200, { ETag: body.meta.version });
  });
}

export async function PUT(request: Request, route: { params: Promise<{ id: string }> }) {
  return withScimAuth(request, async (ctx) => {
    try {
      const { id } = await route.params;
      const input = replaceSchema.parse(await request.json());
      const current = await loadUser(ctx, id);
      if (!current) return scimError(404, 'User not found.');
      // D10/D20: a replace may move a user onto an address another member
      // already holds. Guard explicitly so the directory sees SCIM `uniqueness`
      // instead of a raw constraint violation.
      const email = normalizeEmail(input.userName);
      const clash = await ctx.db.user.findFirst({
        where: { email, id: { not: id } },
        select: { id: true },
      });
      if (clash) return scimError(409, 'A user with this userName already exists.', 'uniqueness');
      const user = await ctx.db.$transaction(async (tx) => {
        if (input.active) await lockOrganizationSeat(tx, ctx.organizationId, undefined, id);
        return tx.user.update({
        where: { id },
        data: {
          email,
          name: input.displayName ?? input.name?.formatted ?? current.name,
          role: scimRole(input.roles?.[0]?.value ?? current.role),
          status: input.active ? 'ACTIVE' : 'INACTIVE',
          tokenVersion: !input.active ? { increment: 1 } : undefined,
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      });
      await recordScimEvent(ctx, request, {
        operation: 'REPLACE',
        resourceType: 'User',
        status: 'SUCCEEDED',
        payload: { userId: user.id },
      });
      const body = scimUser(user, requestBaseUrl(request));
      return scimJson(body, 200, { ETag: body.meta.version });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return scimError(400, error.issues[0]?.message ?? 'Invalid SCIM user.', 'invalidValue');
      }
      throw error;
    }
  });
}

export async function PATCH(request: Request, route: { params: Promise<{ id: string }> }) {
  return withScimAuth(request, async (ctx) => {
    try {
      const { id } = await route.params;
      const input = patchSchema.parse(await request.json());
      const current = await loadUser(ctx, id);
      if (!current) return scimError(404, 'User not found.');
      const data: {
        name?: string;
        email?: string;
        role?: 'ADMIN' | 'EMPLOYEE' | 'HR';
        status?: 'ACTIVE' | 'INACTIVE';
        tokenVersion?: { increment: number };
      } = {};
      for (const operation of input.Operations) {
        const path = operation.path?.toLowerCase();
        if (path === 'active') {
          const active = Boolean(operation.value);
          data.status = active ? 'ACTIVE' : 'INACTIVE';
          if (!active) data.tokenVersion = { increment: 1 };
        } else if (path === 'displayname' || path === 'name.formatted') {
          if (typeof operation.value === 'string') data.name = operation.value.slice(0, 200);
        } else if (path === 'username') {
          if (typeof operation.value === 'string') {
            data.email = z.email().parse(operation.value).toLowerCase();
          }
        } else if (path === 'roles' || path === 'roles[primary eq true].value') {
          const value = Array.isArray(operation.value)
            ? (operation.value[0] as { value?: unknown } | undefined)?.value
            : operation.value;
          data.role = scimRole(
            typeof value === 'object' && value ? (value as { value?: unknown }).value : value
          );
        } else {
          return scimError(400, `Unsupported PATCH path: ${operation.path}`, 'invalidPath');
        }
      }
      const user = await ctx.db.$transaction(async (tx) => {
        if (data.status === 'ACTIVE') await lockOrganizationSeat(tx, ctx.organizationId, undefined, id);
        return tx.user.update({
        where: { id },
        data,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      });
      await recordScimEvent(ctx, request, {
        operation: 'PATCH',
        resourceType: 'User',
        status: 'SUCCEEDED',
        payload: { userId: user.id, paths: input.Operations.map((item) => item.path) },
      });
      const body = scimUser(user, requestBaseUrl(request));
      return scimJson(body, 200, { ETag: body.meta.version });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return scimError(400, error.issues[0]?.message ?? 'Invalid SCIM patch.', 'invalidValue');
      }
      throw error;
    }
  });
}

export async function DELETE(request: Request, route: { params: Promise<{ id: string }> }) {
  return withScimAuth(request, async (ctx) => {
    const { id } = await route.params;
    const user = await loadUser(ctx, id);
    if (!user) return scimError(404, 'User not found.');
    await ctx.db.user.update({
      where: { id },
      data: { status: 'INACTIVE', tokenVersion: { increment: 1 } },
    });
    await recordScimEvent(ctx, request, {
      operation: 'DELETE',
      resourceType: 'User',
      status: 'SUCCEEDED',
      payload: { userId: id },
    });
    return new Response(null, { status: 204 });
  });
}
