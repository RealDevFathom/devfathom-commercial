// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '@/generated/prisma/client';
import { acquireTrelloImportLocks } from './trello-import-locks';

const connectionString = process.env.TRELLO_TEST_DATABASE_URL;

describe.skipIf(!connectionString)('Trello import concurrency on PostgreSQL 16', () => {
  let db: PrismaClient;

  beforeAll(async () => {
    const url = new URL(connectionString!);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.split(/[_/-]+/).includes('test')
    )
      throw new Error('Use a disposable local database.');
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
    const [role] = await db.$queryRaw<
      Array<{ superuser: boolean; bypass: boolean; version: number }>
    >`
      SELECT rolsuper AS superuser, rolbypassrls AS bypass, current_setting('server_version_num')::integer AS version
      FROM pg_roles WHERE rolname = current_user
    `;
    expect(role).toMatchObject({ superuser: false, bypass: false });
    expect(Math.floor(role.version / 10000)).toBe(16);
  });

  afterAll(async () => db?.$disconnect());

  it('admits one import per person and per business across transactions, with retry after commit', async () => {
    const actor = randomUUID();
    const anotherActor = randomUUID();
    const business = randomUUID();
    const anotherBusiness = randomUUID();
    const {
      promise: locked,
      resolve: reportLocked,
      reject: reportError,
    } = Promise.withResolvers<number>();
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const first = db
      .$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        await acquireTrelloImportLocks(tx, actor, business);
        reportLocked(row.pid);
        await held;
      })
      .catch(reportError);

    try {
      const pid = await locked;
      const retry = (person: string, account: string) =>
        db.$transaction(async (tx) => {
          const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          expect(row.pid).not.toBe(pid);
          await acquireTrelloImportLocks(tx, person, account);
        });
      await expect(retry(actor, anotherBusiness)).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
      });
      await expect(retry(anotherActor, business)).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
      });
      await expect(retry(anotherActor, anotherBusiness)).resolves.toBeUndefined();
    } finally {
      release();
      await first;
    }
    await expect(
      db.$transaction((tx) => acquireTrelloImportLocks(tx, actor, business))
    ).resolves.toBeUndefined();
  });
});
