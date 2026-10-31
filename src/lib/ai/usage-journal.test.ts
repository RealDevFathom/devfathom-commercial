/** @vitest-environment node */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAIUsageJournal, type AIUsageJournalRecord } from './usage-journal';

let directory: string;
const record = (): AIUsageJournalRecord => ({
  id: randomUUID(),
  provider: 'anthropic',
  model: 'priced-model',
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  costUsd: '6.000000',
  occurredAt: '2026-09-30T23:59:59.000Z',
});
const environment = () => ({ AI_USAGE_JOURNAL_DIR: directory });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ai-journal-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it('retains the exact priced record across a failed transaction and a new worker', async () => {
  const usage = record();
  const failed = await createAIUsageJournal(environment(), async () => {
    throw new Error('database unavailable');
  });
  await expect(failed.record(usage)).rejects.toThrow('database unavailable');
  expect(JSON.parse(await readFile(join(directory, `${usage.id}.json`), 'utf8'))).toEqual(usage);

  const persist = vi.fn().mockResolvedValue(undefined);
  const restarted = await createAIUsageJournal(environment(), persist);
  await restarted.replay();
  expect(persist).toHaveBeenCalledExactlyOnceWith(usage);
  expect(await readdir(directory)).toEqual([]);
});

it('replays an ambiguous committed transaction with the same ID without double-counting', async () => {
  const usage = record();
  const ledger = new Map<string, AIUsageJournalRecord>();
  const insert = vi.fn(async (row: AIUsageJournalRecord) => {
    // Model the production INSERT ... ON CONFLICT DO NOTHING contract.
    if (!ledger.has(row.id)) ledger.set(row.id, row);
  });
  const original = await createAIUsageJournal(environment(), async (row) => {
    await insert(row);
    throw new Error('commit acknowledgement lost');
  });
  await expect(original.record(usage)).rejects.toThrow('commit acknowledgement lost');
  const restarted = await createAIUsageJournal(environment(), insert);
  await restarted.replay();
  expect(insert).toHaveBeenCalledTimes(2);
  expect([...ledger.values()]).toEqual([usage]);
  expect(await readdir(directory)).toEqual([]);
});

it('allows two workers to replay the same record safely', async () => {
  const usage = record();
  await writeFile(join(directory, `${usage.id}.json`), JSON.stringify(usage));
  const ledger = new Map<string, AIUsageJournalRecord>();
  const persist = async (row: AIUsageJournalRecord) => {
    if (!ledger.has(row.id)) ledger.set(row.id, row);
  };
  const first = await createAIUsageJournal(environment(), persist);
  const second = await createAIUsageJournal(environment(), persist);
  await Promise.all([first.replay(), second.replay()]);
  expect([...ledger.values()]).toEqual([usage]);
  expect(await readdir(directory)).toEqual([]);
});

it('retains malformed records and blocks reconciliation instead of discarding spend', async () => {
  const usage = record();
  await writeFile(join(directory, `${usage.id}.json`), '{');
  const persist = vi.fn();
  const journal = await createAIUsageJournal(environment(), persist);
  await expect(journal.replay()).rejects.toThrow();
  expect(persist).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([`${usage.id}.json`]);
});

it('rejects a record whose ID differs from the journal filename', async () => {
  const usage = record();
  await writeFile(join(directory, `${randomUUID()}.json`), JSON.stringify(usage));
  const persist = vi.fn();
  const journal = await createAIUsageJournal(environment(), persist);
  await expect(journal.replay()).rejects.toThrow('Invalid AI usage journal ID');
  expect(persist).not.toHaveBeenCalled();
});

it.each(['', 'relative/path'])(
  'rejects nonpersistent directory configuration %s',
  async (path) => {
    await expect(
      createAIUsageJournal({ AI_USAGE_JOURNAL_DIR: path }, vi.fn())
    ).rejects.toThrow('absolute persistent directory');
  }
);

it('rejects a publicly served directory', async () => {
  await expect(
    createAIUsageJournal({ AI_USAGE_JOURNAL_DIR: join(directory, 'public') }, vi.fn())
  ).rejects.toThrow('outside public directories');
});
