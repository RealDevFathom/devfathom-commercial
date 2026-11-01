import { initTRPC, TRPCError } from '@trpc/server';
import type { Session } from 'next-auth';
import { Prisma } from '@/generated/prisma/client';
import superjson from 'superjson';
import { can, subjectFromSession, type Action } from '@/lib/abac';
import {
  evaluateSessionUser,
  TEMPORARY_PASSWORD_MESSAGE,
  temporaryPasswordBlocks,
  type SessionUserState,
} from '@/lib/auth/session-state';
import { createTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TenantOrganization } from '@/lib/tenancy/host';
import type { SupportIdentity } from '@/lib/tenancy/support-session';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { alternativeModulesForProcedure, moduleForProcedure } from '@/lib/module-catalog';
import { formatValidationError } from '@/lib/validation-error';
import {
  type AuditDetail,
  ipFromHeaders,
  isAuditExcludedPath,
  recordTrpcAudit,
} from '@/server/audit';
import { DEMO_UNAVAILABLE_MESSAGE, isDemoProcedureBlocked } from '@/lib/tenancy/demo-isolation';

/**
 * The fetch adapter passes `{ req }` to createContext; the RSC SSR helper calls
 * it with no args. We capture request metadata (IP, user-agent) when present so
 * the audit layer can record *where* an action came from.
 */
export const createTRPCContext = async (opts?: {
  req?: Request;
  session?: Session | null;
  db?: ScopedDb;
  /** Bind seed audit rows to the transaction that creates their actor. */
  auditDb?: ScopedDb;
  organization?: TenantOrganization;
  support?: SupportIdentity | null;
}) => {
  // Route adapters can execute their context factory after Next's request
  // AsyncLocalStorage scope has been released. When the route already resolved
  // the session, use it instead of calling auth() again outside request scope.
  const explicitSession = opts && 'session' in opts ? opts.session : undefined;
  const actor =
    explicitSession !== undefined && opts?.organization
      ? null
      : await resolveTenantActor(
          explicitSession === undefined
            ? { request: opts?.req }
            : { request: opts?.req, session: explicitSession }
        );
  const session = explicitSession !== undefined ? explicitSession : (actor?.session ?? null);
  const organization = opts?.organization ?? actor?.organization ?? null;
  const headers = opts?.req?.headers ?? null;
  const organizationId = organization?.id ?? session?.user?.organizationId;
  if (!organizationId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found.' });
  }
  const scopedDb = opts?.db ?? createTenantDb(organizationId, session?.user?.id);
  if (opts?.auditDb && opts.auditDb !== scopedDb) {
    throw new Error('Audit transaction must match the context transaction.');
  }
  const entitlements = await resolveOrganizationEntitlements(organizationId, scopedDb);

  return {
    db: scopedDb,
    entitlements,
    session,
    organization,
    support: opts?.support ?? actor?.support ?? null,
    requestMeta: {
      ip: ipFromHeaders(headers),
      userAgent: headers?.get('user-agent') ?? null,
    },
    // Mutable per-request holder. A mutation can enrich its own audit entry via
    // `annotateAudit(ctx, {...})`; the audit middleware reads this after the
    // resolver runs. Stays a stable reference across middleware `ctx` spreads.
    audit: { detail: {} as AuditDetail, ...(opts?.auditDb ? { db: opts.auditDb } : {}) },
  };
};

export type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

/** What a client is told instead of an unexpected failure's own message. */
const INTERNAL_ERROR_MESSAGE = 'Something went wrong on our side. Please try again.';

const PRISMA_ERROR_MESSAGES = {
  P2025: { code: -32004, trpcCode: 'NOT_FOUND', httpStatus: 404, message: 'Record not found.' },
  P2002: {
    code: -32009,
    trpcCode: 'CONFLICT',
    httpStatus: 409,
    message: 'A record with those details already exists.',
  },
  P2003: {
    code: -32009,
    trpcCode: 'CONFLICT',
    httpStatus: 409,
    message: 'This change conflicts with a related record.',
  },
} as const;

/** Distinguish unexpected failures from deliberately worded TRPCErrors. */
function isUnexpectedInternalError(error: TRPCError): boolean {
  const cause = error.cause;
  return (
    error.code === 'INTERNAL_SERVER_ERROR' &&
    cause !== undefined &&
    !(cause instanceof TRPCError) &&
    error.message === cause.message
  );
}

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    // Input validation remains friendly. Raw schema failures in a resolver are
    // internal errors, not input validation, and must not expose field names.
    const validation = error.code === 'BAD_REQUEST' ? formatValidationError(error.cause) : null;
    const isPrismaError = error.cause instanceof Prisma.PrismaClientKnownRequestError;
    const prismaError = isPrismaError
      ? PRISMA_ERROR_MESSAGES[error.cause!.code as keyof typeof PRISMA_ERROR_MESSAGES]
      : undefined;
    // The route's onError logger retains original diagnostics server-side.
    const withheld = isPrismaError || isUnexpectedInternalError(error);
    const data = { ...shape.data, validation: validation?.fields ?? null };
    delete data.stack;
    if (prismaError) {
      data.code = prismaError.trpcCode;
      data.httpStatus = prismaError.httpStatus;
    }
    return {
      ...shape,
      code: prismaError?.code ?? shape.code,
      message:
        prismaError?.message ??
        (withheld ? INTERNAL_ERROR_MESSAGE : (validation?.message ?? shape.message)),
      data,
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * Reject any session that is not provably usable (#16).
 *
 * The previous guard was `if (user.status && !ACTIVE_STATUSES.has(user.status))`
 * — it only fired when `status` was TRUTHY, so a session carrying no status at
 * all passed straight through. That is the fail-open the QA report exercised: a
 * revoked token read and wrote tenant data while `/api/auth/session` reported it
 * revoked.
 *
 * `evaluateSessionUser` fails CLOSED, and is the same decision the `/(app)` page
 * guard uses, so the API and the page cannot disagree about one session. A dead
 * session gets 401 (sign in again); an inactive account or an unavailable
 * workspace gets 403 (a person, not a re-login, must fix it).
 */
function assertSessionUsable(user: SessionUserState) {
  const verdict = evaluateSessionUser(user);
  if (verdict.ok) return;
  throw new TRPCError({
    code: verdict.kind === 'session-ended' ? 'UNAUTHORIZED' : 'FORBIDDEN',
    message: verdict.message,
  });
}

function assertTemporaryPasswordChanged(
  user: { mustChangePassword?: boolean | null },
  path: string
) {
  if (!temporaryPasswordBlocks(user, path)) return;
  throw new TRPCError({ code: 'FORBIDDEN', message: TEMPORARY_PASSWORD_MESSAGE });
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

    await recordTrpcAudit({
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
function assertDemoProcedureAllowed(
  ctx: TRPCContext,
  path: string,
  type: 'query' | 'mutation' | 'subscription'
) {
  if (ctx.organization?.isDemo && type !== 'subscription' && isDemoProcedureBlocked(path, type)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: DEMO_UNAVAILABLE_MESSAGE });
  }
}

const requireActiveUser = t.middleware(async ({ ctx, next, path, type }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to access this resource',
    });
  }
  assertSessionUsable(ctx.session.user);
  assertTemporaryPasswordChanged(ctx.session.user, path);
  assertDemoProcedureAllowed(ctx, path, type);
  return next({ ctx: { ...ctx, session: ctx.session } });
});

/**
 * The entitlement refusal for `moduleKey`, worded with the catalog name. Used by
 * the procedure-level gate below and by resolvers whose licence depends on the
 * input (e.g. `team.getById`: reading your own profile is account self-service,
 * reading another member is the licensed team directory).
 */
export function assertModuleLicensed(
  ctx: Pick<TRPCContext, 'entitlements'>,
  moduleKey: string
): void {
  if (hasModule(ctx.entitlements, moduleKey)) return;
  const moduleName = ctx.entitlements.modules.find((module) => module.key === moduleKey)?.name;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: `The ${moduleName ?? moduleKey} module is not enabled for this organization.`,
  });
}

const requireLicensedModule = t.middleware(async ({ ctx, next, path }) => {
  const moduleKey = moduleForProcedure(path);
  if (
    moduleKey &&
    !hasModule(ctx.entitlements, moduleKey) &&
    !alternativeModulesForProcedure(path).some((alternative) =>
      hasModule(ctx.entitlements, alternative)
    )
  ) {
    assertModuleLicensed(ctx, moduleKey);
  }
  return next();
});

// Capability guard — the ABAC engine is the single decision point. The role is
// re-read from the DB by the jwt() callback, so a demoted user loses access
// within the revalidation window. Resource-level conditions (e.g. "this
// resignation is PENDING and not your own") are checked INSIDE the resolver via
// a second `can(...)` call with the loaded resource's attributes.
function requireCapability(action: Action) {
  return t.middleware(async ({ ctx, next, path, type }) => {
    if (!ctx.session?.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You must be logged in to access this resource',
      });
    }
    assertSessionUsable(ctx.session.user);
    assertTemporaryPasswordChanged(ctx.session.user, path);
    assertDemoProcedureAllowed(ctx, path, type);
    const subject = subjectFromSession(ctx.session.user);
    const allowed = await can(subject, action, undefined, {
      db: ctx.db as Prisma.TransactionClient,
      source: 'TRPC',
      ip: ctx.requestMeta.ip,
    });
    if (!allowed) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          action === 'pharmacy:dispense'
            ? 'Selling a prescription-only or restricted medicine needs the pharmacist dispensing permission.'
            : 'You do not have permission for this action.',
      });
    }
    return next({ ctx: { ...ctx, session: ctx.session } });
  });
}

// Protected procedure — audit (outer) wraps the auth guard.
export const protectedProcedure = t.procedure
  .use(auditMutations)
  .use(requireActiveUser)
  .use(requireLicensedModule);

/** Authenticated, module-aware procedure for sensitive tenant reads. */
export const auditedProtectedProcedure = t.procedure
  .use(auditAll)
  .use(requireActiveUser)
  .use(requireLicensedModule);

/** Authenticated, audited tenant access to retained history after entitlement removal. */
export const entitlementIndependentHistoryProcedure = t.procedure
  .use(auditAll)
  .use(requireActiveUser);

// Admin-only procedure — now backed by the ABAC engine (policy: 'admin:access' =
// role ADMIN). Identical behaviour to the previous literal check, but the
// decision flows through the one engine. Audits mutations AND sensitive reads.
export const adminProcedure = t.procedure
  .use(auditAll)
  .use(requireCapability('admin:access'))
  .use(requireLicensedModule);

/**
 * Admin procedure for entitlement-independent inspection and cleanup only.
 * Keeps active-session, ADMIN capability, tenant scope, and audit enforcement;
 * deliberately omits only the module entitlement check.
 */
export const entitlementIndependentAdminProcedure = t.procedure
  .use(auditAll)
  .use(requireCapability('admin:access'));

// HR console procedure — ADMIN or HR (policy: 'hr:access').
export const hrProcedure = t.procedure
  .use(auditAll)
  .use(requireCapability('hr:access'))
  .use(requireLicensedModule);

/**
 * Generic capability-gated procedure. Use for any action in the ABAC catalogue,
 * e.g. `capabilityProcedure('resignation:readAll')`. Audits like adminProcedure.
 */
export function capabilityProcedure(action: Action) {
  return t.procedure.use(auditAll).use(requireCapability(action)).use(requireLicensedModule);
}
