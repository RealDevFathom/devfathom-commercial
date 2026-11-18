/** DEV-103: the aging page's query contract (branch + inclusive as-of day on the organization's clock). */
import { workspaceToday } from '@/lib/timezone';

export type AgingQuery = {
  branch?: string | string[];
  asOf?: string | string[];
  /** DEV-694: optional payment-draft request. */
  payee?: string | string[];
  currency?: string | string[];
  budget?: string | string[];
  /** DEV-694: narrow the view to one payee. */
  payeeFilter?: string | string[];
};


export function parseAgingQuery(
  query: AgingQuery,
  now: Date,
  timeZone?: string | null
): { branchId?: string; asOf: string; invalid?: boolean } {
  const asOfRaw = query.asOf;
  const asOf = asOfRaw === undefined ? workspaceToday(timeZone, now) : typeof asOfRaw === 'string' ? asOfRaw : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || asOf > workspaceToday(timeZone, now) || asOf < '2000-01-01') {
    return { asOf: workspaceToday(timeZone, now), invalid: true };
  }
  if (query.branch === undefined) return { asOf };
  if (typeof query.branch !== 'string') return { asOf, invalid: true };
  const branchId = query.branch.trim();
  if (!branchId || branchId.length > 128) return { asOf, invalid: true };
  return { branchId, asOf };
}
