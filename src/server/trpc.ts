import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { can, subjectFromSession, ACTIVE_STATUSES, type Action } from '@/lib/abac';
import {
  type AuditDetail,
  ipFromHeaders,
  isAuditExcludedPath,
  recordTrpcAudit,
} from '@/server/audit';

/**
 * The fetch adapter passes `{ req }` to createContext; the RSC SSR helper calls
 * it with no args. We capture request metadata (IP, user-agent) when present so
 * the audit layer can record *where* an action came from.
 */
export const createTRPCContext = async (opts?: { req?: Request }) => {
  const session = await auth();
  const headers = opts?.req?.headers ?? null;

  return {
    db,
    session,
    requestMeta: {
      ip: ipFromHeaders(headers),
      userAgent: headers?.get('user-agent') ?? null,
    },
    // Mutable per-request holder. A mutation can enrich its own audit entry via
    // `annotateAudit(ctx, {...})`; the audit middleware reads this after the
    // resolver runs. Stays a stable reference across middleware `ctx` spreads.
    audit: { detail: {} as AuditDetail },
  };
};

export type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape }) {
    return shape;
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

// Reject sessions whose backing account has been deactivated. `status` is
// refreshed from the DB on each request by the NextAuth jwt() callback, so a
// deactivated/deleted user is locked out within the revalidation window even
// though sessions are stateless JWTs. Undefined status (legacy token, before
// the next jwt() refresh) is tolerated — it is populated on the next request.
function assertActive(user: { status?: string | null }) {
  // ACTIVE and ON_LEAVE may use the app; INACTIVE / INVITED / DELETED may not.
  // (Allow-list via ABAC's ACTIVE_STATUSES so it stays consistent everywhere.)
  if (user.status && !ACTIVE_STATUSES.has(user.status)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Your account is no longer active.' });
  }
}

/**
 * Audit middleware. Installed as the OUTERMOST middleware on protected/admin
 * procedures so it wraps the auth checks — meaning even FORBIDDEN/UNAUTHORIZED
 * attempts are recorded (with whatever actor the session carries).
 *
 * - Mutations are always audited.
 * - Reads are audited only when `auditReads` is set (used by adminProcedure, so
 *   that sensitive admin reads — finance, insights, HR — leave a trail). The
 *   audit viewer's own queries are excluded to avoid recursion noise.
 */
function auditMiddleware(opts: { auditReads: boolean }) {
  return t.middleware(async ({ ctx, next, path, type, getRawInput }) => {
    const wantAudit =
      (type === 'mutation' || (opts.auditReads && type === 'query')) && !isAuditExcludedPath(path);

    if (!wantAudit) return next();

    const start = Date.now();
    let rawInput: unknown;
    try {
      rawInput = await getRawInput();
    } catch {
      rawInput = undefined;
    }

    // tRPC middleware does not throw on resolver errors — it returns a result
    // discriminated by `ok`. We record either way, then pass the result through.
    const result = await next();

    recordTrpcAudit({
      ctx,
      path,
      type,
      input: rawInput,
      outcome: result.ok ? 'SUCCESS' : 'FAILURE',
      error: result.ok ? undefined : result.error,
      durationMs: Date.now() - start,
    });

    return result;
  });
}

const auditMutations = auditMiddleware({ auditReads: false });
const auditAll = auditMiddleware({ auditReads: true });

// Auth guard for any logged-in, active account.
const requireActiveUser = t.middleware(async ({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to access this resource',
    });
  }
  assertActive(ctx.session.user);
  return next({ ctx: { ...ctx, session: ctx.session } });
});

// Capability guard — the ABAC engine is the single decision point. The role is
// re-read from the DB by the jwt() callback, so a demoted user loses access
// within the revalidation window. Resource-level conditions (e.g. "this
// resignation is PENDING and not your own") are checked INSIDE the resolver via
// a second `can(...)` call with the loaded resource's attributes.
function requireCapability(action: Action) {
  return t.middleware(async ({ ctx, next }) => {
    if (!ctx.session?.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You must be logged in to access this resource',
      });
    }
    assertActive(ctx.session.user);
    const subject = subjectFromSession(ctx.session.user);
    const allowed = await can(subject, action, undefined, {
      source: 'TRPC',
      ip: ctx.requestMeta.ip,
    });
    if (!allowed) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission for this action.' });
    }
    return next({ ctx: { ...ctx, session: ctx.session } });
  });
}

// Protected procedure — audit (outer) wraps the auth guard.
export const protectedProcedure = t.procedure.use(auditMutations).use(requireActiveUser);

// Admin-only procedure — now backed by the ABAC engine (policy: 'admin:access' =
// role ADMIN). Identical behaviour to the previous literal check, but the
// decision flows through the one engine. Audits mutations AND sensitive reads.
export const adminProcedure = t.procedure.use(auditAll).use(requireCapability('admin:access'));

// HR console procedure — ADMIN or HR (policy: 'hr:access').
export const hrProcedure = t.procedure.use(auditAll).use(requireCapability('hr:access'));

/**
 * Generic capability-gated procedure. Use for any action in the ABAC catalogue,
 * e.g. `capabilityProcedure('resignation:readAll')`. Audits like adminProcedure.
 */
export function capabilityProcedure(action: Action) {
  return t.procedure.use(auditAll).use(requireCapability(action));
}
