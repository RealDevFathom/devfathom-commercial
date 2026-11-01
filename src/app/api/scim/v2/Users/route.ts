import { lockOrganizationSeat } from '@/lib/organization-seat';
import { z } from 'zod';
import {
  requestBaseUrl,
  recordScimEvent,
  SCIM_LIST_SCHEMA,
  scimError,
  scimJson,
  scimRole,
  scimUser,
  withScimAuth,
} from '@/lib/scim';
import { resolveOrganizationEntitlements } from '@/lib/entitlements';
import { emailSchema, normalizeEmail } from '@/lib/email-address';
import {
  EmptyDepartmentCatalogError,
  resolveProvisionedDepartmentKey,
} from '@/lib/department-provisioning';

const createUserSchema = z.object({
  schemas: z.array(z.string()).optional(),
  externalId: z.string().max(255).optional(),
  // D10: normalized at the schema layer, so a directory that pads or upper-cases
  // the userName is provisioned against the same canonical identity rather than
  // rejected as malformed or duplicated as a second row.
  userName: emailSchema,
  displayName: z.string().trim().min(1).max(200).optional(),
  name: z.object({ formatted: z.string().trim().min(1).max(200).optional() }).optional(),
  active: z.boolean().default(true),
  roles: z.array(z.object({ value: z.string() })).optional(),
});

function filterEmail(value: string | null): string | null {
  if (!value) return null;
  const match = /^userName\s+eq\s+"([^"]+)"$/i.exec(value.trim());
  return match?.[1] ? normalizeEmail(match[1]) : null;
}

export async function GET(request: Request) {
  return withScimAuth(request, async (ctx) => {
    const url = new URL(request.url);
    const startIndex = Math.max(1, Number(url.searchParams.get('startIndex') ?? 1) || 1);
    const count = Math.min(200, Math.max(1, Number(url.searchParams.get('count') ?? 100) || 100));
    const email = filterEmail(url.searchParams.get('filter'));
    if (url.searchParams.has('filter') && !email) {
      return scimError(400, 'Only userName eq "email" filters are supported.', 'invalidFilter');
    }
    const where = email ? { email } : {};
    const [users, totalResults] = await Promise.all([
      ctx.db.user.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: startIndex - 1,
        take: count,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      ctx.db.user.count({ where }),
    ]);
    const baseUrl = requestBaseUrl(request);
    return scimJson({
      schemas: [SCIM_LIST_SCHEMA],
      totalResults,
      startIndex,
      itemsPerPage: users.length,
      Resources: users.map((user) => scimUser(user, baseUrl)),
    });
  });
}

export async function POST(request: Request) {
  return withScimAuth(request, async (ctx) => {
    try {
      const input = createUserSchema.parse(await request.json());
      // D10/D20: the directory may assert a different casing than the stored
      // row. Both are normalized, so this pre-check matches — and a duplicate
      // returns SCIM `uniqueness` (409) rather than letting the composite unique
      // index surface as a raw Prisma 500.
      const email = normalizeEmail(input.userName);
      const existing = await ctx.db.user.findFirst({ where: { email }, select: { id: true } });
      if (existing)
        return scimError(409, 'A user with this userName already exists.', 'uniqueness');
      const entitlements = await resolveOrganizationEntitlements(ctx.organizationId, ctx.db);
      if (entitlements.activeSeats >= entitlements.seatLimit) {
        return scimError(403, 'The organization seat limit has been reached.');
      }
      const role = scimRole(input.roles?.[0]?.value);
      // WHA-290: the same tenant-configured catalog the SSO JIT path resolves
      // against. SCIM asserts an identity, not a department, so a hardcoded
      // agency-era key would raise the composite foreign key in any tenant that
      // does not have it — a restaurant has KITCHEN/FRONT_OF_HOUSE only.
      const department = await resolveProvisionedDepartmentKey(ctx.db, ctx.organizationId, role);
      const user = await ctx.db.$transaction(async (tx) => {
        if (input.active) await lockOrganizationSeat(tx, ctx.organizationId, undefined);
        return tx.user.create({
        data: {
          organizationId: ctx.organizationId,
          name: input.displayName ?? input.name?.formatted ?? email.split('@')[0]!,
          email,
          password: null,
          role,
          department,
          title: role === 'ADMIN' ? 'Organization administrator' : 'Team member',
          status: input.active ? 'ACTIVE' : 'INACTIVE',
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
      const body = scimUser(user, requestBaseUrl(request));
      await recordScimEvent(ctx, request, {
        operation: 'CREATE',
        resourceType: 'User',
        externalId: input.externalId,
        status: 'SUCCEEDED',
        payload: { userId: user.id, userName: user.email },
      });
      return scimJson(body, 201, { Location: body.meta.location, ETag: body.meta.version });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return scimError(400, error.issues[0]?.message ?? 'Invalid SCIM user.', 'invalidValue');
      }
      // The tenant deactivated every department, so no user can be filed at
      // all. Answer the directory with the reason rather than a bare 500 or a
      // raw `users_organizationId_department_fkey`.
      if (error instanceof EmptyDepartmentCatalogError) {
        return scimError(409, error.message, 'mutability');
      }
      throw error;
    }
  });
}
