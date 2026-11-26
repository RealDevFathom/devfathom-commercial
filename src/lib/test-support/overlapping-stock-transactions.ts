import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** Run two real transactions and require PostgreSQL to identify the first as the second's blocker. */
export async function overlappingStockTransactions<A, B>(
  first: (hold: (db: ScopedDb) => Promise<void>) => Promise<A>,
  second: (announce: (db: ScopedDb) => Promise<void>) => Promise<B>
) {
  const ready = Promise.withResolvers<void>();
  const waiter = Promise.withResolvers<number>();
  let blockedMs = 0;
  const holder = first(async (db) => {
    ready.resolve();
    const pid = await waiter.promise;
    const deadline = Date.now() + 4000;
    let firstSeen: number | undefined;
    while (Date.now() < deadline) {
      const [row] = await db.$queryRaw<{ blocked: boolean }[]>`
        SELECT pg_backend_pid() = ANY(pg_blocking_pids(${pid}::int)) AS blocked`;
      if (row?.blocked) {
        firstSeen ??= Date.now();
        blockedMs = Date.now() - firstSeen;
        if (blockedMs >= 200) return;
      } else if (firstSeen !== undefined) throw new Error('Stock lock released before commit');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('PostgreSQL did not observe the competing stock transaction waiting');
  });
  const contender = Promise.race([ready.promise, holder]).then(() =>
    second(async (db) => {
      const [row] = await db.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (!row) throw new Error('Missing backend PID');
      waiter.resolve(row.pid);
    }).catch((error: unknown) => {
      waiter.reject(error);
      throw error;
    })
  );
  const outcomes = await Promise.allSettled([holder, contender] as const);
  return { outcomes, blockedMs };
}
