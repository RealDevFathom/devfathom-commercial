/**
 * Shared foundation for the DevFathom assistant's tools.
 *
 * The toolset is split across `src/lib/ai/tools/<domain>.ts` files so the work
 * is modular; every one of them is built against the `AssistantHelpers` bundle
 * created here. This is the single place that knows how the assistant:
 *   - authorizes an action  → `h.can(action, resource?)` (the ABAC engine, the
 *     SAME decision point the tRPC/REST surfaces use — the assistant can never
 *     exceed the acting user's real permissions, even under prompt injection),
 *   - resolves a fuzzy human name → `h.resolvePerson` / `h.resolveNamed`,
 *   - scopes what a non-admin may read → `h.isAdmin` / `h.taskVisibility()` …,
 *   - records what it did → `h.audit()` (audit log) + `h.activity()` (feed) +
 *     `h.notifyUsers()` (in-app + email), mirroring the tRPC mutations.
 *
 * Every write tool MUST: set `needsApproval: true`, authorize with `h.can(...)`
 * or an `@/lib/authz` object-level guard, and mirror the side effects of the
 * equivalent tRPC mutation (activity log, notifications, audit). Optional input
 * params MUST be `.nullish()` (NOT `.optional()`) — Groq/gpt-oss send `null` for
 * omitted optionals and reject a bare `.optional()` schema with a 400.
 */
import type { Tool } from 'ai';
import { ALL_VERTICALS, type OrganizationVertical } from '@/lib/vertical-catalog';
import { isModuleGranted, moduleDefinitionForKey } from '@/lib/module-catalog';
import { Prisma } from '@/generated/prisma/client';
import { createTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import * as authz from '@/lib/authz';
import {
  can as abacCan,
  subjectFromSession,
  type Action,
  type ResourceAttributes,
  type Subject,
} from '@/lib/abac';
import { logActivity, type LogActivityArgs } from '@/server/activity';
import { recordAudit, type AuditOperationT } from '@/server/audit';
import { notify, type NotifyArgs } from '@/lib/notifications';

export type AssistantContext = {
  organizationId: string;
  userId: string;
  role: string;
  /** Server-derived; omitted legacy scope never defaults to Agency. */
  vertical?: OrganizationVertical | null;
  enabledModules?: string[];
  name?: string | null;
  email?: string | null;
  department?: string | null;
  status?: string | null;
  /**
   * DEV-959B: a platform support session acting as this member. Member-access writes refuse
   * it, as the team and organization screens do.
   */
  supportSession?: boolean;
};

/** Validate even typed callers: runtime input may not match the TypeScript union. */
export function assistantVertical(value: unknown): OrganizationVertical | undefined {
  return ALL_VERTICALS.find((vertical) => vertical === value);
}

export function assistantModuleGranted(ctx: AssistantContext, key: string): boolean {
  const definition = moduleDefinitionForKey(key);
  if (!definition || !isModuleGranted(key, ctx.enabledModules ?? [])) return false;
  return definition.vertical === null || definition.vertical === assistantVertical(ctx.vertical);
}

/** A bag of tools, keyed by tool name. */
export type ToolSet = Record<string, Tool>;

/** A domain tool file exports one of these. */
export type ToolBuilder = (h: AssistantHelpers) => ToolSet;

// Column names that mean "this task is finished". Used everywhere we split open
// vs. done work so the model never counts completed tasks as outstanding.
export const DONE_COLUMNS = ['Done', 'Completed', 'Complete', 'Shipped', 'Closed'];

// ───────────────────────────── fuzzy resolution ────────────────────────────
// The keystone fix for "Ayesha vs Aisha": the model passes a human name
// (possibly misspelled); we map it to a real record and either resolve
// confidently, hand back candidates to disambiguate, or report not-found. The
// model NEVER has to invent an id.

export function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Classic Levenshtein edit distance (small strings — fine to compute inline). */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Score how well `name` answers `query`. 100 = exact, 0 = no match. */
export function matchScore(query: string, name: string): number {
  const q = norm(query);
  const n = norm(name);
  if (!q) return 0;
  if (q === n) return 100;
  if (n.includes(q) || q.includes(n)) return 88;

  const qTokens = q.split(/\s+/).filter(Boolean);
  const nTokens = n.split(/\s+/).filter(Boolean);

  if (qTokens.some((qt) => nTokens.some((nt) => nt.includes(qt) || qt.includes(nt)))) return 72;

  let best = Infinity;
  for (const qt of qTokens) {
    for (const nt of nTokens) {
      if (Math.max(qt.length, nt.length) < 4) continue;
      best = Math.min(best, editDistance(qt, nt));
    }
  }
  if (best <= 2) return 50 - best * 8;
  return 0;
}

export type PersonLite = {
  id: string;
  name: string;
  title: string;
  department: string;
  role: string;
  status: string;
};

export type Resolution<T> =
  | { kind: 'resolved'; value: T; interpreted?: string }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'notfound' };

export type NamedRow = { id: string; name: string };

export function resolveNamed<T extends NamedRow>(query: string, rows: T[]): Resolution<T> {
  const scored = rows
    .map((r) => ({ r, score: matchScore(query, r.name) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { kind: 'notfound' };
  const strong = scored.filter((s) => s.score >= 70);
  if (strong.length === 1) return { kind: 'resolved', value: strong[0].r };
  if (strong.length === 0 && scored.length === 1) {
    return { kind: 'resolved', value: scored[0].r, interpreted: scored[0].r.name };
  }
  const pool = strong.length > 0 ? strong : scored;
  return { kind: 'ambiguous', candidates: pool.slice(0, 6).map((s) => s.r.name) };
}

// ───────────────────────────────── helpers ─────────────────────────────────

export type AssistantHelpers = ReturnType<typeof createAssistantHelpers>;

export function createAssistantHelpers(
  ctx: AssistantContext,
  db: ScopedDb = createTenantDb(ctx.organizationId)
) {
  const subject: Subject = subjectFromSession({
    id: ctx.userId,
    role: ctx.role,
    department: ctx.department,
    status: ctx.status,
  });
  const isAdmin = authz.isAdmin(ctx.role);
  const isHr = ctx.role === 'HR';
  const isAdminOrHr = isAdmin || isHr;
  const now = () => new Date();

  /** The ABAC decision point, bound to this subject + the assistant source. */
  const can = (action: Action, resource?: ResourceAttributes): Promise<boolean> =>
    abacCan(subject, action, resource, { source: 'ASSISTANT', db });

  // Project ids a non-admin may see. Cached per request.
  let myProjectIdsCache: string[] | null = null;
  const myProjectIds = async (): Promise<string[]> => {
    if (myProjectIdsCache) return myProjectIdsCache;
    const rows = await db.projectMember.findMany({
      where: { userId: ctx.userId },
      select: { projectId: true },
    });
    myProjectIdsCache = rows.map((r) => r.projectId);
    return myProjectIdsCache;
  };

  /** Tasks a non-admin may see: assigned to them OR on a project they belong to. */
  const taskVisibility = (): Prisma.TaskWhereInput =>
    isAdmin
      ? {}
      : {
          OR: [
            { assignees: { some: { userId: ctx.userId } } },
            { column: { board: { project: { members: { some: { userId: ctx.userId } } } } } },
          ],
        };

  const compactTask = (t: {
    id: string;
    title: string;
    priority: string;
    dueDate: Date | null;
    column: { name: string; board: { project: { name: string } } } | null;
    assignees: { user: { name: string } }[];
  }) => ({
    id: t.id,
    title: t.title,
    priority: t.priority,
    status: t.column?.name ?? null,
    project: t.column?.board?.project?.name ?? null,
    assignees: t.assignees.map((a) => a.user.name),
    dueDate: t.dueDate,
    overdue: !!t.dueDate && t.dueDate < now() && !DONE_COLUMNS.includes(t.column?.name ?? ''),
  });

  /** Resolve a free-text person name to one user, or candidates to ask about. */
  const resolvePerson = async (
    query: string,
    opts: { includeInactive?: boolean } = {}
  ): Promise<Resolution<PersonLite>> => {
    const users = await db.user.findMany({
      where: opts.includeInactive ? {} : { status: { not: 'INACTIVE' } },
      select: { id: true, name: true, title: true, department: true, role: true, status: true },
    });
    const scored = users
      .map((u) => ({ u, score: matchScore(query, u.name) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) return { kind: 'notfound' };
    const strong = scored.filter((s) => s.score >= 70);
    if (strong.length === 1) return { kind: 'resolved', value: strong[0].u };
    if (strong.length > 1)
      return {
        kind: 'ambiguous',
        candidates: strong.slice(0, 6).map((s) => `${s.u.name} (${s.u.title})`),
      };
    if (scored.length === 1)
      return { kind: 'resolved', value: scored[0].u, interpreted: scored[0].u.name };
    return {
      kind: 'ambiguous',
      candidates: scored.slice(0, 6).map((s) => `${s.u.name} (${s.u.title})`),
    };
  };

  /** ADMIN or a member of the project — for reads + member-level writes. */
  const canAccessProject = (projectId: string): Promise<boolean> =>
    authz.canAccessProject(db, ctx.userId, ctx.role, projectId);
  /** ADMIN or a project LEAD — for structural / destructive ops. */
  const canManageProject = (projectId: string): Promise<boolean> =>
    authz.canManageProject(db, ctx.userId, ctx.role, projectId);

  /** Append to the Activity feed as the acting user (fire-and-forget). */
  const activity = (args: LogActivityArgs): void => logActivity(db, ctx.userId, args);

  /** Notify users in-app (+ optional email), fire-and-forget. */
  const notifyUsers = (userIds: string[], args: NotifyArgs): void => notify(db, userIds, args);

  /**
   * Record an assistant action in the admin audit trail. Mirrors how tRPC
   * mutations are audited, but stamped source=SYSTEM + metadata.via='assistant'
   * so it is unmistakably an AI-driven action attributed to the acting user.
   */
  const audit = (detail: {
    category: string;
    action: string;
    operation?: AuditOperationT;
    description?: string;
    targetType?: string;
    targetId?: string;
    targetLabel?: string;
    changes?: Record<string, { before: unknown; after: unknown }>;
    metadata?: Record<string, unknown>;
    result?: unknown;
  }): void => {
    recordAudit({
      organizationId: ctx.organizationId,
      source: 'SYSTEM',
      actorType: 'USER',
      actorId: ctx.userId,
      actorName: ctx.name ?? null,
      actorEmail: ctx.email ?? null,
      actorRole: ctx.role,
      operation: detail.operation ?? 'EXECUTE',
      category: detail.category,
      action: `assistant.${detail.action}`,
      description: detail.description ?? null,
      targetType: detail.targetType ?? null,
      targetId: detail.targetId ?? null,
      targetLabel: detail.targetLabel ?? null,
      changes: detail.changes,
      metadata: { ...(detail.metadata ?? {}), via: 'assistant' },
      result: detail.result,
    });
  };

  return {
    ctx,
    db,
    subject,
    isAdmin,
    isHr,
    isAdminOrHr,
    now,
    can,
    myProjectIds,
    taskVisibility,
    compactTask,
    resolvePerson,
    resolveNamed,
    canAccessProject,
    canManageProject,
    activity,
    notifyUsers,
    audit,
    DONE_COLUMNS,
  };
}
