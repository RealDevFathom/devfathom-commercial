import { db } from '@/lib/db';
import { compare, hash } from 'bcryptjs';
import { randomBytes } from 'crypto';
import { NextResponse } from 'next/server';
import { recordRestAudit } from '@/server/audit';
import { ACTIVE_STATUSES } from '@/lib/abac';
import { rateLimit, clientIp } from '@/lib/rate-limit';

export type ApiContext = {
  userId: string;
  userRole: 'ADMIN' | 'EMPLOYEE' | 'HR';
  scopes: string[];
  tokenId: string;
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

  // Find candidate tokens by prefix
  const candidates = await db.apiToken.findMany({
    where: { prefix },
    include: { user: { select: { id: true, role: true, status: true } } },
  });

  // Verify against bcrypt hash
  for (const candidate of candidates) {
    const valid = await compare(token, candidate.tokenHash);
    if (!valid) continue;

    if (!ACTIVE_STATUSES.has(candidate.user.status)) {
      return NextResponse.json({ error: 'User account is inactive' }, { status: 403 });
    }

    if (candidate.expiresAt && candidate.expiresAt < new Date()) {
      return NextResponse.json({ error: 'Token has expired' }, { status: 401 });
    }

    // Update lastUsedAt (fire and forget)
    db.apiToken
      .update({
        where: { id: candidate.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => {});

    return {
      userId: candidate.userId,
      userRole: candidate.user.role,
      scopes: candidate.scopes,
      tokenId: candidate.id,
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
    const ipGate = rateLimit(`api:ip:${ip}`, 120, 60_000);
    if (!ipGate.ok) {
      const res = NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': String(ipGate.retryAfter) } }
      );
      recordRestAudit({ request, ctx: null, scope: requiredScope, status: 429, durationMs: 0 });
      return res;
    }

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

    // REST-04: per-token throttle once the caller is identified.
    const tokenGate = rateLimit(`api:token:${auth.tokenId}`, 240, 60_000);
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

    try {
      const res = await handler(auth, request, ...args);
      recordRestAudit({
        request,
        ctx: auth,
        scope: requiredScope,
        status: res.status,
        durationMs: Date.now() - start,
      });
      return res;
    } catch (err) {
      // Log the full error server-side, but never leak DB/Prisma internals or
      // stack details to the client — respond with a generic 500.
      console.error(`API error in ${requiredScope}:`, err);
      recordRestAudit({
        request,
        ctx: auth,
        scope: requiredScope,
        status: 500,
        error: err,
        durationMs: Date.now() - start,
      });
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  };
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
  { value: 'meetings:read', label: 'Meetings (read)', description: 'Read meetings' },
  { value: 'meetings:write', label: 'Meetings (write)', description: 'Create, update meetings' },
] as const;
