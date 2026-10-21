import { BlockList, isIP } from 'node:net';
import { env as runtimeEnv } from 'node:process';

/**
 * Fixed-window rate limiter.
 *
 * Production counts in Postgres (`rate_limit_buckets`) so every instance shares
 * one window. Vitest keeps the in-memory counter so unit tests do not need a
 * database. `RATE_LIMIT_STORE=memory` is ignored when NODE_ENV is production.
 */

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the window resets (when blocked). */
  retryAfter: number;
  remaining: number;
}

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
let calls = 0;

const UPSERT_SQL = `
INSERT INTO rate_limit_buckets (key, count, "resetAt")
VALUES ($1, 1, NOW() + ($2::int * INTERVAL '1 millisecond'))
ON CONFLICT (key) DO UPDATE SET
  count = CASE
    WHEN rate_limit_buckets."resetAt" <= NOW() THEN 1
    WHEN rate_limit_buckets.count >= $3::int THEN $3::int + 1
    ELSE rate_limit_buckets.count + 1
  END,
  "resetAt" = CASE
    WHEN rate_limit_buckets."resetAt" <= NOW() THEN EXCLUDED."resetAt"
    ELSE rate_limit_buckets."resetAt"
  END
RETURNING count, "resetAt"
`;

const CLEAR_SQL = `DELETE FROM rate_limit_buckets WHERE key = $1`;
const SWEEP_SQL = `DELETE FROM rate_limit_buckets WHERE "resetAt" <= NOW()`;

type RateLimitEnv = {
  NODE_ENV?: string;
  NEXT_PHASE?: string;
  VITEST?: string;
  RATE_LIMIT_STORE?: string;
  CLIENT_IP_HEADER?: string;
  TRUSTED_PROXY_CIDRS?: string;
  TRUSTED_PROXY_HOPS?: string;
};

export function rateLimitBackend(env: RateLimitEnv = runtimeEnv): 'memory' | 'postgres' {
  if (env.NODE_ENV === 'production' && env.VITEST !== 'true') return 'postgres';
  if (env.RATE_LIMIT_STORE === 'postgres') return 'postgres';
  if (env.RATE_LIMIT_STORE === 'memory') return 'memory';
  if (env.VITEST === 'true' || env.NODE_ENV === 'test') return 'memory';
  return 'postgres';
}

function terminalFloodBypass(key: string): boolean {
  return (
    runtimeEnv.NODE_ENV === 'test' &&
    runtimeEnv.RESTAURANT_INTEGRATED_E2E === '1' &&
    runtimeEnv.RESTAURANT_E2E_RELAX_TERMINAL_FLOOD_LIMITS === '1' &&
    (key.startsWith('terminal:ip:') || key.startsWith('terminal:device:'))
  );
}

function maybeSweepMemory(now: number) {
  if (++calls % 1000 !== 0) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function memoryRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  maybeSweepMemory(now);
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0, remaining: limit - 1 };
  }
  if (bucket.count >= limit) {
    return { ok: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000), remaining: 0 };
  }
  bucket.count += 1;
  return { ok: true, retryAfter: 0, remaining: limit - bucket.count };
}

export function interpretRateLimitRow(
  count: number,
  resetAt: Date,
  limit: number,
  now = Date.now()
): RateLimitResult {
  const retryAfter = Math.max(0, Math.ceil((resetAt.getTime() - now) / 1000));
  if (count > limit) return { ok: false, retryAfter, remaining: 0 };
  return { ok: true, retryAfter: 0, remaining: Math.max(0, limit - count) };
}

type Query = (
  sql: string,
  params: unknown[]
) => Promise<Array<{ count: number; resetAt: Date | string }>>;

let postgresCalls = 0;

async function defaultQuery<T>(sql: string, params: unknown[]): Promise<T[]> {
  const { db } = await import('@/lib/db');
  return db.$queryRawUnsafe<T[]>(sql, ...params);
}

/** Test seam. Production leaves this unset and uses the shared pool. */
export const rateLimitQuery: { current: Query | null } = { current: null };

async function postgresRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const query = rateLimitQuery.current ?? defaultQuery;
  try {
    const rows = await query(UPSERT_SQL, [key, windowMs, limit]);
    const row = rows[0];
    if (!row) return { ok: false, retryAfter: 1, remaining: 0 };
    const resetAt = row.resetAt instanceof Date ? row.resetAt : new Date(row.resetAt);
    if (++postgresCalls % 1000 === 0) {
      void query(SWEEP_SQL, []).catch(() => undefined);
    }
    return interpretRateLimitRow(Number(row.count), resetAt, limit);
  } catch (error) {
    console.error('[rate-limit] store unavailable', error instanceof Error ? error.name : 'error');
    return { ok: false, retryAfter: 1, remaining: 0 };
  }
}

export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  if (terminalFloodBypass(key)) return { ok: true, retryAfter: 0, remaining: limit - 1 };
  if (rateLimitBackend() === 'memory') return memoryRateLimit(key, limit, windowMs);
  return postgresRateLimit(key, limit, windowMs);
}

export async function clearRateLimit(key: string): Promise<void> {
  if (rateLimitBackend() === 'memory') {
    buckets.delete(key);
    return;
  }
  const query = rateLimitQuery.current ?? defaultQuery;
  try {
    await query(CLEAR_SQL, [key]);
  } catch (error) {
    console.error('[rate-limit] clear failed', error instanceof Error ? error.name : 'error');
  }
}

export const RATE_LIMIT_UPSERT_SQL = UPSERT_SQL;

function normalizeAddress(value: string): string | null {
  let token = value.trim().replace(/^"|"$/g, '');
  if (!token) return null;
  if (token.startsWith('[')) {
    const end = token.indexOf(']');
    if (end < 0) return null;
    token = token.slice(1, end);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(token)) {
    token = token.slice(0, token.lastIndexOf(':'));
  }
  if (isIP(token) === 0) return null;
  return token;
}

function addresses(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => normalizeAddress(part))
    .filter((part): part is string => part !== null);
}

function trustedList(raw: string | undefined): BlockList | null {
  if (!raw?.trim()) return null;
  const list = new BlockList();
  let parsed = 0;
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const slash = trimmed.lastIndexOf('/');
    if (slash <= 0) continue;
    const addr = trimmed.slice(0, slash);
    const bits = Number(trimmed.slice(slash + 1));
    const family = isIP(addr);
    const max = family === 4 ? 32 : family === 6 ? 128 : -1;
    if (max < 0 || !Number.isInteger(bits) || bits < 0 || bits > max) continue;
    list.addSubnet(addr, bits, family === 4 ? 'ipv4' : 'ipv6');
    parsed += 1;
  }
  return parsed > 0 ? list : null;
}

function isTrusted(ip: string, list: BlockList): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  return list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Client address for rate limits.
 *
 * A configured header (`CLIENT_IP_HEADER`) is used as a single value the edge
 * overwrites; a comma-separated value yields the rightmost address.
 * Otherwise `TRUSTED_PROXY_CIDRS` walks `X-Forwarded-For` from the right and
 * skips trusted proxies. The rightmost hop must itself be trusted, or the
 * header is ignored. `TRUSTED_PROXY_HOPS` selects the address that many hops
 * from the right (the one the outermost proxy appended). With neither setting,
 * production ignores forwarded headers. Production startup refuses to run until
 * one of those settings is present, so requests cannot share an `unknown`
 * bucket. Development and test accept one address, which is the socket address
 * Next copies into `X-Forwarded-For` when the client did not send the header.
 * A multi-hop list stays ignored.
 */
/**
 * Production must name a proxy. With none of the three settings, every request
 * shares the address `unknown` and a burst can lock out login.
 */
export function assertProductionClientIpConfig(env: RateLimitEnv = runtimeEnv): void {
  if (env.NODE_ENV !== 'production') return;
  if (env.NEXT_PHASE === 'phase-production-build') return;
  const configured = [env.CLIENT_IP_HEADER, env.TRUSTED_PROXY_CIDRS, env.TRUSTED_PROXY_HOPS].some(
    (value) => Boolean(value?.trim())
  );
  if (configured) return;
  throw new Error(
    'Refusing to start: set CLIENT_IP_HEADER, TRUSTED_PROXY_CIDRS, or TRUSTED_PROXY_HOPS. ' +
      'Without one of them, production rate limits share a single "unknown" address and can lock out login.'
  );
}

export function clientIp(request: Request, env: RateLimitEnv = runtimeEnv): string {
  const configured = env.CLIENT_IP_HEADER?.trim();
  if (configured) {
    const hops = addresses(request.headers.get(configured));
    return hops.at(-1) ?? 'unknown';
  }

  const forwarded = addresses(request.headers.get('x-forwarded-for'));
  if (env.TRUSTED_PROXY_CIDRS?.trim()) {
    const list = trustedList(env.TRUSTED_PROXY_CIDRS);
    if (!list || forwarded.length === 0) return 'unknown';
    let index = forwarded.length - 1;
    if (!isTrusted(forwarded[index]!, list)) return 'unknown';
    while (index >= 0 && isTrusted(forwarded[index]!, list)) index -= 1;
    return index >= 0 ? forwarded[index]! : 'unknown';
  }

  const hops = Number(env.TRUSTED_PROXY_HOPS);
  if (Number.isInteger(hops) && hops > 0) {
    if (forwarded.length < hops) return 'unknown';
    return forwarded[forwarded.length - hops]!;
  }

  // Next copies socket.remoteAddress into X-Forwarded-For only when the header
  // is absent. A single value is that socket address on a proxy-less dev server.
  // Production still requires an explicit proxy setting, and a multi-hop list
  // without one stays untrusted.
  if (env.NODE_ENV !== 'production' && forwarded.length === 1) {
    return forwarded[0]!;
  }

  return 'unknown';
}
