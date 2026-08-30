import { describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('Prisma PostgreSQL adapter void commands', () => {
  it('executes an advisory lock and continues the interactive transaction', async () => {
    const { db } = await import('@/lib/db');

    await expect(
      db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('db:void-regression', 0))`;
        return tx.$queryRaw<Array<{ continued: number }>>`SELECT 1::integer AS continued`;
      })
    ).resolves.toEqual([{ continued: 1 }]);
  });
});
