import { compare, hash } from 'bcryptjs';
import { randomBytes } from 'crypto';
import { NextResponse } from 'next/server';
import { recordRestAudit } from '@/server/audit';
import { ACTIVE_STATUSES } from '@/lib/abac';
import { rateLimit, clientIp } from '@/lib/rate-limit';
import {
  createTenantDb,
  type ScopedDb,
  withPlatformDb,
  withTenantDb,
} from '@/lib/tenancy/scoped-db';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { approvalAuthenticatorGate } from '@/lib/approval-authenticator-gate';
import { APPROVAL_AUTHENTICATOR_SETUP_MESSAGE } from '@/lib/auth/session-state';
import { moduleForApiScope } from '@/lib/module-catalog';
import type { EntitlementView } from '@/lib/module-catalog';

export type ApiContext = {
  organizationId: string;
  userId: string;
  userRole: 'ADMIN' | 'EMPLOYEE' | 'HR';
  scopes: string[];
  tokenId: string;
  db: ScopedDb;
  entitlements: EntitlementView;
};

/**
 * Generate a new API token.
 * Format: df_<32 random hex chars>
 * Returns the plain token (shown to user once) and the hash to store.
 */
export async function generateApiToken(): Promise<{ token: string; prefix: string; hash: string }> {
  const random = randomBytes(24).toString('base64url');
  const token = `df_${random}`;
  const prefix = token.slice(0, 12);
  const tokenHash = await hash(token, 10);
  return { token, prefix, hash: tokenHash };
}

/**
 * Authenticate a request via Authorization: Bearer header.
 * Returns ApiContext on success, or NextResponse error on failure.
 */
export async function authenticateApiRequest(request: Request): Promise<ApiContext | NextResponse> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return NextResponse.json(
      { error: 'Missing or invalid Authorization header. Expected: Bearer <token>' },
      { status: 401 }
    );
  }

  const token = authHeader.slice(7).trim();
  if (!token.startsWith('df_')) {
    return NextResponse.json({ error: 'Invalid token format' }, { status: 401 });
  }

  const prefix = token.slice(0, 12);

  // The tenant is not known until the token is resolved, so discovery runs in
  // the explicitly privileged platform scope. Every subsequent operation is
  // returned to the token's tenant scope.
  const candidates = await withPlatformDb((platformDb) =>
    platformDb.apiToken.findMany({
      where: { prefix },
      include: {
        user: {
          select: {
            id: true,
            role: true,
            status: true,
            organization: { select: { id: true, status: true } },
          },
        },
      },
    })
  );

  // Verify against bcrypt hash
  for (const candidate of candidates) {
    const valid = await compare(token, candidate.tokenHash);
    if (!valid) continue;

    if (!ACTIVE_STATUSES.has(candidate.user.status)) {
      return NextResponse.json({ error: 'User account is inactive' }, { status: 403 });
    }

    if (!['ONBOARDING', 'ACTIVE', 'GRACE'].includes(candidate.user.organization.status)) {
      return NextResponse.json({ error: 'Organization access is suspended' }, { status: 403 });
    }

    if (candidate.expiresAt && candidate.expiresAt < new Date()) {
      return NextResponse.json({ error: 'Token has expired' }, { status: 401 });
    }

    // Update lastUsedAt (fire and forget)
    void withTenantDb(candidate.organizationId, (tenantDb) =>
      tenantDb.apiToken.update({
        where: { id: candidate.id },
        data: { lastUsedAt: new Date() },
      })
    ).catch(() => {});

    const entitlements = await withTenantDb(candidate.organizationId, (tenantDb) =>
      resolveOrganizationEntitlements(candidate.organizationId, tenantDb)
    );
    if (!hasModule(entitlements, 'api')) {
      return NextResponse.json(
        { error: 'API access is not enabled for this organization.' },
        { status: 403 }
      );
    }

    // DEV-961: an API token acts as its member, so a member who can approve and has not set
    // up their approval authenticator is refused here exactly as their session is refused in
    // `resolveTenantActor`.
    const gate = await withTenantDb(candidate.organizationId, (tenantDb) =>
      approvalAuthenticatorGate(tenantDb, {
        organizationId: candidate.organizationId,
        userId: candidate.userId,
      })
    );
    if (gate.setupRequired) {
      return NextResponse.json(
        {
          error: APPROVAL_AUTHENTICATOR_SETUP_MESSAGE,
          code: 'APPROVAL_AUTHENTICATOR_SETUP_REQUIRED',
        },
        { status: 403 }
      );
    }

    return {
      organizationId: candidate.organizationId,
      userId: candidate.userId,
      userRole: candidate.user.role,
      scopes: candidate.scopes,
      tokenId: candidate.id,
      db: createTenantDb(candidate.organizationId),
      entitlements,
    };
  }

  return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
}

/**
 * Check if context has the required scope.
 * Wildcard "*" grants all access.
 */
export function hasScope(ctx: ApiContext, required: string): boolean {
  if (ctx.scopes.includes('*')) return true;
  if (ctx.scopes.includes(required)) return true;

  // "tasks:write" implicitly grants "tasks:read"
  if (required.endsWith(':read')) {
    const writeScope = required.replace(':read', ':write');
    if (ctx.scopes.includes(writeScope)) return true;
  }

  return false;
}

/** Secondary data in an admin-only response needs its own scope and live module. */
export function canIncludeAdminResource(
  ctx: ApiContext,
  scope: `${'clients' | 'finance' | 'projects'}:read`
): boolean {
  const moduleKey = moduleForApiScope(scope);
  return (
    ctx.userRole === 'ADMIN' &&
    hasScope(ctx, scope) &&
    moduleKey !== null &&
    hasModule(ctx.entitlements, moduleKey)
  );
}

/**
 * Wrap a route handler with authentication and scope checking.
 */
export function withApiAuth<T extends unknown[]>(
  requiredScope: string,
  handler: (ctx: ApiContext, request: Request, ...args: T) => Promise<Response> | Response
) {
  return async (request: Request, ...args: T): Promise<Response> => {
    const start = Date.now();

    // REST-04: per-IP flood control BEFORE authentication, so a stream of
    // invalid tokens can't run an unbounded bcrypt compare per request.
    const ip = clientIp(request);
    const ipGate = await rateLimit(`api:ip:${ip}`, 120, 60_000);
    if (!ipGate.ok) {
      const res = NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': String(ipGate.retryAfter) } }
      );
      recordRestAudit({ request, ctx: null, scope: requiredScope, status: 429, durationMs: 0 });
      return res;
    }

    let auditContext: ApiContext | null = null;
    try {
      const auth = await authenticateApiRequest(request);
      if (auth instanceof NextResponse) {
        // Authentication failed — record the attempt with no actor.
        recordRestAudit({
          request,
          ctx: null,
          scope: requiredScope,
          status: auth.status,
          durationMs: Date.now() - start,
        });
        return auth;
      }

      auditContext = auth;

      // REST-04: per-token throttle once the caller is identified.
      const tokenGate = await rateLimit(`api:token:${auth.tokenId}`, 240, 60_000);
      if (!tokenGate.ok) {
        const res = NextResponse.json(
          { error: 'Too many requests' },
          { status: 429, headers: { 'Retry-After': String(tokenGate.retryAfter) } }
        );
        recordRestAudit({
          request,
          ctx: auth,
          scope: requiredScope,
          status: 429,
          durationMs: Date.now() - start,
        });
        return res;
      }

      if (!hasScope(auth, requiredScope)) {
        const res = NextResponse.json(
          { error: `Insufficient permissions. Required scope: ${requiredScope}` },
          { status: 403 }
        );
        recordRestAudit({
          request,
          ctx: auth,
          scope: requiredScope,
          status: 403,
          error: 'Insufficient scope',
          durationMs: Date.now() - start,
        });
        return res;
      }

      // Finance is an admin-only domain. Enforce the bound user's ROLE here (not
      // just the token scope) so that even a wildcard "*" token issued to a
      // non-admin user cannot read or mutate finance data.
      if (requiredScope.startsWith('finance') && auth.userRole !== 'ADMIN') {
        const res = NextResponse.json(
          { error: 'Forbidden: finance endpoints require an admin-bound token' },
          { status: 403 }
        );
        recordRestAudit({
          request,
          ctx: auth,
          scope: requiredScope,
          status: 403,
          error: 'Finance requires admin-bound token',
          durationMs: Date.now() - start,
        });
        return res;
      }

      const res = await withTenantDb(auth.organizationId, async (tenantDb) => {
        const moduleKey = moduleForApiScope(requiredScope);
        if (moduleKey) {
          if (!hasModule(auth.entitlements, moduleKey)) {
            return NextResponse.json(
              { error: `The ${moduleKey} module is not enabled for this organization.` },
              { status: 403 }
            );
          }
        }
        return Promise.resolve(handler({ ...auth, db: tenantDb }, request, ...args));
      });
      recordRestAudit({
        request,
        ctx: auth,
        scope: requiredScope,
        status: res.status,
        durationMs: Date.now() - start,
      });
      return res;
    } catch (err) {
      return auditedApiError(request, requiredScope, start, auditContext, err);
    }
  };
}

/** A deliberate business-rule refusal. The message must be safe for the caller. */
export class ApiRequestError extends Error {
  constructor(
    public status: 400 | 403 | 409 | 422,
    safeMessage: string
  ) {
    super(safeMessage);
  }
}

export function auditedApiError(
  request: Request,
  scope: string,
  start: number,
  ctx: ApiContext | null,
  err: unknown
): NextResponse {
  if (err instanceof ApiRequestError) {
    recordRestAudit({
      request,
      ctx,
      scope,
      status: err.status,
      error: err.message,
      durationMs: Date.now() - start,
    });
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  // Log the full error server-side, but never leak DB/Prisma internals or
  // stack details to the client — respond with a generic 500.
  console.error('API error in %s:', scope, err);
  recordRestAudit({
    request,
    ctx,
    scope,
    status: 500,
    error: err,
    durationMs: Date.now() - start,
  });
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/**
 * Available scopes — referenced in the UI for token creation.
 */
export const AVAILABLE_SCOPES = [
  { value: '*', label: 'Full Access', description: 'Read and write everything' },
  { value: 'tasks:read', label: 'Tasks (read)', description: 'Read tasks and boards' },
  { value: 'tasks:write', label: 'Tasks (write)', description: 'Create, update, delete tasks' },
  { value: 'projects:read', label: 'Projects (read)', description: 'Read projects' },
  { value: 'projects:write', label: 'Projects (write)', description: 'Create, update projects' },
  { value: 'clients:read', label: 'Clients (read)', description: 'Read client data' },
  { value: 'clients:write', label: 'Clients (write)', description: 'Create, update clients' },
  { value: 'team:read', label: 'Team (read)', description: 'Read team directory' },
  { value: 'finance:read', label: 'Finance (read)', description: 'Read transactions and invoices' },
  {
    value: 'finance:write',
    label: 'Finance (write)',
    description: 'Create, update transactions and invoices',
  },
  {
    value: 'university:integrations:read',
    label: 'University event delivery',
    description: 'Read assigned university event topics',
  },
  {
    value: 'university:integrations:write',
    label: 'University acknowledgments',
    description: 'Acknowledge assigned university deliveries',
  },
  { value: 'meetings:read', label: 'Meetings (read)', description: 'Read meetings' },
  { value: 'meetings:write', label: 'Meetings (write)', description: 'Create, update meetings' },
] as const;
