import { initTRPC, TRPCError } from '@trpc/server';
import type { Session } from 'next-auth';
import type { Prisma } from '@/generated/prisma/client';
import superjson from 'superjson';
import { can, subjectFromSession, type Action } from '@/lib/abac';
import {
  APPROVAL_AUTHENTICATOR_SETUP_MESSAGE,
  approvalAuthenticatorSetupBlocks,
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
import { isPrismaError, mapPrismaError } from '@/server/trpc-database-errors';
import { mapAccountingPeriodError } from '@/server/trpc-period-errors';
import { refusalReasonOf } from '@/server/refusal-reason';
import { tagProcedureGate, type ProcedureGateTag } from '@/server/procedure-gate-tag';

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

/** What a production client is told instead of an unexpected failure's own message. */
const INTERNAL_ERROR_MESSAGE = 'Something went wrong on our side. Please try again.';

/**
 * An INTERNAL_SERVER_ERROR that tRPC made out of something a procedure threw
 * that was not a TRPCError (an unmapped Prisma or driver error, a raw
 * `schema.parse()`): tRPC gives that wrapper the thrown error's own message,
 * which can name SQL, constraints and tables. A TRPCError thrown on purpose
 * carries words of its own, so it never matches, internal or not.
 */
function isUnexpectedInternalError(error: TRPCError): boolean {
  const cause = error.cause;
  return (
    error.code === 'INTERNAL_SERVER_ERROR' &&
    cause !== undefined &&
    !(cause instanceof TRPCError) &&
    error.message === cause.message
  );
}

/**
 * Per-procedure metadata. `capabilities` is the explicit permission annotation
 * `denyByDefaultProcedure` reads: every listed ABAC action must allow the caller.
 * A procedure built on that base with no annotation is refused (#979, PR J).
 */
export type ProcedureMeta = {
  capabilities?: readonly Action[];
};

const t = initTRPC
  .context<TRPCContext>()
  .meta<ProcedureMeta>()
  .create({
    transformer: superjson,
    errorFormatter({ shape, error }) {
      // tRPC sets `cause` to a ZodError for input-validation failures (BAD_REQUEST)
      // *and* for a raw `schema.parse()` that throws inside a procedure body
      // (INTERNAL_SERVER_ERROR). Gate on the code so an internal failure never
      // reaches the client wearing a field-level message, and never publishes
      // internal schema field names in `data.validation`.
      //
      // The first half is narrower than it reads: tRPC has already placed the raw
      // serialized ZodError into `shape.message` before this formatter runs, and
      // with `validation` null we pass `shape.message` through unchanged — so,
      // outside production, the field name still reaches the client, in raw
      // serialized form (the errorFormatter test pins exactly that string,
      // `"path": ["internalOnlyField"]` and all). The gate governs `data.validation`
      // and the FORMATTED message, not the pass-through.
      const validation = error.code === 'BAD_REQUEST' ? formatValidationError(error.cause) : null;
      // In production an unexpected failure (that ZodError included) keeps its own
      // message on the server, where the tRPC route's `onError` logs it, and the
      // client is told only that something went wrong. Deliberate errors and every
      // other code are untouched; outside production the pass-through is unchanged.
      // A Prisma error's message names the ORM, the model and the operation, so it
      // is withheld in every environment, not only production (#318).
      const withheld =
        isUnexpectedInternalError(error) &&
        (process.env.NODE_ENV === 'production' || isPrismaError(error.cause));
      // Never publish the server stack. tRPC attaches `data.stack` outside
      // production, which leaks file paths and bundle chunk names onto ordinary
      // client errors (e.g. an intentional 403). Drop it for every error code.
      // DEV-860: a deliberate refusal may name its reason (`RefusalReason`) next to its
      // words, so the client can say what is missing. Absent on every other error.
      const reason = refusalReasonOf(error.cause);
      const data = {
        ...shape.data,
        validation: validation?.fields ?? null,
        ...(reason ? { reason } : {}),
      };
      delete data.stack;
      return {
        ...shape,
        message: withheld ? INTERNAL_ERROR_MESSAGE : (validation?.message ?? shape.message),
        data,
      };
    },
  });

export const router = t.router;

/** DEV-959B: name the gate a middleware enforces, so a test can read it from a procedure. */
function gated<M extends { _middlewares: readonly object[] }>(
  middleware: M,
  tag: ProcedureGateTag
): M {
  for (const fn of middleware._middlewares) tagProcedureGate(fn, tag);
  return middleware;
}

/**
 * Outermost middleware on every procedure: a known Prisma request error that
 * escaped a resolver (a stale-record update or delete, a unique or foreign-key
 * violation) becomes a typed error with user-facing words — NOT_FOUND, CONFLICT
 * or BAD_REQUEST — instead of a 500 carrying Prisma's own message (#318).
 * DEV-877: a posting refused because its accounting period is closed becomes
 * BAD_REQUEST `PERIOD_CLOSED` on every router that can post a journal entry.
 */
const mapDatabaseErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (result.ok) return result;
  const mapped = mapAccountingPeriodError(result.error) ?? mapPrismaError(result.error);
  if (mapped) throw mapped;
  return result;
});

const baseProcedure = t.procedure.use(mapDatabaseErrors);

export const publicProcedure = baseProcedure;

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
 * DEV-961: a member who can approve and has not set up their approval authenticator, while
 * the organization requires one, may call only the set-up procedures. Checked per procedure,
 * so a batch, a server action or a server-side caller cannot reach anything else.
 */
function assertApprovalAuthenticatorSetUp(
  user: { approvalAuthenticatorSetupRequired?: boolean | null },
  path: string
) {
  if (!approvalAuthenticatorSetupBlocks(user, path)) return;
  throw new TRPCError({ code: 'FORBIDDEN', message: APPROVAL_AUTHENTICATOR_SETUP_MESSAGE });
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

/** The middleware functions that write the audit entry, for `procedureWritesAudit`. */
const AUDIT_MIDDLEWARES: ReadonlySet<unknown> = new Set([
  ...auditMutations._middlewares,
  ...auditAll._middlewares,
]);

/**
 * DEV-913: does calling this procedure write an audit entry? True when its
 * middleware chain runs the audit middleware (every procedure built on
 * `protectedProcedure`, `adminProcedure`, `capabilityProcedure`,
 * `denyByDefaultProcedure` and friends does; `publicProcedure` does not). The
 * pharmacy guard test asks this of every pharmacy mutation.
 */
export function procedureWritesAudit(procedure: {
  _def: { middlewares: readonly unknown[] };
}): boolean {
  return procedure._def.middlewares.some((middleware) => AUDIT_MIDDLEWARES.has(middleware));
}

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

const requireActiveUser = gated(
  t.middleware(async ({ ctx, next, path, type }) => {
    if (!ctx.session?.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You must be logged in to access this resource',
      });
    }
    assertSessionUsable(ctx.session.user);
    assertTemporaryPasswordChanged(ctx.session.user, path);
    assertApprovalAuthenticatorSetUp(ctx.session.user, path);
    assertDemoProcedureAllowed(ctx, path, type);
    return next({ ctx: { ...ctx, session: ctx.session } });
  }),
  { kind: 'signed-in' }
);

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

/** The refusal for a missing capability, shared by every capability guard below. */
function capabilityRefusal(action: Action, refusalMessage?: string) {
  return new TRPCError({
    code: 'FORBIDDEN',
    message:
      refusalMessage ??
      (action === 'pharmacy:dispense'
        ? 'Selling a prescription-only or restricted medicine needs the pharmacist dispensing permission.'
        : 'You do not have permission for this action.'),
  });
}

/**
 * Session, temporary-password and demo checks, then every action in `actions`
 * through the ABAC engine. All must allow; the first refusal wins.
 */
async function assertCapabilities(
  ctx: TRPCContext,
  path: string,
  type: 'query' | 'mutation' | 'subscription',
  actions: readonly Action[],
  refusalMessage?: string
): Promise<Session> {
  const session = ctx.session;
  if (!session?.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to access this resource',
    });
  }
  // Empty actor id must fail closed before any ABAC/DB lookup (#994 / DEV-17).
  if (!session.user.id) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
  }
  assertSessionUsable(session.user);
  assertTemporaryPasswordChanged(session.user, path);
  assertApprovalAuthenticatorSetUp(session.user, path);
  assertDemoProcedureAllowed(ctx, path, type);
  const subject = subjectFromSession(session.user);
  for (const action of actions) {
    const allowed = await can(subject, action, undefined, {
      db: ctx.db as Prisma.TransactionClient,
      source: 'TRPC',
      ip: ctx.requestMeta.ip,
    });
    if (!allowed) throw capabilityRefusal(action, refusalMessage);
  }
  return session;
}

// Capability guard — the ABAC engine is the single decision point. The role is
// re-read from the DB by the jwt() callback, so a demoted user loses access
// within the revalidation window. Resource-level conditions (e.g. "this
// resignation is PENDING and not your own") are checked INSIDE the resolver via
// a second `can(...)` call with the loaded resource's attributes.
function requireCapability(action: Action, refusalMessage?: string) {
  return gated(
    t.middleware(async ({ ctx, next, path, type }) => {
      const session = await assertCapabilities(ctx, path, type, [action], refusalMessage);
      return next({ ctx: { ...ctx, session } });
    }),
    { kind: 'capability', action }
  );
}

/**
 * Deny-by-default guard: the procedure must carry `.meta({ capabilities })`
 * naming at least one ABAC action, and the caller must hold every one of them.
 * A procedure that forgot its annotation is refused for everybody — nobody
 * reaches it on authentication and module entitlement alone.
 */
const requireDeclaredCapabilities = gated(
  t.middleware(async ({ ctx, next, path, type, meta }) => {
    const actions = meta?.capabilities ?? [];
    if (actions.length === 0) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'You do not have permission for this action.',
      });
    }
    const session = await assertCapabilities(ctx, path, type, actions);
    const organizationId = ctx.entitlements?.organizationId;
    if (
      !organizationId ||
      session.user.organizationId !== organizationId ||
      !(await ctx.db.user.findUnique({
        where: { id: session.user.id, organizationId, status: 'ACTIVE' },
        select: { id: true },
      }))
    ) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'No active tenant actor on this request.',
      });
    }
    return next({ ctx: { ...ctx, session } });
  }),
  { kind: 'declared' }
);

// Protected procedure — audit (outer) wraps the auth guard.
export const protectedProcedure = baseProcedure
  .use(auditMutations)
  .use(requireActiveUser)
  .use(requireLicensedModule);

/** Authenticated, module-aware procedure for sensitive tenant reads. */
export const auditedProtectedProcedure = baseProcedure
  .use(auditAll)
  .use(requireActiveUser)
  .use(requireLicensedModule);

/** Authenticated, audited tenant access to retained history after entitlement removal. */
export const entitlementIndependentHistoryProcedure = baseProcedure
  .use(auditAll)
  .use(requireActiveUser);

// Admin-only procedure — now backed by the ABAC engine (policy: 'admin:access' =
// role ADMIN). Identical behaviour to the previous literal check, but the
// decision flows through the one engine. Audits mutations AND sensitive reads.
export const adminProcedure = baseProcedure
  .use(auditAll)
  .use(requireCapability('admin:access'))
  .use(requireLicensedModule);

/**
 * Admin procedure for entitlement-independent inspection and cleanup only.
 * Keeps active-session, ADMIN capability, tenant scope, and audit enforcement;
 * deliberately omits only the module entitlement check.
 */
export const entitlementIndependentAdminProcedure = baseProcedure
  .use(auditAll)
  .use(requireCapability('admin:access'));

// HR console procedure — ADMIN or HR (policy: 'hr:access').
export const hrProcedure = baseProcedure
  .use(auditAll)
  .use(requireCapability('hr:access'))
  .use(requireLicensedModule);

/**
 * Generic capability-gated procedure. Use for any action in the ABAC catalogue,
 * e.g. `capabilityProcedure('resignation:readAll')`. Audits like adminProcedure.
 */
export function capabilityProcedure(action: Action, refusalMessage?: string) {
  return baseProcedure
    .use(auditAll)
    .use(requireCapability(action, refusalMessage))
    .use(requireLicensedModule);
}

/**
 * Like `capabilityProcedure`, but the actions (all required) are chosen per call
 * from the context. DEV-19: a catalogue command needs the editor's capabilities to
 * submit, and the approver's authority when an approved edit replays it on the
 * server. The selector may read only server-built context, never client input.
 */
export function contextualCapabilityProcedure(
  select: (ctx: TRPCContext) => readonly Action[],
  refusalMessage?: string
) {
  return baseProcedure
    .use(auditAll)
    .use(
      gated(
        t.middleware(async ({ ctx, next, path, type }) => {
          const actions = select(ctx);
          // An empty selection would authorize nothing; refuse rather than allow.
          if (actions.length === 0) throw capabilityRefusal('admin:access');
          const session = await assertCapabilities(ctx, path, type, actions, refusalMessage);
          return next({ ctx: { ...ctx, session } });
        }),
        { kind: 'contextual' }
      )
    )
    .use(requireLicensedModule);
}

/**
 * Deny-by-default tenant procedure (#979, PR J). Audits like
 * `capabilityProcedure`, but takes its permission from the procedure's own
 * `.meta({ capabilities: [...] })`; without that annotation every caller is
 * refused. Routers that must never fall back to "any signed-in member with the
 * module" build on this instead of `protectedProcedure`.
 */
export const denyByDefaultProcedure = baseProcedure
  .use(auditAll)
  .use(requireDeclaredCapabilities)
  .use(requireLicensedModule);
