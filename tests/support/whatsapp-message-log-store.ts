type LogRow = Record<string, unknown> & { id: string };

type AuthorityUpdate = {
  where: {
    id?: string;
    organizationId?: string;
    direction?: string;
    dedupeKey?: string;
    OR: Array<{ status: string; error: string | { in: string[] } }>;
  };
  data: Record<string, unknown>;
};

/** Model the atomic conditional UPDATE, not a precomputed permission result. */
export function applySendAuthorityUpdate(rows: LogRow[], { where, data }: AuthorityUpdate) {
  const { OR, ...identity } = where;
  const matches = rows.filter(
    (row) =>
      Object.entries(identity).every(([key, value]) => value === undefined || row[key] === value) &&
      OR.some(
        (condition) =>
          row.status === condition.status &&
          (typeof condition.error === 'string'
            ? row.error === condition.error
            : condition.error.in.includes(row.error as string))
      )
  );
  for (const row of matches) Object.assign(row, data);
  return { count: matches.length };
}

/** Explicit synchronization; tests never rely on a timer to arrange a race. */
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function rendezvous(parties: number) {
  const ready = deferred();
  let arrived = 0;
  return async () => {
    arrived += 1;
    if (arrived === parties) ready.resolve();
    await ready.promise;
  };
}
