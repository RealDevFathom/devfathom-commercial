import 'server-only';

import { constants } from 'node:fs';
import { access, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, parse, sep } from 'node:path';
import { z } from 'zod';

const recordSchema = z
  .object({
    id: z.uuid(),
    provider: z.enum(['anthropic', 'bedrock']),
    model: z.string().min(1),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.string().regex(/^\d{1,12}\.\d{6}$/),
    occurredAt: z.iso.datetime(),
  })
  .strict();

export type AIUsageJournalRecord = z.infer<typeof recordSchema>;

/** A shared persistent volume, independent of the ledger's database transaction. */
export async function createAIUsageJournal(
  env: Record<string, string | undefined>,
  persist: (record: AIUsageJournalRecord) => Promise<unknown>
) {
  const configured = env.AI_USAGE_JOURNAL_DIR?.trim();
  if (!configured || !isAbsolute(configured))
    throw new Error('AI_USAGE_JOURNAL_DIR must be an absolute persistent directory.');
  await mkdir(configured, { recursive: true, mode: 0o700 });
  const directory = await realpath(configured);
  if (directory === parse(directory).root || directory.split(sep).includes('public'))
    throw new Error('AI usage journal must be outside public directories.');
  await access(directory, constants.R_OK | constants.W_OK);

  const pathFor = (name: string) => join(/* turbopackIgnore: true */ directory, name);
  const syncDirectory = async () => {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  // Fail before purchasing output if this filesystem cannot support the journal.
  await syncDirectory();

  const deliver = async (record: AIUsageJournalRecord) => {
    // The callback must commit before resolving and insert with this ID using
    // ON CONFLICT DO NOTHING. A timeout may have committed the original insert.
    await persist(record);
    await rm(pathFor(`${record.id}.json`), { force: true });
    await syncDirectory();
  };
  return {
    async record(input: AIUsageJournalRecord) {
      const record = recordSchema.parse(input);
      const temporary = pathFor(`${record.id}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(record));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, pathFor(`${record.id}.json`));
      await syncDirectory();
      // Leave the complete record on disk whenever the transaction fails.
      await deliver(record);
    },
    async replay() {
      for (const name of await readdir(directory)) {
        if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
        let contents: string;
        try {
          contents = await readFile(pathFor(name), 'utf8');
        } catch (error) {
          // Another worker may have delivered and removed this same record.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        const record = recordSchema.parse(JSON.parse(contents));
        if (name !== `${record.id}.json`) throw new Error('Invalid AI usage journal ID.');
        await deliver(record);
      }
    },
  };
}
