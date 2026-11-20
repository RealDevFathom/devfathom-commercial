import 'server-only';

import { createHash } from 'node:crypto';
import { publicRequestOrigin } from '@/lib/http-origin';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import {
  AccessChangeError,
  guardPharmacyAccessChanges,
  isPharmacyOrganization,
} from '@/lib/team/pharmacy-access-guard';

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

export type ScimContext = {
  organizationId: string;
  tokenId: string;
  db: ScopedDb;
};

export function scimError(status: number, detail: string, scimType?: string): Response {
  return Response.json(
    {
      schemas: [SCIM_ERROR_SCHEMA],
      status: String(status),
      detail,
      ...(scimType ? { scimType } : {}),
    },
    {
      status,
      headers: { 'Content-Type': 'application/scim+json' },
    }
  );
}

export function scimJson(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: { 'Content-Type': 'application/scim+json', ...headers },
  });
}

export async function withScimAuth(
  request: Request,
  run: (ctx: ScimContext) => Promise<Response>
): Promise<Response> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return scimError(401, 'A SCIM bearer token is required.');
  }
  const token = authorization.slice(7).trim();
  if (!token.startsWith('scim_') || token.length < 40 || token.length > 128) {
    return scimError(401, 'The SCIM bearer token is invalid.');
  }
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const credential = await withPlatformDb((db) =>
    db.organizationScimToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        organizationId: true,
        expiresAt: true,
        revokedAt: true,
        organization: { select: { status: true } },
      },
    })
  );
  if (
    !credential ||
    credential.revokedAt ||
    (credential.expiresAt && credential.expiresAt <= new Date()) ||
    !['ONBOARDING', 'ACTIVE', 'GRACE'].includes(credential.organization.status)
  ) {
    return scimError(401, 'The SCIM bearer token is invalid or expired.');
  }

  // DEV-959B: a pharmacy access change the guard refuses rolls the whole request back.
  try {
    return await withTenantDb(
      credential.organizationId,
      async (db) => {
        const entitlements = await resolveOrganizationEntitlements(credential.organizationId, db);
        if (!hasModule(entitlements, 'scim')) {
          return scimError(403, 'SCIM provisioning is not licensed for this organization.');
        }
        await db.organizationScimToken.update({
          where: { id: credential.id },
          data: { lastUsedAt: new Date() },
        });
        return run({
          organizationId: credential.organizationId,
          tokenId: credential.id,
          db,
        });
      },
      { timeout: 60_000 }
    );
  } catch (error) {
    if (error instanceof AccessChangeError) return scimError(403, error.message);
    throw error;
  }
}

/**
 * DEV-959B: in a pharmacy, a SCIM write that changes people's roles or status runs inside the
 * access guard. SCIM has no member and no fresh approval behind it, so it may only take
 * access away: it never gives a weighty sub-role, never makes an administrator or an owner,
 * and never leaves the organization without an owner.
 */
export async function scimAccessChange<T>(
  ctx: ScimContext,
  targetIds: string[] | null,
  action: string,
  write: () => Promise<{ targetIds: string[]; value: T }>
): Promise<T> {
  if (!(await isPharmacyOrganization(ctx.db, ctx.organizationId))) return (await write()).value;
  const { value } = await guardPharmacyAccessChanges(
    ctx.db,
    {
      organizationId: ctx.organizationId,
      actor: { kind: 'system', source: 'SCIM' },
      targetIds,
      pinVerified: false,
      mode: 'role',
      action,
      describe: (name) => `Directory provisioning changed ${name}`,
    },
    write
  );
  return value;
}

export function scimUser(
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  },
  baseUrl: string
) {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: user.id,
    userName: user.email,
    displayName: user.name,
    name: { formatted: user.name },
    emails: [{ value: user.email, primary: true, type: 'work' }],
    active: ['ACTIVE', 'ON_LEAVE'].includes(user.status),
    roles: [{ value: user.role, primary: true }],
    meta: {
      resourceType: 'User',
      created: user.createdAt.toISOString(),
      lastModified: user.updatedAt.toISOString(),
      version: `W/"${user.updatedAt.getTime()}"`,
      location: `${baseUrl}/api/scim/v2/Users/${user.id}`,
    },
  };
}

export function requestBaseUrl(request: Request): string {
  return publicRequestOrigin(request);
}

export function scimRole(value: unknown): 'ADMIN' | 'EMPLOYEE' | 'HR' {
  const normalized = typeof value === 'string' ? value.toUpperCase() : 'EMPLOYEE';
  return normalized === 'ADMIN' || normalized === 'HR' ? normalized : 'EMPLOYEE';
}

export async function recordScimEvent(
  ctx: ScimContext,
  request: Request,
  event: {
    operation: string;
    resourceType: string;
    externalId?: string | null;
    status: string;
    payload?: unknown;
    error?: string | null;
  }
) {
  const idempotencyKey = request.headers.get('idempotency-key')?.slice(0, 200) ?? null;
  try {
    await ctx.db.organizationScimEvent.create({
      data: {
        organizationId: ctx.organizationId,
        idempotencyKey,
        operation: event.operation,
        resourceType: event.resourceType,
        externalId: event.externalId,
        status: event.status,
        payload:
          event.payload === undefined
            ? undefined
            : (JSON.parse(JSON.stringify(event.payload)) as never),
        error: event.error,
      },
    });
  } catch (error) {
    // A repeated idempotency key is an already-recorded request, not a reason to
    // fail a successfully applied state transition.
    if (
      !idempotencyKey ||
      !(error instanceof Error) ||
      !error.message.includes('Unique constraint')
    ) {
      throw error;
    }
  }
}
