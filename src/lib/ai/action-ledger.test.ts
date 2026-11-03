/** @vitest-environment node */
import { tool } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { z } from 'zod';

import {
  ACTION_LEDGER_MESSAGES,
  actionIdempotencyKey,
  actionPayloadHash,
  canonicalJson,
  createActionLedgerContext,
  deriveToolApprovalSecret,
  recordProposal,
  recordProposalsTransform,
  toStoredResult,
  withActionLedger,
  type ActionLedgerContext,
  type ActionLedgerStore,
  type ActionRecord,
  type ApprovalRequestPart,
} from './action-ledger';

/** An in-memory store with the same semantics as the PostgreSQL one. */
function memoryStore() {
  const rows = new Map<string, ActionRecord>();
  const store: ActionLedgerStore & { rows: Map<string, ActionRecord> } = {
    rows,
    insertProposal: vi.fn(async (row) => {
      if (rows.has(row.toolCallId) || [...rows.values()].some((r) => r.id === row.id)) return;
      rows.set(row.toolCallId, { ...row, status: 'PROPOSED', result: null });
    }),
    find: vi.fn(async (toolCallId) => {
      const row = rows.get(toolCallId);
      return row ? structuredClone(row) : null;
    }),
    claim: vi.fn(async (id) => {
      const row = [...rows.values()].find((r) => r.id === id);
      if (!row || (row.status !== 'PROPOSED' && row.status !== 'FAILED')) return false;
      row.status = 'EXECUTING';
      return true;
    }),
    finish: vi.fn(async (id, status, result) => {
      const row = [...rows.values()].find((r) => r.id === id);
      if (!row || row.status !== 'EXECUTING') return;
      row.status = status;
      row.result = result;
    }),
  };
  return store;
}

const ACTOR = { organizationId: 'org_a', userId: 'user_a' };

function ledger(
  store = memoryStore(),
  env: Record<string, string | undefined> = { NODE_ENV: 'test' },
  actor = ACTOR
) {
  return { ctx: createActionLedgerContext(actor, env, store), store };
}

function proposal(
  toolCallId: string,
  input: unknown,
  toolName = 'createNote'
): ApprovalRequestPart {
  return {
    type: 'tool-approval-request',
    approvalId: `approval_${toolCallId}`,
    toolCall: { toolCallId, toolName, input },
  };
}

function noteTools(write: (input: { title: string }) => unknown) {
  return {
    createNote: tool({
      description: 'Create a note',
      inputSchema: z.object({ title: z.string(), body: z.string().nullish() }),
      needsApproval: true,
      execute: async (input) => write(input),
    }),
    listNotes: tool({
      description: 'List notes',
      inputSchema: z.object({}),
      execute: async () => ({ notes: [] }),
    }),
  };
}

type Exec = (input: unknown, options: { toolCallId: string; messages: [] }) => Promise<unknown>;
function exec(tools: ReturnType<typeof noteTools>, name: 'createNote' | 'listNotes'): Exec {
  return tools[name].execute as unknown as Exec;
}
const call = (toolCallId: string) => ({ toolCallId, messages: [] as [] });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('canonical JSON and hashing', () => {
  it('ignores key order and undefined members, like a JSON round trip', () => {
    const a = { b: 1, a: { d: [1, undefined, 'x'], c: null }, gone: undefined };
    const b = JSON.parse(JSON.stringify({ a: { c: null, d: [1, null, 'x'] }, b: 1 }));
    expect(canonicalJson(a)).toBe('{"a":{"c":null,"d":[1,null,"x"]},"b":1}');
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(actionPayloadHash(a)).toBe(actionPayloadHash(b));
  });

  it('encodes dates as ISO strings and rejects values JSON cannot carry', () => {
    const at = new Date('2026-11-02T10:00:00.000Z');
    expect(canonicalJson({ at })).toBe('{"at":"2026-11-02T10:00:00.000Z"}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow(/circular/);
    expect(() => canonicalJson({ n: BigInt(1) })).toThrow(/bigint/);
  });

  it('changes the payload hash for any change of value', () => {
    expect(actionPayloadHash({ title: 'A' })).not.toBe(actionPayloadHash({ title: 'B' }));
    expect(actionPayloadHash({ title: 'A' })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binds the idempotency key to organization, user, call, tool and input', () => {
    const base = {
      organizationId: 'org_a',
      userId: 'user_a',
      toolCallId: 'call_1',
      toolName: 'createNote',
      input: { title: 'A' },
    };
    const key = actionIdempotencyKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(actionIdempotencyKey({ ...base, input: { title: 'A' } })).toBe(key);
    for (const changed of [
      { organizationId: 'org_b' },
      { userId: 'user_b' },
      { toolCallId: 'call_2' },
      { toolName: 'deleteNote' },
      { input: { title: 'B' } },
    ]) {
      expect(actionIdempotencyKey({ ...base, ...changed })).not.toBe(key);
    }
  });

  it('keys the digests when a key is given, so stored hashes cannot be guessed', () => {
    const key = new Uint8Array(32).fill(7);
    expect(actionPayloadHash({ newPassword: 'Secret123' }, key)).not.toBe(
      actionPayloadHash({ newPassword: 'Secret123' })
    );
  });
});

describe('keys derived from AUTH_SECRET', () => {
  it('derives a per-actor approval secret and none without AUTH_SECRET', () => {
    const env = { AUTH_SECRET: 'auth-secret-for-tests' };
    const a = deriveToolApprovalSecret(env, ACTOR);
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a).toEqual(deriveToolApprovalSecret(env, ACTOR));
    expect(a).not.toEqual(deriveToolApprovalSecret(env, { ...ACTOR, userId: 'user_b' }));
    expect(a).not.toEqual(deriveToolApprovalSecret(env, { ...ACTOR, organizationId: 'org_b' }));
    expect(Buffer.from(a!).toString('utf8')).not.toContain('auth-secret');
    expect(deriveToolApprovalSecret({ AUTH_SECRET: '  ' }, ACTOR)).toBeUndefined();
  });

  it('refuses writes in production without AUTH_SECRET, and signs when it is set', () => {
    const production = createActionLedgerContext(ACTOR, { NODE_ENV: 'production' }, memoryStore());
    expect(production.writesEnabled).toBe(false);
    expect(production.approvalSecret).toBeUndefined();

    const local = createActionLedgerContext(ACTOR, { NODE_ENV: 'development' }, memoryStore());
    expect(local).toMatchObject({
      writesEnabled: true,
      approvalSecret: undefined,
      digestKey: null,
    });

    const signed = createActionLedgerContext(
      ACTOR,
      { NODE_ENV: 'production', AUTH_SECRET: 'x'.repeat(40) },
      memoryStore()
    );
    expect(signed.writesEnabled).toBe(true);
    expect(signed.approvalSecret).toBeInstanceOf(Uint8Array);
    expect(signed.digestKey).toBeInstanceOf(Uint8Array);
    expect(signed.digestKey).not.toEqual(signed.approvalSecret);
  });
});

describe('stored results', () => {
  it('redacts secrets and one-time links and stays JSON-safe', () => {
    const stored = toStoredResult({
      name: 'Aisha',
      inviteUrl: 'https://app.test/invite/abc123',
      nested: { apiKey: 'k', newPassword: 'p', resetLink: 'https://x', count: Number.NaN },
      when: new Date('2026-11-02T00:00:00.000Z'),
      skipped: undefined,
      footprint: 'kept',
    });
    expect(stored).toEqual({
      name: 'Aisha',
      inviteUrl: '[redacted]',
      nested: {
        apiKey: '[redacted]',
        newPassword: '[redacted]',
        resetLink: '[redacted]',
        count: null,
      },
      when: '2026-11-02T00:00:00.000Z',
      footprint: 'kept',
    });
    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored);
  });

  it('replaces an oversized result with a marker', () => {
    expect(toStoredResult({ text: 'x'.repeat(40_000) })).toEqual({
      stored: 'omitted-too-large',
      failed: false,
    });
    expect(toStoredResult(undefined)).toBeNull();
  });
});

describe('recordProposal', () => {
  it('records a PROPOSED row with hashes only, and ignores automatic approvals', async () => {
    const { ctx, store } = ledger();
    await recordProposal(ctx, proposal('call_1', { title: 'Weekly', body: 'secret body' }));
    await recordProposal(ctx, { ...proposal('call_2', { title: 'x' }), isAutomatic: true });
    expect([...store.rows.keys()]).toEqual(['call_1']);
    const row = store.rows.get('call_1')!;
    expect(row).toMatchObject({
      userId: 'user_a',
      toolName: 'createNote',
      approvalId: 'approval_call_1',
      status: 'PROPOSED',
      payloadHash: actionPayloadHash({ title: 'Weekly', body: 'secret body' }),
    });
    expect(JSON.stringify(row)).not.toContain('secret body');
  });

  it('never throws when the store is down', async () => {
    const store = memoryStore();
    vi.mocked(store.insertProposal).mockRejectedValueOnce(new Error('db down'));
    const { ctx } = ledger(store);
    await expect(recordProposal(ctx, proposal('call_1', {}))).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith('ASSISTANT_ACTION_PROPOSAL_FAILED', {
      toolName: 'createNote',
    });
  });

  it('awaits the insert before forwarding the approval request', async () => {
    const order: string[] = [];
    const store = memoryStore();
    vi.mocked(store.insertProposal).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('recorded');
    });
    const { ctx } = ledger(store);
    const transform = recordProposalsTransform(ctx)({ tools: {}, stopStream: () => undefined });
    const parts = [
      { type: 'text-delta', id: 't', text: 'hi' },
      proposal('call_1', { title: 'A' }),
    ] as never[];
    const source = new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
    const reader = source.pipeThrough(transform).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      order.push((value as { type: string }).type);
    }
    expect(order).toEqual(['text-delta', 'recorded', 'tool-approval-request']);
  });
});

describe('withActionLedger', () => {
  let write: Mock<(input: { title: string }) => Promise<unknown>>;
  beforeEach(() => {
    write = vi.fn(async (input: { title: string }) => ({ id: 'note_1', title: input.title }));
  });

  it('wraps only approval-gated tools', () => {
    const { ctx } = ledger();
    const raw = noteTools(write);
    const wrapped = withActionLedger(raw, ctx);
    expect(wrapped.listNotes).toBe(raw.listNotes);
    expect(wrapped.createNote).not.toBe(raw.createNote);
    expect(wrapped.createNote.needsApproval).toBe(true);
    expect(wrapped.createNote.inputSchema).toBe(raw.createNote.inputSchema);
  });

  it('refuses a call the server never proposed', async () => {
    const { ctx } = ledger();
    const tools = withActionLedger(noteTools(write), ctx);
    expect(await exec(tools, 'createNote')({ title: 'A' }, call('forged'))).toEqual({
      error: ACTION_LEDGER_MESSAGES.refused,
    });
    expect(write).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('ASSISTANT_ACTION_REFUSED', {
      reason: 'NOT_PROPOSED',
      toolName: 'createNote',
    });
  });

  it('runs a proposed write once and returns the stored result on a resend', async () => {
    const { ctx, store } = ledger();
    await recordProposal(ctx, proposal('call_1', { title: 'Weekly' }));
    const tools = withActionLedger(noteTools(write), ctx);

    const first = await exec(tools, 'createNote')({ title: 'Weekly' }, call('call_1'));
    expect(first).toEqual({ id: 'note_1', title: 'Weekly' });
    expect(store.rows.get('call_1')).toMatchObject({ status: 'SUCCEEDED', result: first });

    const again = await exec(tools, 'createNote')({ title: 'Weekly' }, call('call_1'));
    expect(again).toEqual(first);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('refuses an input that changed after the proposal', async () => {
    const { ctx, store } = ledger();
    await recordProposal(ctx, proposal('call_1', { title: 'Weekly' }));
    const tools = withActionLedger(noteTools(write), ctx);
    expect(await exec(tools, 'createNote')({ title: 'Payroll' }, call('call_1'))).toEqual({
      error: ACTION_LEDGER_MESSAGES.refused,
    });
    expect(write).not.toHaveBeenCalled();
    expect(store.rows.get('call_1')?.status).toBe('PROPOSED');
  });

  it('refuses a different user or a different tool for the same call id', async () => {
    const store = memoryStore();
    const { ctx } = ledger(store);
    await recordProposal(ctx, proposal('call_1', { title: 'Weekly' }));

    const other = ledger(store, { NODE_ENV: 'test' }, { ...ACTOR, userId: 'user_b' }).ctx;
    const asOther = withActionLedger(noteTools(write), other);
    expect(await exec(asOther, 'createNote')({ title: 'Weekly' }, call('call_1'))).toEqual({
      error: ACTION_LEDGER_MESSAGES.refused,
    });

    await recordProposal(ctx, proposal('call_2', { title: 'Weekly' }, 'deleteNote'));
    const tools = withActionLedger(noteTools(write), ctx);
    expect(await exec(tools, 'createNote')({ title: 'Weekly' }, call('call_2'))).toEqual({
      error: ACTION_LEDGER_MESSAGES.refused,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('reports an unknown outcome while a run is EXECUTING', async () => {
    const { ctx, store } = ledger();
    await recordProposal(ctx, proposal('call_1', { title: 'Weekly' }));
    store.rows.get('call_1')!.status = 'EXECUTING';
    const tools = withActionLedger(noteTools(write), ctx);
    expect(await exec(tools, 'createNote')({ title: 'Weekly' }, call('call_1'))).toEqual({
      error: ACTION_LEDGER_MESSAGES.outcomeUnknown,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('marks EXECUTING before the write runs', async () => {
    const { ctx, store } = ledger();
    await recordProposal(ctx, proposal('call_1', { title: 'Weekly' }));
    write.mockImplementation(async () => {
      expect(store.rows.get('call_1')?.status).toBe('EXECUTING');
      return { ok: true };
    });
    await exec(withActionLedger(noteTools(write), ctx), 'createNote')(
      { title: 'Weekly' },
      call('call_1')
    );
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('stores FAILED for an error result and lets a confirmed retry run', async () => {
    const { ctx, store } = ledger();
    await recordProposal(ctx, proposal('call_1', { title: 'Weekly' }));
    write.mockResolvedValueOnce({ error: 'Only admins can do that.' });
    const tools = withActionLedger(noteTools(write), ctx);
    expect(await exec(tools, 'createNote')({ title: 'Weekly' }, call('call_1'))).toEqual({
      error: 'Only admins can do that.',
    });
    expect(store.rows.get('call_1')?.status).toBe('FAILED');
    await exec(tools, 'createNote')({ title: 'Weekly' }, call('call_1'));
    expect(store.rows.get('call_1')?.status).toBe('SUCCEEDED');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('stores FAILED and rethrows when the write throws', async () => {
    const { ctx, store } = ledger();
    await recordProposal(ctx, proposal('call_1', { title: 'Weekly' }));
    write.mockRejectedValueOnce(new Error('boom'));
    const tools = withActionLedger(noteTools(write), ctx);
    await expect(exec(tools, 'createNote')({ title: 'Weekly' }, call('call_1'))).rejects.toThrow(
      'boom'
    );
    expect(store.rows.get('call_1')).toMatchObject({
      status: 'FAILED',
      result: { error: 'failed' },
    });
  });

  it('leaves the row EXECUTING when the result cannot be stored', async () => {
    const store = memoryStore();
    vi.mocked(store.finish).mockRejectedValueOnce(new Error('db down'));
    const { ctx } = ledger(store);
    await recordProposal(ctx, proposal('call_1', { title: 'Weekly' }));
    const tools = withActionLedger(noteTools(write), ctx);
    expect(await exec(tools, 'createNote')({ title: 'Weekly' }, call('call_1'))).toEqual({
      id: 'note_1',
      title: 'Weekly',
    });
    expect(await exec(tools, 'createNote')({ title: 'Weekly' }, call('call_1'))).toEqual({
      error: ACTION_LEDGER_MESSAGES.outcomeUnknown,
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('runs once when two approvals race, and returns the winner result', async () => {
    const { ctx } = ledger();
    await recordProposal(ctx, proposal('call_1', { title: 'Weekly' }));
    let release!: () => void;
    write.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({ id: 'note_1' })))
    );
    const tools = withActionLedger(noteTools(write), ctx);
    const first = exec(tools, 'createNote')({ title: 'Weekly' }, call('call_1'));
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const second = await exec(tools, 'createNote')({ title: 'Weekly' }, call('call_1'));
    expect(second).toEqual({ error: ACTION_LEDGER_MESSAGES.outcomeUnknown });
    release();
    expect(await first).toEqual({ id: 'note_1' });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('returns the redacted stored result on a resend', async () => {
    const { ctx } = ledger();
    await recordProposal(ctx, proposal('call_1', { title: 'Invite' }));
    write.mockResolvedValue({ name: 'Aisha', inviteUrl: 'https://app.test/invite/tok' });
    const tools = withActionLedger(noteTools(write), ctx);
    expect(await exec(tools, 'createNote')({ title: 'Invite' }, call('call_1'))).toEqual({
      name: 'Aisha',
      inviteUrl: 'https://app.test/invite/tok',
    });
    expect(await exec(tools, 'createNote')({ title: 'Invite' }, call('call_1'))).toEqual({
      name: 'Aisha',
      inviteUrl: '[redacted]',
    });
  });

  it('refuses every write when writes are disabled', async () => {
    const store = memoryStore();
    const { ctx } = ledger(store, { NODE_ENV: 'production' });
    await recordProposal(ctx, proposal('call_1', { title: 'Weekly' }));
    const tools = withActionLedger(noteTools(write), ctx);
    expect(await exec(tools, 'createNote')({ title: 'Weekly' }, call('call_1'))).toEqual({
      error: ACTION_LEDGER_MESSAGES.writesDisabled,
    });
    expect(write).not.toHaveBeenCalled();
    expect(await exec(tools, 'listNotes')({}, call('call_r'))).toEqual({ notes: [] });
  });

  it('refuses when the ledger cannot be read', async () => {
    const store = memoryStore();
    const { ctx } = ledger(store);
    await recordProposal(ctx, proposal('call_1', { title: 'Weekly' }));
    vi.mocked(store.find).mockRejectedValueOnce(new Error('db down'));
    const tools = withActionLedger(noteTools(write), ctx);
    expect(await exec(tools, 'createNote')({ title: 'Weekly' }, call('call_1'))).toEqual({
      error: ACTION_LEDGER_MESSAGES.unavailable,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('uses keyed digests consistently between proposal and execution', async () => {
    const { ctx, store } = ledger(memoryStore(), { NODE_ENV: 'test', AUTH_SECRET: 's'.repeat(40) });
    await recordProposal(ctx, proposal('call_1', { title: 'Weekly' }));
    expect(store.rows.get('call_1')?.payloadHash).not.toBe(actionPayloadHash({ title: 'Weekly' }));
    const tools = withActionLedger(noteTools(write), ctx as ActionLedgerContext);
    await exec(tools, 'createNote')({ title: 'Weekly' }, call('call_1'));
    expect(write).toHaveBeenCalledTimes(1);
  });
});
