/** DEV-103: the aging page's query contract (branch + inclusive as-of UTC day). */
export type AgingQuery = { branch?: string | string[]; asOf?: string | string[] };

function today(now: Date) {
  return now.toISOString().slice(0, 10);
}

export function parseAgingQuery(
  query: AgingQuery,
  now: Date
): { branchId?: string; asOf: string; invalid?: boolean } {
  const asOfRaw = query.asOf;
  const asOf = asOfRaw === undefined ? today(now) : typeof asOfRaw === 'string' ? asOfRaw : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || asOf > today(now) || asOf < '2000-01-01') {
    return { asOf: today(now), invalid: true };
  }
  if (query.branch === undefined) return { asOf };
  if (typeof query.branch !== 'string') return { asOf, invalid: true };
  const branchId = query.branch.trim();
  if (!branchId || branchId.length > 128) return { asOf, invalid: true };
  return { branchId, asOf };
}
