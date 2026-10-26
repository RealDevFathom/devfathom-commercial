/** @vitest-environment node */
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { lockProjectMembership } from './membership-lock';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 3 }) : undefined;

async function withTransaction<T>(callback: (tx: object) => Promise<T>): Promise<T> {
  const client = await pool!.connect();
  await client.query('BEGIN');

  try {
    return await callback({
      $queryRaw: (query: { strings: readonly string[]; values: readonly unknown[] }) =>
        client.query({
          text: query.strings.reduce(
            (sql, part, index) => sql + (index ? `$${index}` : '') + part
          ),
          values: [...query.values],
        }),
    });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe.skipIf(!databaseUrl)('lockProjectMembership on PostgreSQL', () => {
  afterAll(async () => pool?.end());

  it('blocks a second transaction for the same project until the holder finishes', async () => {
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstLocked!: () => void;
    const firstHasLock = new Promise<void>((resolve) => {
      firstLocked = resolve;
    });

    const first = withTransaction(async (tx) => {
      await lockProjectMembership(tx as never, 'project-1');
      firstLocked();
      await holdFirst;
    });
    await firstHasLock;

    let secondAcquired = false;
    let secondStarted!: () => void;
    const secondHasStarted = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const second = withTransaction(async (tx) => {
      secondStarted();
      await lockProjectMembership(tx as never, 'project-1');
      secondAcquired = true;
    });
    await secondHasStarted;

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(secondAcquired).toBe(false);
    } finally {
      releaseFirst();
      await Promise.all([first, second]);
    }
    expect(secondAcquired).toBe(true);
  });
});
