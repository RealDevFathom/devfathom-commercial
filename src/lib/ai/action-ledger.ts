/**
 * DEV-576 — the confirmed-write ledger for Ask Fathom.
 *
 * Every write tool sets `needsApproval`, so the AI SDK pauses and emits a
 * `tool-approval-request`; the client shows a confirmation card and re-POSTs the
 * whole history with the approval. Until now the server kept no record of what it
 * had asked the person to confirm, so a forged history, a resent approval or a
 * retry after a provider failover could run the same write again.
 *
 * The ledger closes that gap with one table, `ai_assistant_actions`
 * (tenant RLS, unique per organization and tool call id):
 *
 *   1. `recordProposal` — on every non-automatic `tool-approval-request` the
 *      server emits, insert a PROPOSED row (duplicates ignored). The stream
 *      transform awaits the insert before the part reaches the client, so a card
 *      can never be approved before its row exists.
 *   2. `withActionLedger` — wraps the `execute` of every `needsApproval` tool:
 *        - no row for this tool call, or a different user / tool / input  → refuse
 *        - SUCCEEDED → return the stored result; the write is not run again
 *        - EXECUTING → "outcome unknown": an earlier run may or may not have
 *          committed, so the person must check before retrying
 *        - PROPOSED / FAILED → claim it as EXECUTING (committed on its own),
 *          run, then store SUCCEEDED with the result, or FAILED.
 *      Read-only tools are not wrapped.
 *
 * Approval signing. ai@7 can HMAC-sign each `tool-approval-request` it emits
 * (`experimental_toolApprovalSecret`): the signature covers approval id, tool
 * call id, tool name and a SHA-256 of the canonical input, travels to the client
 * inside the UI message (`approval.signature`) and comes back through
 * `convertToModelMessages`. On the continuation, `validateApprovedToolApprovals`
 * verifies it BEFORE any approved tool runs and throws
 * `InvalidToolApprovalSignatureError` for a missing or wrong signature, which
 * ends the request with the generic unavailable error. That makes approvals
 * server-verifiable without a round trip to the database, so we enable it. The
 * secret is derived from AUTH_SECRET with HMAC and a fixed label, then bound to
 * the acting organization and user, so a card signed for one person cannot be
 * replayed by another. Signing alone does not stop a resend of a genuine
 * approval (the same signature verifies again) — the ledger's SUCCEEDED state
 * does. In production a missing AUTH_SECRET leaves no way to verify anything,
 * so every ledgered write is refused.
 *
 * Hashing. The tool input is never stored: it can contain secrets (the assistant's
 * password reset no longer takes a password, but other tools may). Ids
 * and payload hashes are SHA-256 over canonical JSON, keyed (HMAC-SHA-256) with a
 * subkey of AUTH_SECRET when it is set, so a database reader cannot test guesses
 * against a stored hash.
 */
import 'server-only';

import { createHash, createHmac } from 'node:crypto';

import type { StreamTextTransform, ToolSet } from 'ai';

export type AIAssistantActionStatus = 'PROPOSED' | 'EXECUTING' | 'SUCCEEDED' | 'FAILED';

export type JsonSafe = null | boolean | number | string | JsonSafe[] | { [key: string]: JsonSafe };

export type ActionRecord = {
  id: string;
  userId: string;
  toolName: string;
  toolCallId: string;
  approvalId: string;
  payloadHash: string;
  status: AIAssistantActionStatus;
  result: JsonSafe | null;
};

export type ProposalRow = Omit<ActionRecord, 'status' | 'result'>;

/**
 * Persistence for one organization and acting user. Every method is its own
 * committed transaction: EXECUTING must be durable before the write runs, so a
 * crash mid-write leaves "outcome unknown" rather than a re-runnable proposal.
 */
export interface ActionLedgerStore {
  /** Insert a PROPOSED row; an existing row with the same id or tool call id wins. */
  insertProposal(row: ProposalRow): Promise<void>;
  find(toolCallId: string): Promise<ActionRecord | null>;
  /** PROPOSED or FAILED → EXECUTING. True only for the caller that moved it. */
  claim(id: string): Promise<boolean>;
  /** EXECUTING → SUCCEEDED / FAILED with the stored result. */
  finish(id: string, status: 'SUCCEEDED' | 'FAILED', result: JsonSafe | null): Promise<void>;
}

export type ActionLedgerContext = {
  organizationId: string;
  userId: string;
  /** False in production without AUTH_SECRET: every ledgered write is refused. */
  writesEnabled: boolean;
  /** Pass to `streamText({ experimental_toolApprovalSecret })`; undefined disables signing. */
  approvalSecret: Uint8Array | undefined;
  /** Key for ids and payload hashes; null means plain SHA-256 (development and tests). */
  digestKey: Uint8Array | null;
  store: ActionLedgerStore;
};

type Env = Record<string, string | undefined>;

// Fixed labels: purpose-bound subkeys, so these MACs never share a key with
// other AUTH_SECRET uses (sessions, POS proofs, print claims).
const LEDGER_KEY_LABEL = 'devfathom:ai:action-ledger:v1';
const APPROVAL_KEY_LABEL = 'devfathom:ai:tool-approval:v1';
const ID_LABEL = 'devfathom-ai-action-v1';
const MAX_STORED_RESULT_BYTES = 32 * 1024;

export const ACTION_LEDGER_MESSAGES = {
  refused:
    'This change was not confirmed by you in this conversation, so it was not made. Ask again to get a new confirmation.',
  outcomeUnknown:
    'This change was already started and its outcome is unknown. Check whether it took effect before trying again.',
  writesDisabled: 'Changes through Ask Fathom are turned off right now. Nothing was changed.',
  unavailable: 'This change could not be verified right now, so it was not made. Please try again.',
} as const;

// ---------------------------------------------------------------------------
// Canonical JSON and digests
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON: object keys sorted, `undefined` object members dropped,
 * values passed through `toJSON` (Dates become ISO strings) — the same value a
 * JSON round trip through the client produces, so a hash taken when the server
 * proposed a call matches the hash of the input the client sends back.
 */
export function canonicalJson(value: unknown): string {
  const text = canonical(value, new Set());
  return text === undefined ? 'null' : text;
}

function canonical(value: unknown, seen: Set<object>): string | undefined {
  if (value === null) return 'null';
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (typeof value === 'bigint') throw new TypeError('canonicalJson cannot encode a bigint');
  if (typeof value !== 'object') return JSON.stringify(value);
  const withToJson = value as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === 'function') return canonical(withToJson.toJSON(), seen);
  if (seen.has(value)) throw new TypeError('canonicalJson cannot encode a circular value');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonical(item, seen) ?? 'null').join(',')}]`;
    }
    const members: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const encoded = canonical((value as Record<string, unknown>)[key], seen);
      if (encoded !== undefined) members.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${members.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function digest(text: string, key: Uint8Array | null): string {
  return key
    ? createHmac('sha256', key).update(text).digest('hex')
    : createHash('sha256').update(text).digest('hex');
}

export function actionPayloadHash(input: unknown, key: Uint8Array | null = null): string {
  return digest(canonicalJson(input), key);
}

export function actionIdempotencyKey(
  parts: {
    organizationId: string;
    userId: string;
    toolCallId: string;
    toolName: string;
    input: unknown;
  },
  key: Uint8Array | null = null
): string {
  return digest(
    canonicalJson([
      ID_LABEL,
      parts.organizationId,
      parts.userId,
      parts.toolCallId,
      parts.toolName,
      parts.input,
    ]),
    key
  );
}

// ---------------------------------------------------------------------------
// Keys derived from AUTH_SECRET
// ---------------------------------------------------------------------------

function authSecret(env: Env): string | null {
  return env.AUTH_SECRET?.trim() || null;
}

function subkey(secret: string, label: string): Buffer {
  return createHmac('sha256', secret).update(label).digest();
}

/**
 * The `experimental_toolApprovalSecret` for one actor: HMAC(AUTH_SECRET, fixed
 * label), then bound to the organization and user. Undefined without AUTH_SECRET.
 */
export function deriveToolApprovalSecret(
  env: Env,
  actor: { organizationId: string; userId: string }
): Uint8Array | undefined {
  const secret = authSecret(env);
  if (!secret) return undefined;
  return new Uint8Array(
    createHmac('sha256', subkey(secret, APPROVAL_KEY_LABEL))
      .update(JSON.stringify([actor.organizationId, actor.userId]))
      .digest()
  );
}

export function createActionLedgerContext(
  actor: { organizationId: string; userId: string },
  env: Env = process.env,
  store: ActionLedgerStore = prismaActionLedgerStore(actor.organizationId, actor.userId)
): ActionLedgerContext {
  const secret = authSecret(env);
  const writesEnabled = secret !== null || env.NODE_ENV !== 'production';
  if (!writesEnabled) console.error('ASSISTANT_ACTION_LEDGER_NO_SECRET');
  return {
    organizationId: actor.organizationId,
    userId: actor.userId,
    writesEnabled,
    approvalSecret: deriveToolApprovalSecret(env, actor),
    digestKey: secret ? new Uint8Array(subkey(secret, LEDGER_KEY_LABEL)) : null,
    store,
  };
}

// ---------------------------------------------------------------------------
// Stored results
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_PARTS = [
  'password',
  'passcode',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'credential',
  'privatekey',
];
const SENSITIVE_KEY_EXACT = /^(?:otp|pin|cvv|cookie|authorization)$/;
// One-time links carry a bearer token in the path (inviteMember returns inviteUrl).
const SENSITIVE_LINK_KEY =
  /(?:invite|accept|reset|magic|login|signin|setup|verify|verification|activation)(?:url|link|uri)$/;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part)) ||
    SENSITIVE_KEY_EXACT.test(normalized) ||
    SENSITIVE_LINK_KEY.test(normalized)
  );
}

function redact(value: unknown, depth: number): JsonSafe {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return null;
  if (depth > 12) return '[omitted]';
  const withToJson = value as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === 'function') return redact(withToJson.toJSON(), depth + 1);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: { [key: string]: JsonSafe } = {};
  for (const [key, member] of Object.entries(value)) {
    if (member === undefined || typeof member === 'function') continue;
    out[key] = isSensitiveKey(key) ? '[redacted]' : redact(member, depth + 1);
  }
  return out;
}

/**
 * The result as stored and as returned on a replay: JSON-safe, secrets and
 * one-time links redacted, and capped in size.
 */
export function toStoredResult(value: unknown): JsonSafe {
  let safe: JsonSafe;
  try {
    safe = redact(value, 0);
  } catch {
    return { stored: 'unserializable' };
  }
  if (Buffer.byteLength(JSON.stringify(safe), 'utf8') > MAX_STORED_RESULT_BYTES) {
    return { stored: 'omitted-too-large', failed: isFailureResult(value) };
  }
  return safe;
}

/** Tools report expected failures (refusals, not found, ambiguity) as values. */
export function isFailureResult(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    ('error' in value || 'needsClarification' in value)
  );
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export type ApprovalRequestPart = {
  type: 'tool-approval-request';
  approvalId: string;
  isAutomatic?: boolean;
  toolCall: { toolCallId: string; toolName: string; input: unknown };
};

/**
 * Record the PROPOSED row for a server-emitted approval request. Never throws:
 * if the row cannot be written, the later approval is refused instead.
 * Automatic approvals are not recorded — no person confirmed them.
 */
export async function recordProposal(
  ctx: ActionLedgerContext,
  part: ApprovalRequestPart
): Promise<void> {
  if (part.isAutomatic === true) return;
  const { toolCallId, toolName, input } = part.toolCall;
  try {
    await ctx.store.insertProposal({
      id: actionIdempotencyKey(
        { organizationId: ctx.organizationId, userId: ctx.userId, toolCallId, toolName, input },
        ctx.digestKey
      ),
      userId: ctx.userId,
      toolName,
      toolCallId,
      approvalId: part.approvalId,
      payloadHash: actionPayloadHash(input, ctx.digestKey),
    });
  } catch {
    console.error('ASSISTANT_ACTION_PROPOSAL_FAILED', { toolName });
  }
}

/**
 * `streamText({ experimental_transform })` stage that records each approval
 * request before it is forwarded to the client.
 */
export function recordProposalsTransform<TOOLS extends ToolSet>(
  ctx: ActionLedgerContext
): StreamTextTransform<TOOLS> {
  return () =>
    new TransformStream({
      async transform(part, controller) {
        if (part.type === 'tool-approval-request') {
          await recordProposal(ctx, part as unknown as ApprovalRequestPart);
        }
        controller.enqueue(part);
      },
    });
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type Execute = (
  input: unknown,
  options: { toolCallId?: string } & Record<string, unknown>
) => unknown;

function refuse(reason: string, toolName: string, message: string) {
  console.error('ASSISTANT_ACTION_REFUSED', { reason, toolName });
  return { error: message };
}

function ledgeredExecute(ctx: ActionLedgerContext, toolName: string, execute: Execute): Execute {
  return async (input, options) => {
    if (!ctx.writesEnabled) {
      return refuse('WRITES_DISABLED', toolName, ACTION_LEDGER_MESSAGES.writesDisabled);
    }
    const toolCallId = options?.toolCallId;
    if (typeof toolCallId !== 'string' || !toolCallId) {
      return refuse('NO_TOOL_CALL_ID', toolName, ACTION_LEDGER_MESSAGES.refused);
    }
    const id = actionIdempotencyKey(
      { organizationId: ctx.organizationId, userId: ctx.userId, toolCallId, toolName, input },
      ctx.digestKey
    );
    const payloadHash = actionPayloadHash(input, ctx.digestKey);

    let row: ActionRecord | null;
    try {
      row = await ctx.store.find(toolCallId);
    } catch {
      return refuse('LEDGER_UNAVAILABLE', toolName, ACTION_LEDGER_MESSAGES.unavailable);
    }
    if (!row) return refuse('NOT_PROPOSED', toolName, ACTION_LEDGER_MESSAGES.refused);
    if (row.userId !== ctx.userId || row.toolName !== toolName) {
      return refuse('ACTOR_OR_TOOL_MISMATCH', toolName, ACTION_LEDGER_MESSAGES.refused);
    }
    if (row.payloadHash !== payloadHash || row.id !== id) {
      return refuse('PAYLOAD_MISMATCH', toolName, ACTION_LEDGER_MESSAGES.refused);
    }
    if (row.status === 'SUCCEEDED') return row.result;
    if (row.status === 'EXECUTING') {
      return refuse('OUTCOME_UNKNOWN', toolName, ACTION_LEDGER_MESSAGES.outcomeUnknown);
    }

    let claimed: boolean;
    try {
      claimed = await ctx.store.claim(id);
    } catch {
      return refuse('LEDGER_UNAVAILABLE', toolName, ACTION_LEDGER_MESSAGES.unavailable);
    }
    if (!claimed) {
      // Another request claimed it between our read and our claim.
      const current = await ctx.store.find(toolCallId).catch(() => null);
      if (current?.id === id && current.status === 'SUCCEEDED') return current.result;
      return refuse('OUTCOME_UNKNOWN', toolName, ACTION_LEDGER_MESSAGES.outcomeUnknown);
    }

    let result: unknown;
    try {
      result = await execute(input, options);
    } catch (error) {
      await ctx.store
        .finish(id, 'FAILED', { error: 'failed' })
        .catch(() => console.error('ASSISTANT_ACTION_FINISH_FAILED', { toolName }));
      throw error;
    }
    try {
      await ctx.store.finish(
        id,
        isFailureResult(result) ? 'FAILED' : 'SUCCEEDED',
        toStoredResult(result)
      );
    } catch {
      // The write ran; the row stays EXECUTING, so a resend reports "outcome
      // unknown" instead of running it again.
      console.error('ASSISTANT_ACTION_FINISH_FAILED', { toolName });
    }
    return result;
  };
}

/**
 * Wrap the `execute` of every `needsApproval` tool with the ledger. Returns a new
 * tool set; read-only tools are passed through unchanged.
 */
export function withActionLedger<TOOLS extends ToolSet>(
  tools: TOOLS,
  ctx: ActionLedgerContext
): TOOLS {
  const out: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const candidate = tool as { needsApproval?: unknown; execute?: Execute };
    if (!candidate.needsApproval || typeof candidate.execute !== 'function') {
      out[name] = tool;
      continue;
    }
    out[name] = { ...tool, execute: ledgeredExecute(ctx, name, candidate.execute) };
  }
  return out as TOOLS;
}

// ---------------------------------------------------------------------------
// PostgreSQL store
// ---------------------------------------------------------------------------

/**
 * The production store: every call is its own tenant-scoped transaction
 * (`withTenantDb`, FORCE RLS). `@/lib/tenancy/scoped-db` is imported lazily so
 * this module (and its unit tests) never construct a database client on import.
 */
export function prismaActionLedgerStore(organizationId: string, userId: string): ActionLedgerStore {
  type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
  const run = async <T>(work: (db: ScopedDb) => Promise<T>): Promise<T> => {
    const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
    return withTenantDb(organizationId, work, { userId });
  };
  const select = {
    id: true,
    userId: true,
    toolName: true,
    toolCallId: true,
    approvalId: true,
    payloadHash: true,
    status: true,
    result: true,
  } as const;
  return {
    async insertProposal(row) {
      await run((db) =>
        db.aIAssistantAction.createMany({
          data: [{ ...row, organizationId, status: 'PROPOSED' }],
          skipDuplicates: true,
        })
      );
    },
    async find(toolCallId) {
      const row = await run((db) =>
        db.aIAssistantAction.findUnique({
          where: { organizationId_toolCallId: { organizationId, toolCallId } },
          select,
        })
      );
      return row ? { ...row, result: (row.result ?? null) as JsonSafe | null } : null;
    },
    async claim(id) {
      const { count } = await run((db) =>
        db.aIAssistantAction.updateMany({
          where: { id, status: { in: ['PROPOSED', 'FAILED'] } },
          data: { status: 'EXECUTING', startedAt: new Date(), completedAt: null },
        })
      );
      return count === 1;
    },
    async finish(id, status, result) {
      const { Prisma } = await import('@/generated/prisma/client');
      await run((db) =>
        db.aIAssistantAction.updateMany({
          where: { id, status: 'EXECUTING' },
          data: {
            status,
            result: result === null ? Prisma.JsonNull : (result as object),
            completedAt: new Date(),
          },
        })
      );
    },
  };
}
