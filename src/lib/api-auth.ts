import { db } from '@/lib/db';
import { compare, hash } from 'bcryptjs';
import { randomBytes } from 'crypto';
import { NextResponse } from 'next/server';

export type ApiContext = {
  userId: string;
  userRole: 'ADMIN' | 'EMPLOYEE';
  scopes: string[];
  tokenId: string;
};

/**
 * Generate a new API token.
 * Format: c19_<32 random hex chars>
 * Returns the plain token (shown to user once) and the hash to store.
 */
export async function generateApiToken(): Promise<{ token: string; prefix: string; hash: string }> {
  const random = randomBytes(24).toString('base64url');
  const token = `c19_${random}`;
  const prefix = token.slice(0, 12);
  const tokenHash = await hash(token, 10);
  return { token, prefix, hash: tokenHash };
}

/**
 * Authenticate a request via Authorization: Bearer header.
 * Returns ApiContext on success, or NextResponse error on failure.
 */
export async function authenticateApiRequest(
  request: Request
): Promise<ApiContext | NextResponse> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return NextResponse.json(
      { error: 'Missing or invalid Authorization header. Expected: Bearer <token>' },
      { status: 401 }
    );
  }

  const token = authHeader.slice(7).trim();
  if (!token.startsWith('c19_')) {
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

    if (candidate.user.status !== 'ACTIVE') {
      return NextResponse.json({ error: 'User account is inactive' }, { status: 403 });
    }

    if (candidate.expiresAt && candidate.expiresAt < new Date()) {
      return NextResponse.json({ error: 'Token has expired' }, { status: 401 });
    }

    // Update lastUsedAt (fire and forget)
    db.apiToken.update({
      where: { id: candidate.id },
      data: { lastUsedAt: new Date() },
    }).catch(() => {});

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
    const auth = await authenticateApiRequest(request);
    if (auth instanceof NextResponse) return auth;

    if (!hasScope(auth, requiredScope)) {
      return NextResponse.json(
        { error: `Insufficient permissions. Required scope: ${requiredScope}` },
        { status: 403 }
      );
    }

    try {
      return await handler(auth, request, ...args);
    } catch (err) {
      console.error(`API error in ${requiredScope}:`, err);
      const message = err instanceof Error ? err.message : 'Internal server error';
      return NextResponse.json({ error: message }, { status: 500 });
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
  { value: 'finance:write', label: 'Finance (write)', description: 'Create, update transactions and invoices' },
  { value: 'meetings:read', label: 'Meetings (read)', description: 'Read meetings' },
  { value: 'meetings:write', label: 'Meetings (write)', description: 'Create, update meetings' },
] as const;
