import { afterTenantTransaction } from '@/lib/side-effects/scope';
import { clientIp } from '@/lib/rate-limit';
import { type ScopedDb, withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import { auditActorBranches } from '@/server/audit-actor-branches';

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
  // Match PIN keys exactly or as a suffix (approvalPin) so unrelated keys such
  // as shippingAddress remain useful. Camera gateway base URLs are rejected when
  // they carry credentials or an address, but a rejected value is still audited;
  // never retain it (DEV-740).
  return (
    k === 'pin' ||
    k.endsWith('pin') ||
    k === 'previousgrantid' ||
    k === 'baseurl' ||
    // DEV-875: a rejected bank-transfer reference may be a card number typed by mistake.
    k === 'providerref' ||
    // Cash-memo buyer text can reach validation-failure audit before its resolver.
    k === 'buyername' ||
    // DEV-743: a card-terminal review's slip reference and reason are typed by hand and may hold
    // a card number by mistake; the service refuses one, but raw input is audited before that.
    k === 'slipref' ||
    k === 'resolutionreason' ||
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
  /**
   * DEV-937: the branches the tRPC recorder took from the request (or, on a
   * refusal, from a handler's note), in the order it reads them. The writer
   * keeps one only where the person may act.
   */
  verifyBranchIds?: string[];
}

/**
 * DEV-937: a branch taken from the request is only what the person named: the
 * raw input, read before the procedure's schema drops keys it does not know, or
 * a handler's note made before a refusal. A person could plant entries in
 * another branch's log by naming it. The entry is placed at the first of those
 * branches the person may act at: one they are actively assigned to, or any
 * branch for the owner and an active ADMIN (the counter's branch gate). When
 * there is none, the first named branch is kept as `requestedBranchId`, for the
 * owner, and the entry is placed at the branches the person works at
 * (`actorBranchIds`), so their own managers see it and the named branch's do
 * not. Branches that are not this workspace's pharmacy branches are left as
 * they were: no branch-limited reader can match them.
 */
async function verifiedBranchMetadata(
  tenantDb: ScopedDb,
  row: AuditRowInput
): Promise<Record<string, unknown>> {
  const metadata = {
    ...((row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as Record<
      string,
      unknown
    >),
  };
  const named = [...new Set(row.verifyBranchIds ?? [])];
  if (!named.length || !row.organizationId || !tenantDb.pharmacyBranch) return metadata;
  const found = await tenantDb.pharmacyBranch.findMany({
    where: { organizationId: row.organizationId, id: { in: named } },
    select: { id: true },
  });
  const pharmacyBranches = new Set(found.map((branch) => branch.id));
  const candidates = named.filter((id) => pharmacyBranches.has(id));
  if (!candidates.length) return metadata;
  const actor = row.actorId
    ? await auditActorBranches(tenantDb, row.organizationId, row.actorId)
    : { all: false, anyBranch: false, branchIds: [] as string[] };
  const actedAt = candidates.find((id) => actor.anyBranch || actor.branchIds.includes(id));
  if (actedAt) return { ...metadata, branchId: actedAt };
  delete metadata.branchId;
  return { ...metadata, requestedBranchId: candidates[0], actorBranchIds: actor.branchIds };
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
          ...((row.verifyBranchIds?.length
            ? await verifiedBranchMetadata(tenantDb, row)
            : row.metadata && typeof row.metadata === 'object'
              ? row.metadata
              : {}) as object),
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

const AUDIT_BRANCH_ID = /^[A-Za-z0-9_-]{1,64}$/;

function branchIdFrom(value: unknown): string | null {
  return typeof value === 'string' && AUDIT_BRANCH_ID.test(value) ? value : null;
}

/**
 * DEV-913: the branch an action was taken at, recorded on the row as
 * `metadata.branchId` so the audit log can be filtered and scoped by branch.
 * An annotation wins; otherwise the request's own `branchId` (or the
 * `pharmacyBranchId` the procedures take), or the `scope.branchId` some
 * pharmacy procedures take. Never guessed from anything
 * else, so an entry without a branch stays workspace-wide.
 */
export function auditBranchId(input: unknown, detail?: AuditDetail): string | null {
  const annotated = branchIdFrom(detail?.metadata?.branchId);
  if (annotated) return annotated;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const direct = branchIdFrom(record.branchId) ?? branchIdFrom(record.pharmacyBranchId);
  if (direct) return direct;
  const scope = record.scope;
  return scope && typeof scope === 'object' && !Array.isArray(scope)
    ? branchIdFrom((scope as Record<string, unknown>).branchId)
    : null;
}

/**
 * DEV-937: every branch the raw request names, most specific first: the
 * `pharmacyBranchId` and `scope.branchId` that pharmacy procedures declare, then
 * a bare top-level `branchId`. The audit middleware wraps the procedure, so it
 * sees the input before the schema drops keys it does not declare; a bare
 * `branchId` added to a request that names its branch another way therefore
 * never wins. The writer checks each in this order and places the entry at the
 * first the person may act at. A record's own tag (`annotateAuditBranch`) is
 * read before any of these.
 */
export function auditRequestBranchIds(input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  const scope = record.scope;
  const scoped =
    scope && typeof scope === 'object' && !Array.isArray(scope)
      ? (scope as Record<string, unknown>).branchId
      : undefined;
  return [
    ...new Set(
      [record.pharmacyBranchId, scoped, record.branchId]
        .map(branchIdFrom)
        .filter((id): id is string => !!id)
    ),
  ];
}

/** Called by the tRPC audit middleware after each procedure resolves. */
/**
 * DEV-961: procedures whose input carries an approval secret under a key the redaction above
 * does not cover (a recovery code, an authenticator code), and whose input is recorded even
 * when the call is refused before its resolver runs (session checks, the set-up gate, input
 * validation, a rate limit). Their input is never recorded, whatever the outcome.
 */
const SECRET_INPUT_PATHS: ReadonlySet<string> = new Set([
  'approvalAuthenticator.beginEnrollment',
  'approvalAuthenticator.confirmEnrollment',
  'approvalAuthenticator.useRecoveryCode',
  'approvalAuthenticator.resetForMember',
  'approvalAuthenticator.setRequired',
]);

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
  const branchId = auditBranchId(args.input, detail);
  // DEV-937: a handler's or record's tag on a successful action stands; any
  // branch the request itself named, and every tag on a refusal, is checked.
  const annotated = branchIdFrom(detail.metadata?.branchId);
  const verifyBranchIds = annotated
    ? args.outcome === 'FAILURE'
      ? [annotated]
      : []
    : auditRequestBranchIds(args.input);

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
      input:
        detail.skipInput || SECRET_INPUT_PATHS.has(args.path)
          ? '[skipped]'
          : toAuditJson(args.input),
      changes: detail.changes ? toAuditJson(detail.changes) : undefined,
      result: detail.result !== undefined ? toAuditJson(detail.result) : undefined,
      metadata: toAuditJson({
        ...(detail.metadata ?? {}),
        ...(branchId ? { branchId } : {}),
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
      ...(verifyBranchIds.length ? { verifyBranchIds } : {}),
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
