/**
 * ABAC (Attribute-Based Access Control) — core types.
 *
 * A decision is a function of three attribute bags:
 *   - Subject     — WHO is acting (the user: id, role, department, status)
 *   - Resource    — WHAT is being acted on (type + its attributes), optional
 *   - Environment — the request CONTEXT (time, where the call came from)
 *
 * Policies are pure-ish predicates over those bags. The engine evaluates the
 * policies registered for an action and grants access if ANY of them allows it
 * (allow-list / default-deny). Relationship checks (project/channel membership,
 * ownership) are delegated to the existing `@/lib/authz` keystone via `db`, so
 * ABAC is a thin attribute layer ON TOP of the proven object-level guards
 * rather than a parallel, divergent implementation.
 */
import type { AuthzDb } from '@/lib/authz';

export type Subject = {
  organizationId?: string | null;
  id: string;
  role: string;
  department?: string | null;
  status?: string | null;
};

/** A resource is identified by `type` plus any attributes a policy may read. */
export type ResourceAttributes = { type: string } & Record<string, unknown>;

export type Environment = {
  now: Date;
  source?: 'TRPC' | 'REST' | 'ASSISTANT' | 'SOCKET' | 'SYSTEM';
  ip?: string | null;
};

export type PolicyContext = {
  subject: Subject;
  resource?: ResourceAttributes;
  env: Environment;
  db: AuthzDb;
};

export type Policy = (ctx: PolicyContext) => boolean | Promise<boolean>;
