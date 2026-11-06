import { afterTenantTransaction } from '@/lib/side-effects/scope';
import { clientIp } from '@/lib/rate-limit';
import { type ScopedDb, withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';

/**
 * ============================================================================
 * AUDIT LOG CORE
 * ============================================================================
 * Extreme-granular, admin-only audit trail. Every write is fire-and-forget:
 * failing to record an audit entry must NEVER surface an error to the user or
 * roll back their action (mirrors the Activity feed's `logActivity` contract).
 *
 * Four capture points feed into here:
 *   1. tRPC middleware        -> recordTrpcAudit   (all mutations + admin reads)
 *   2. REST withApiAuth       -> recordRestAudit   (every /api/v1 call)
 *   3. NextAuth               -> recordAuthAudit   (login / logout / failed login)
 *   4. SYSTEM / ad-hoc        -> recordAudit       (low-level escape hatch)
 *
 * Individual mutations may *enrich* the auto-captured tRPC entry (target,
 * human label, before/after diff) by calling `annotateAudit(ctx, {...})`.
 */

// ---- String-literal mirrors of the Prisma enums (avoids importing generated
// enums before `prisma generate` has run). Prisma accepts these strings. ----
export type AuditActorTypeT = 'USER' | 'API_TOKEN' | 'ANONYMOUS' | 'SYSTEM' | 'RESTAURANT_OPERATOR'; // a restaurant staff operator acting at a terminal (M2) — not a User
export type AuditSourceT = 'TRPC' | 'REST_API' | 'AUTH' | 'SYSTEM';
export type AuditOperationT =
  | 'CREATE'
  | 'READ'
  | 'UPDATE'
  | 'DELETE'
  | 'LOGIN'
  | 'LOGOUT'
  | 'LOGIN_FAILED'
  | 'EXECUTE'
  | 'OTHER';
export type AuditOutcomeT = 'SUCCESS' | 'FAILURE';

/**
 * Per-request mutable detail a mutation can attach to enrich its audit entry.
 * Lives on the tRPC context (`ctx.audit.detail`) — see createTRPCContext.
 */
export interface AuditDetail {
  category?: string;
  operation?: AuditOperationT;
  action?: string;
  description?: string;
  targetType?: string;
  targetId?: string;
  targetLabel?: string;
  changes?: Record<string, { before: unknown; after: unknown }> | null;
  metadata?: Record<string, unknown>;
  result?: unknown;
  /** Skip auto-capturing the raw input (use for unusually sensitive payloads). */
  skipInput?: boolean;
}

/** Minimal structural shape of the tRPC context the audit layer reads. */
export interface AuditContext {
  session?: {
    user?: {
      id?: string;
      name?: string | null;
      email?: string | null;
      role?: string | null;
      organizationId?: string | null;
      isSupportSession?: boolean;
      supportSessionId?: string;
      platformUserId?: string;
    } | null;
  } | null;
  requestMeta?: { ip?: string | null; userAgent?: string | null } | null;
  audit?: { detail: AuditDetail; db?: ScopedDb };
}

// ---------------------------------------------------------------------------
// Redaction + JSON-safe serialization
// ---------------------------------------------------------------------------

// Any object key containing one of these (case-insensitive) is stored as
// "[REDACTED]". Chosen to avoid false positives like `authorId`/`author`.
const SENSITIVE_SUBSTRINGS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'otp',
  'credential',
  'privatekey',
  'private_key',
  'cookie',
];

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  // Camera renewal input can be audited before its resolver runs (including
  // denied or invalid requests). Match the identifier exactly, not all grants.
  // Match PIN exactly so unrelated keys such as shippingAddress remain useful.
  // Camera gateway base URLs are rejected when they carry credentials or an
  // address, but a rejected value is still audited; never retain it (DEV-740).
  return (
    k === 'pin' ||
    k === 'previousgrantid' ||
    k === 'baseurl' ||
    SENSITIVE_SUBSTRINGS.some((s) => k.includes(s))
  );
}

const MAX_STRING = 20_000;
const MAX_DEPTH = 8;
const MAX_ARRAY = 250;

/**
 * Deep-convert an arbitrary value into something safe to store in a Prisma
 * `Json` column: redacts sensitive keys, stringifies Date/BigInt/Decimal,
 * caps very long strings and very large arrays, and guards against deep nesting.
 */
export function toAuditJson(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;

  const t = typeof value;
  if (t === 'string') {
    const s = value as string;
    return s.length > MAX_STRING
      ? `${s.slice(0, MAX_STRING)}…[+${s.length - MAX_STRING} chars]`
      : s;
  }
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return (value as bigint).toString();
  if (value instanceof Date) return value.toISOString();

  if (depth >= MAX_DEPTH) return '[Truncated: max depth]';

  if (Array.isArray(value)) {
    const arr = value.slice(0, MAX_ARRAY).map((v) => toAuditJson(v, depth + 1));
    if (value.length > MAX_ARRAY) arr.push(`…[+${value.length - MAX_ARRAY} items]`);
    return arr;
  }

  if (t === 'object') {
    // Prisma Decimal (and similar) -> string to preserve precision.
    const ctorName = (value as { constructor?: { name?: string } }).constructor?.name;
    if (ctorName === 'Decimal') return (value as { toString(): string }).toString();

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? '[REDACTED]' : toAuditJson(v, depth + 1);
    }
    return out;
  }

  return String(value);
}

// ---------------------------------------------------------------------------
// Categorization helpers
// ---------------------------------------------------------------------------

const ROUTER_CATEGORY: Record<string, string> = {
  projects: 'PROJECT',
  finance: 'FINANCE',
  clients: 'CLIENT',
  chat: 'CHAT',
  team: 'TEAM',
  trelloImport: 'PROJECT',
  meetings: 'MEETING',
  apiTokens: 'API_TOKEN',
  notes: 'NOTE',
  invitations: 'TEAM',
  dashboard: 'SYSTEM',
  search: 'SYSTEM',
  teamStats: 'TEAM',
  audit: 'SYSTEM',
};

export function categoryForPath(path: string): string {
  const seg = path.split('.')[0] ?? path;
  return ROUTER_CATEGORY[seg] ?? seg.toUpperCase();
}

export function operationForPath(path: string, type: 'query' | 'mutation'): AuditOperationT {
  if (type === 'query') return 'READ';
  const method = (path.split('.')[1] ?? path).toLowerCase();
  if (/^(create|add|invite|send|upload|generate|assign|import|accept|join|new)/.test(method))
    return 'CREATE';
  if (/^(delete|remove|revoke|unsave|clear|leave|destroy)/.test(method)) return 'DELETE';
  if (
    /^(update|edit|set|move|toggle|rename|archive|unarchive|reorder|mark|approve|reject|change|pin|unpin|save|star|react|restore|read|complete|duplicate)/.test(
      method
    )
  )
    return 'UPDATE';
  return 'OTHER';
}

function categoryForScope(scope: string): string {
  const domain = scope.split(':')[0] ?? scope;
  const map: Record<string, string> = {
    tasks: 'TASK',
    projects: 'PROJECT',
    clients: 'CLIENT',
    finance: 'FINANCE',
    team: 'TEAM',
    meetings: 'MEETING',
  };
  return map[domain] ?? domain.toUpperCase();
}

function operationForMethod(method: string): AuditOperationT {
  switch (method.toUpperCase()) {
    case 'GET':
    case 'HEAD':
      return 'READ';
    case 'POST':
      return 'CREATE';
    case 'PUT':
    case 'PATCH':
      return 'UPDATE';
    case 'DELETE':
      return 'DELETE';
    default:
      return 'OTHER';
  }
}

/** Best-effort client IP from standard proxy headers (Vercel sets these). */
export function ipFromHeaders(headers: Headers | null | undefined): string | null {
  if (!headers) return null;
  const ip = clientIp(new Request('http://localhost', { headers }));
  return ip === 'unknown' ? null : ip;
}

function extractError(err: unknown): { code: string | null; message: string | null } {
  if (!err) return { code: null, message: null };
  if (typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown };
    return {
      code: typeof e.code === 'string' ? e.code : null,
      message: typeof e.message === 'string' ? e.message.slice(0, 1000) : null,
    };
  }
  return { code: null, message: String(err).slice(0, 1000) };
}

/** Audit entries for the audit viewer itself are excluded to avoid recursion noise. */
export function isAuditExcludedPath(path: string): boolean {
  return path.startsWith('audit.');
}

// ---------------------------------------------------------------------------
// before/after diffing (for instrumented mutations)
// ---------------------------------------------------------------------------

function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(toAuditJson(a)) === JSON.stringify(toAuditJson(b));
  } catch {
    return false;
  }
}

/**
 * Compute a field-level before -> after diff over `fields`. Returns null when
 * nothing changed. Use inside a mutation, then pass via `annotateAudit`.
 */
export function diffChanges<T extends Record<string, unknown>>(
  before: T | null | undefined,
  after: T | null | undefined,
  fields: (keyof T)[]
): Record<string, { before: unknown; after: unknown }> | null {
  if (!before || !after) return null;
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const f of fields) {
    if (!valueEquals(before[f], after[f])) {
      changes[String(f)] = { before: toAuditJson(before[f]), after: toAuditJson(after[f]) };
    }
  }
  return Object.keys(changes).length ? changes : null;
}

/**
 * Enrich the audit entry the tRPC middleware will write for the current call.
 * No-op outside a tRPC request (e.g. when invoked via the REST/SSR paths).
 */
export function annotateAudit(ctx: AuditContext, detail: AuditDetail): void {
  if (!ctx?.audit) return;
  const cur = ctx.audit.detail;
  const mergedChanges =
    detail.changes || cur.changes
      ? { ...(cur.changes ?? {}), ...(detail.changes ?? {}) }
      : undefined;
  const mergedMeta =
    detail.metadata || cur.metadata
      ? { ...(cur.metadata ?? {}), ...(detail.metadata ?? {}) }
      : undefined;
  Object.assign(cur, detail);
  if (mergedChanges) cur.changes = mergedChanges;
  if (mergedMeta) cur.metadata = mergedMeta;
}

// ---------------------------------------------------------------------------
// Low-level writer
// ---------------------------------------------------------------------------

export interface AuditRowInput {
  organizationId?: string | null;
  actorType?: AuditActorTypeT;
  actorId?: string | null;
  /**
   * The acting RestaurantStaffProfile id, set INSTEAD of `actorId` when the actor
   * is a terminal operator (`actorType = 'RESTAURANT_OPERATOR'`). An operator is
   * not a User, so it must not go through the `actorId` -> users FK. Mutually
   * exclusive with `actorId` (a DB CHECK enforces this).
   */
  actorStaffProfileId?: string | null;
  actorName?: string | null;
  actorEmail?: string | null;
  actorRole?: string | null;
  tokenId?: string | null;
  tokenName?: string | null;
  source: AuditSourceT;
  category: string;
  operation?: AuditOperationT;
  action: string;
  description?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  input?: unknown;
  changes?: unknown;
  result?: unknown;
  metadata?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  httpMethod?: string | null;
  path?: string | null;
  statusCode?: number | null;
  outcome?: AuditOutcomeT;
  errorCode?: string | null;
  errorMessage?: string | null;
  durationMs?: number | null;
}

/**
 * In production/development an audit write is fire-and-forget: a failure is
 * logged and swallowed so it can never roll back or fail the user's action.
 * In tests that swallow is a footgun — a broken write (e.g. an actor foreign-key
 * violation) would let a mutation "pass" while leaving ZERO durable audit rows.
 * Under Vitest we therefore DO NOT swallow: each write promise is tracked so a
 * test can `await flushAuditWritesForTest()` and see any rejection, and an
 * un-flushed failure surfaces as an unhandled rejection rather than vanishing.
 */
const AUDIT_FAIL_LOUD = process.env.NODE_ENV === 'test' || !!process.env.VITEST;

const pendingAuditWrites: Promise<unknown>[] = [];

/**
 * Test-only: await every audit write recorded since the last flush. Rejects with
 * the underlying error if any write failed (e.g. a P2003 FK violation), so a
 * DB-backed test can prove the row was actually persisted. No-op in production.
 */
export async function flushAuditWritesForTest(): Promise<void> {
  const inflight = pendingAuditWrites.splice(0);
  await Promise.all(inflight);
}

/**
 * Append one row to the audit log. Fire-and-forget — never blocks or rejects
 * the caller. The `as never` casts let us pass plain JSON into Prisma's `Json`
 * columns (same pattern as logActivity).
 */
export function recordAudit(row: AuditRowInput, db?: ScopedDb): void | Promise<void> {
  // Seed actors are uncommitted: their audit rows must share the transaction.
  // An explicit transaction is awaited and fails closed; normal writes keep
  // their existing independent, fire-and-forget behavior.
  if (db && !row.organizationId) {
    throw new Error('Transactional audit writes require a tenant organization.');
  }
  const writeTenant = async (tenantDb: ScopedDb) => {
    const placeholder = tenantDb.branchRegulatoryProfile
      ? await tenantDb.branchRegulatoryProfile.findFirst({
          where: { organizationId: row.organizationId!, isPlaceholder: true, effectiveTo: null },
          select: { id: true },
        })
      : null;
    return tenantDb.auditLog.create({
      data: {
        organizationId: row.organizationId!,
        actorType: row.actorType ?? 'USER',
        actorId: row.actorId ?? null,
        actorStaffProfileId: row.actorStaffProfileId ?? null,
        actorName: row.actorName ?? null,
        actorEmail: row.actorEmail ?? null,
        actorRole: row.actorRole ?? null,
        tokenId: row.tokenId ?? null,
        tokenName: row.tokenName ?? null,
        source: row.source,
        category: row.category,
        operation: row.operation ?? 'OTHER',
        action: row.action,
        description: row.description ?? null,
        targetType: row.targetType ?? null,
        targetId: row.targetId ?? null,
        targetLabel: row.targetLabel ?? null,
        input: (row.input ?? undefined) as never,
        changes: (row.changes ?? undefined) as never,
        result: (row.result ?? undefined) as never,
        metadata: {
          ...((row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as object),
          ...(placeholder ? { placeholder: true } : {}),
        } as never,
        ip: row.ip ?? null,
        userAgent: row.userAgent ?? null,
        httpMethod: row.httpMethod ?? null,
        path: row.path ?? null,
        statusCode: row.statusCode ?? null,
        outcome: row.outcome ?? 'SUCCESS',
        errorCode: row.errorCode ?? null,
        errorMessage: row.errorMessage ?? null,
        durationMs: row.durationMs ?? null,
      },
    });
  };
  if (db) return writeTenant(db).then(() => undefined);
  afterTenantTransaction(() => {
    const write = row.organizationId
      ? withTenantDb(row.organizationId, writeTenant, {
          maxWait: 1_000,
          timeout: 5_000,
          skipDrain: true,
        })
      : withPlatformDb((platformDb) =>
          platformDb.platformAuditLog.create({
            data: {
              actorTenantUserId: row.actorId ?? null,
              action: row.action,
              targetType: row.targetType ?? null,
              targetId: row.targetId ?? null,
              metadata: {
                source: row.source,
                category: row.category,
                operation: row.operation ?? 'OTHER',
                description: row.description ?? null,
                input: toAuditJson(row.input),
                outcome: row.outcome ?? 'SUCCESS',
              } as never,
              requestId: null,
              success: (row.outcome ?? 'SUCCESS') === 'SUCCESS',
              error: row.errorMessage ?? null,
              ip: row.ip ?? null,
              userAgent: row.userAgent ?? null,
            },
          })
        );

    if (AUDIT_FAIL_LOUD) {
      // Tests: do not swallow. Track so `flushAuditWritesForTest()` can await and
      // surface a rejection; an un-flushed failure still raises as unhandled.
      pendingAuditWrites.push(write);
      return;
    }

    void write.catch((err) => {
      console.error('[audit] failed to record', row.action, err);
    });
  });
}

// ---------------------------------------------------------------------------
// Capture-point adapters
// ---------------------------------------------------------------------------

/** Called by the tRPC audit middleware after each procedure resolves. */
export function recordTrpcAudit(args: {
  ctx: AuditContext;
  path: string;
  type: 'query' | 'mutation';
  input: unknown;
  outcome: AuditOutcomeT;
  error?: unknown;
  durationMs?: number;
}): void | Promise<void> {
  const user = args.ctx.session?.user ?? null;
  const detail = args.ctx.audit?.detail ?? {};
  const { code, message } = extractError(args.error);

  return recordAudit(
    {
      organizationId: user?.organizationId ?? null,
      actorType: user?.id ? 'USER' : 'ANONYMOUS',
      actorId: user?.id ?? null,
      actorName: user?.name ?? null,
      actorEmail: user?.email ?? null,
      actorRole: user?.role ?? null,
      source: 'TRPC',
      category: detail.category ?? categoryForPath(args.path),
      operation: detail.operation ?? operationForPath(args.path, args.type),
      action: detail.action ?? args.path,
      description: detail.description ?? null,
      targetType: detail.targetType ?? null,
      targetId: detail.targetId ?? null,
      targetLabel: detail.targetLabel ?? null,
      input: detail.skipInput ? '[skipped]' : toAuditJson(args.input),
      changes: detail.changes ? toAuditJson(detail.changes) : undefined,
      result: detail.result !== undefined ? toAuditJson(detail.result) : undefined,
      metadata: toAuditJson({
        ...(detail.metadata ?? {}),
        ...(user?.isSupportSession
          ? {
              supportSessionId: user.supportSessionId,
              platformUserId: user.platformUserId,
              actingAsTenantUserId: user.id,
            }
          : {}),
      }),
      ip: args.ctx.requestMeta?.ip ?? null,
      userAgent: args.ctx.requestMeta?.userAgent ?? null,
      path: args.path,
      outcome: args.outcome,
      errorCode: code,
      errorMessage: message,
      durationMs: args.durationMs ?? null,
    },
    args.ctx.audit?.db
  );
}

/**
 * Called by `withApiAuth` for every /api/v1 request (including auth failures).
 * The request body has already been consumed by the handler, so we capture the
 * method, path, query params, status and token-bound actor rather than the body.
 */
export function recordRestAudit(args: {
  request: Request;
  ctx: { userId: string; userRole: string; tokenId: string; organizationId: string } | null;
  scope: string;
  status: number;
  error?: unknown;
  durationMs?: number;
}): void {
  void (async () => {
    try {
      const url = new URL(args.request.url);
      const method = args.request.method.toUpperCase();

      let actorName: string | null = null;
      let actorEmail: string | null = null;
      let tokenName: string | null = null;
      if (args.ctx) {
        const [u, tk] = await withTenantDb(args.ctx.organizationId, (tenantDb) =>
          Promise.all([
            tenantDb.user.findUnique({
              where: { id: args.ctx!.userId },
              select: { name: true, email: true },
            }),
            tenantDb.apiToken.findUnique({
              where: { id: args.ctx!.tokenId },
              select: { name: true },
            }),
          ])
        );
        actorName = u?.name ?? null;
        actorEmail = u?.email ?? null;
        tokenName = tk?.name ?? null;
      }

      const outcome: AuditOutcomeT = args.status < 400 ? 'SUCCESS' : 'FAILURE';

      recordAudit({
        organizationId: args.ctx?.organizationId ?? null,
        actorType: args.ctx ? 'API_TOKEN' : 'ANONYMOUS',
        actorId: args.ctx?.userId ?? null,
        actorName,
        actorEmail,
        actorRole: args.ctx?.userRole ?? null,
        tokenId: args.ctx?.tokenId ?? null,
        tokenName,
        source: 'REST_API',
        category: categoryForScope(args.scope),
        operation: operationForMethod(method),
        action: `${method} ${url.pathname}`,
        description: tokenName ? `via API token "${tokenName}"` : null,
        ip: ipFromHeaders(args.request.headers),
        userAgent: args.request.headers.get('user-agent'),
        httpMethod: method,
        path: url.pathname,
        statusCode: args.status,
        metadata: {
          scope: args.scope,
          query: Object.fromEntries(url.searchParams),
        },
        outcome,
        errorMessage:
          outcome === 'FAILURE'
            ? (extractError(args.error).message ?? `HTTP ${args.status}`)
            : null,
        durationMs: args.durationMs ?? null,
      });
    } catch (e) {
      console.error('[audit] failed to record REST call', e);
    }
  })();
}

/** Called by NextAuth for authentication events. */
export function recordAuthAudit(args: {
  type: 'LOGIN' | 'LOGOUT' | 'LOGIN_FAILED';
  organizationId?: string | null;
  userId?: string | null;
  name?: string | null;
  email?: string | null;
  role?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  reason?: string | null;
}): void {
  const outcome: AuditOutcomeT = args.type === 'LOGIN_FAILED' ? 'FAILURE' : 'SUCCESS';
  const action =
    args.type === 'LOGIN'
      ? 'auth.login'
      : args.type === 'LOGOUT'
        ? 'auth.logout'
        : 'auth.loginFailed';

  recordAudit({
    organizationId: args.organizationId ?? null,
    actorType: args.userId ? 'USER' : 'ANONYMOUS',
    actorId: args.userId ?? null,
    actorName: args.name ?? null,
    actorEmail: args.email ?? null,
    actorRole: args.role ?? null,
    source: 'AUTH',
    category: 'AUTH',
    operation: args.type,
    action,
    description:
      args.type === 'LOGIN_FAILED'
        ? `Failed login for ${args.email ?? 'unknown'}`
        : args.type === 'LOGIN'
          ? 'Signed in'
          : 'Signed out',
    targetType: args.userId ? 'User' : null,
    targetId: args.userId ?? null,
    targetLabel: args.name ?? args.email ?? null,
    metadata: args.reason ? { reason: args.reason } : undefined,
    ip: args.ip ?? null,
    userAgent: args.userAgent ?? null,
    outcome,
    errorMessage: args.type === 'LOGIN_FAILED' ? (args.reason ?? 'Invalid credentials') : null,
  });
}
