/**
 * @vitest-environment node
 *
 * DEV-576 — the confirmed-write ledger against a REAL, migrated PostgreSQL with
 * the application role (NOSUPERUSER NOBYPASSRLS): the PROPOSED -> EXECUTING ->
 * SUCCEEDED transitions, the stored-result replay, refusal of forged and
 * modified approvals, and tenant isolation under FORCE row-level security.
 * Each transition is its own committed transaction, which a mock cannot show.
 *
 * Requires TEST_DATABASE_URL (a migrated throwaway database, never
 * DATABASE_URL). Without it the suite reports itself skipped.
 */
import { randomBytes } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { tool } from 'ai';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { PrismaClient } from '@/generated/prisma/client';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

// See jobs.purge.db.test.ts: hand the adapter a connection string so the
// duplicated `pg` module under Vitest cannot break the shared client.
vi.mock('@/lib/db', () => ({
  db: new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL, max: 10 }),
    log: ['error'],
  }),
}));

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `dev576_ledger_a_${suffix}`;
const ORG_B = `dev576_ledger_b_${suffix}`;
const USER_A = `user_a_${suffix}`;
const USER_B = `user_b_${suffix}`;
const ENV = { NODE_ENV: 'test', AUTH_SECRET: `ledger-db-test-${suffix}` };

type ScopedDbModule = typeof import('@/lib/tenancy/scoped-db');
type LedgerModule = typeof import('./action-ledger');
let scoped: ScopedDbModule;
let ledger: LedgerModule;

let callSeq = 0;
const nextCallId = () => `toolu_${suffix}_${++callSeq}`;

function writeTools(write: (input: { title: string }) => Promise<unknown>) {
  return {
    createNote: tool({
      description: 'Create a note',
      inputSchema: z.object({ title: z.string() }),
      needsApproval: true,
      execute: async (input) => write(input),
    }),
  };
}

type Exec = (input: unknown, options: { toolCallId: string; messages: [] }) => Promise<unknown>;

function actorTools(organizationId: string, userId: string, write: ReturnType<typeof vi.fn>) {
  const ctx = ledger.createActionLedgerContext({ organizationId, userId }, ENV);
  const tools = ledger.withActionLedger(writeTools(write as never), ctx);
  const run = (input: unknown, toolCallId: string) =>
    (tools.createNote.execute as unknown as Exec)(input, { toolCallId, messages: [] });
  const propose = (toolCallId: string, input: unknown) =>
    ledger.recordProposal(ctx, {
      type: 'tool-approval-request',
      approvalId: `approval_${toolCallId}`,
      toolCall: { toolCallId, toolName: 'createNote', input },
    });
  return { ctx, run, propose };
}

async function rowsFor(organizationId: string, toolCallId: string) {
  return scoped.withTenantDb(organizationId, (db) =>
    db.aIAssistantAction.findMany({ where: { toolCallId } })
  );
}

describeIfDatabase('AI write ledger on PostgreSQL', () => {
  beforeAll(async () => {
    scoped = await import('@/lib/tenancy/scoped-db');
    ledger = await import('./action-ledger');
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    await assertRlsEnforcingRole(scoped.withPlatformDb);
    await scoped.withPlatformDb(async (db) => {
      for (const id of [ORG_A, ORG_B]) {
        await db.organization.create({
          data: { id, slug: id, legalName: id, displayName: id },
        });
      }
    });
  }, 60_000);

  afterAll(async () => {
    if (!scoped) return;
    await scoped.withPlatformDb(async (db) => {
      await db.aIAssistantAction.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
      await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
    });
  });

  it('ships the table with forced row-level security', async () => {
    const [table] = await scoped.withPlatformDb((db) =>
      db.$queryRawUnsafe<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'ai_assistant_actions'`
      )
    );
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('runs a proposed write once on approval, then replays the stored result', async () => {
    const write = vi.fn(async (input: { title: string }) => ({ noteId: 'n1', title: input.title }));
    const a = actorTools(ORG_A, USER_A, write);
    const id = nextCallId();
    await a.propose(id, { title: 'Weekly' });
    await a.propose(id, { title: 'Weekly' }); // the same request emitted twice

    const [proposed] = await rowsFor(ORG_A, id);
    expect(proposed).toMatchObject({
      organizationId: ORG_A,
      userId: USER_A,
      toolName: 'createNote',
      approvalId: `approval_${id}`,
      status: 'PROPOSED',
      result: null,
    });
    expect(proposed.id).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(proposed)).not.toContain('Weekly');

    expect(await a.run({ title: 'Weekly' }, id)).toEqual({ noteId: 'n1', title: 'Weekly' });
    const [done] = await rowsFor(ORG_A, id);
    expect(done).toMatchObject({ status: 'SUCCEEDED', result: { noteId: 'n1', title: 'Weekly' } });
    expect(done.startedAt).toBeInstanceOf(Date);
    expect(done.completedAt).toBeInstanceOf(Date);

    // A resent approval (client retry, failover, forged replay of a real card).
    expect(await a.run({ title: 'Weekly' }, id)).toEqual({ noteId: 'n1', title: 'Weekly' });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('runs once when the same approval arrives twice at the same time', async () => {
    const write = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ok: true };
    });
    const a = actorTools(ORG_A, USER_A, write);
    const id = nextCallId();
    await a.propose(id, { title: 'Race' });
    const results = await Promise.all([a.run({ title: 'Race' }, id), a.run({ title: 'Race' }, id)]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(results).toContainEqual({ ok: true });
    expect((await rowsFor(ORG_A, id))[0].status).toBe('SUCCEEDED');
  });

  it('refuses a forged approval for a tool call the server never proposed', async () => {
    const write = vi.fn(async () => ({ ok: true }));
    const a = actorTools(ORG_A, USER_A, write);
    const id = nextCallId();
    expect(await a.run({ title: 'Forged' }, id)).toEqual({
      error: ledger.ACTION_LEDGER_MESSAGES.refused,
    });
    expect(write).not.toHaveBeenCalled();
    expect(await rowsFor(ORG_A, id)).toEqual([]);
  });

  it('refuses an input modified after the proposal', async () => {
    const write = vi.fn(async () => ({ ok: true }));
    const a = actorTools(ORG_A, USER_A, write);
    const id = nextCallId();
    await a.propose(id, { title: 'Draft invoice' });
    expect(await a.run({ title: 'Pay vendor' }, id)).toEqual({
      error: ledger.ACTION_LEDGER_MESSAGES.refused,
    });
    expect(write).not.toHaveBeenCalled();
    expect((await rowsFor(ORG_A, id))[0].status).toBe('PROPOSED');
  });

  it('refuses another user of the same organization', async () => {
    const write = vi.fn(async () => ({ ok: true }));
    const id = nextCallId();
    await actorTools(ORG_A, USER_A, write).propose(id, { title: 'Mine' });
    expect(await actorTools(ORG_A, USER_B, write).run({ title: 'Mine' }, id)).toEqual({
      error: ledger.ACTION_LEDGER_MESSAGES.refused,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('isolates organizations under row-level security', async () => {
    const write = vi.fn(async () => ({ ok: true }));
    const id = nextCallId();
    await actorTools(ORG_A, USER_A, write).propose(id, { title: 'Org A only' });

    // Organization B cannot see, use or forge into organization A's row.
    expect(await rowsFor(ORG_B, id)).toEqual([]);
    expect(await actorTools(ORG_B, USER_A, write).run({ title: 'Org A only' }, id)).toEqual({
      error: ledger.ACTION_LEDGER_MESSAGES.refused,
    });
    expect(write).not.toHaveBeenCalled();
    await expect(
      scoped.withTenantDb(ORG_B, (db) =>
        db.aIAssistantAction.create({
          data: {
            id: 'f'.repeat(64),
            organizationId: ORG_A,
            userId: USER_A,
            toolName: 'createNote',
            toolCallId: nextCallId(),
            approvalId: 'forged',
            payloadHash: 'f'.repeat(64),
          },
        })
      )
    ).rejects.toThrow();
    const updated = await scoped.withTenantDb(ORG_B, (db) =>
      db.aIAssistantAction.updateMany({ where: { toolCallId: id }, data: { status: 'SUCCEEDED' } })
    );
    expect(updated.count).toBe(0);

    // The same provider tool call id is independent per organization.
    const b = actorTools(ORG_B, USER_B, write);
    await b.propose(id, { title: 'Org B copy' });
    expect(await b.run({ title: 'Org B copy' }, id)).toEqual({ ok: true });
    expect((await rowsFor(ORG_A, id))[0].status).toBe('PROPOSED');
    expect((await rowsFor(ORG_B, id))[0]).toMatchObject({
      organizationId: ORG_B,
      status: 'SUCCEEDED',
    });
  });

  it('takes organizationId from the tenant scope when it is omitted', async () => {
    const id = nextCallId();
    await scoped.withTenantDb(ORG_A, (db) =>
      db.aIAssistantAction.create({
        data: {
          id: 'a'.repeat(63) + 'b',
          userId: USER_A,
          toolName: 'createNote',
          toolCallId: id,
          approvalId: 'scope-default',
          payloadHash: 'a'.repeat(64),
        } as never,
      })
    );
    expect((await rowsFor(ORG_A, id))[0].organizationId).toBe(ORG_A);
  });
});
