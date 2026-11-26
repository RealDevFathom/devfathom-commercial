import { createHmac, randomBytes } from 'node:crypto';
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
  /**
   * When the window this attempt was counted in opened, by the store's clock.
   * Pass the complete reservation to `refundRateLimit` to preserve store precision.
   */
  windowStartedAt?: Date;
  /** PostgreSQL timestamps may include microseconds that a Date cannot represent. */
  exactWindowStart?: string;
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
RETURNING count, "resetAt",
  ("resetAt" - ($2::int * INTERVAL '1 millisecond'))::text AS "exactWindowStart"
`;

const CLEAR_SQL = `DELETE FROM rate_limit_buckets WHERE key = $1`;
const REFUND_SQL = `
UPDATE rate_limit_buckets SET count = count - 1
WHERE key = $1
  AND count > 0
  AND "resetAt" > NOW()
  AND "resetAt" - ($2::int * INTERVAL '1 millisecond') <= $3::timestamptz
`;
const SWEEP_SQL = `DELETE FROM rate_limit_buckets WHERE "resetAt" <= NOW()`;

type RateLimitEnv = {
  NODE_ENV?: string;
  NEXT_PHASE?: string;
  VITEST?: string;
  RATE_LIMIT_STORE?: string;
  CLIENT_IP_HEADER?: string;
  TRUSTED_PROXY_CIDRS?: string;
  TRUSTED_PROXY_HOPS?: string;
  RATE_LIMIT_HMAC_SECRET?: string;
  AUTH_SECRET?: string;
};

/** Non-production processes may rate-limit without a configured secret. The value is not a credential. */
const devRateLimitHmacFallback = randomBytes(32).toString('hex');

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
    return { ok: true, retryAfter: 0, remaining: limit - 1, windowStartedAt: new Date(now) };
  }
  if (bucket.count >= limit) {
    return { ok: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000), remaining: 0 };
  }
  bucket.count += 1;
  return {
    ok: true,
    retryAfter: 0,
    remaining: limit - bucket.count,
    windowStartedAt: new Date(bucket.resetAt - windowMs),
  };
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
) => Promise<Array<{ count: number; resetAt: Date | string; exactWindowStart?: string }>>;

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
    const result = interpretRateLimitRow(Number(row.count), resetAt, limit);
    return result.ok
      ? {
          ...result,
          windowStartedAt: new Date(resetAt.getTime() - windowMs),
          exactWindowStart: row.exactWindowStart,
        }
      : result;
  } catch (error) {
    console.error('[rate-limit] store unavailable', error instanceof Error ? error.name : 'error');
    return { ok: false, retryAfter: 1, remaining: 0 };
  }
}

function rateLimitHmacSecret(env: RateLimitEnv = runtimeEnv): string {
  const secret = env.RATE_LIMIT_HMAC_SECRET?.trim() || env.AUTH_SECRET?.trim();
  if (secret) return secret;
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to rate-limit: set RATE_LIMIT_HMAC_SECRET or AUTH_SECRET.');
  }
  return devRateLimitHmacFallback;
}

/**
 * Production must HMAC rate-limit keys. A missing secret would either store raw
 * addresses and emails or sign every bucket with a value an attacker can read.
 * Development and test keep an ephemeral process fallback.
 */
export function assertProductionRateLimitHmacSecret(env: RateLimitEnv = runtimeEnv): void {
  if (env.NODE_ENV !== 'production') return;
  if (env.NEXT_PHASE === 'phase-production-build') return;
  if (env.RATE_LIMIT_HMAC_SECRET?.trim() || env.AUTH_SECRET?.trim()) return;
  throw new Error(
    'Refusing to start: set RATE_LIMIT_HMAC_SECRET or AUTH_SECRET. Production rate-limit keys must be HMAC-signed so raw addresses and emails are not stored.'
  );
}

/** Bucket identity stored in memory and Postgres. The raw address or email is not kept. */
export function rateLimitStorageKey(key: string): string {
  return createHmac('sha256', rateLimitHmacSecret()).update(key).digest('hex');
}

export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  if (terminalFloodBypass(key)) return { ok: true, retryAfter: 0, remaining: limit - 1 };
  const stored = rateLimitStorageKey(key);
  if (rateLimitBackend() === 'memory') return memoryRateLimit(stored, limit, windowMs);
  return postgresRateLimit(stored, limit, windowMs);
}

export async function clearRateLimit(key: string): Promise<void> {
  const stored = rateLimitStorageKey(key);
  if (rateLimitBackend() === 'memory') {
    buckets.delete(stored);
    return;
  }
  const query = rateLimitQuery.current ?? defaultQuery;
  try {
    await query(CLEAR_SQL, [stored]);
  } catch (error) {
    console.error('[rate-limit] clear failed', error instanceof Error ? error.name : 'error');
  }
}

/**
 * Give back ONE unit, unlike `clearRateLimit`, which forgets the whole window.
 *
 * Use it when the attempt that spent the unit turned out to be legitimate and
 * every other attempt in the window must keep counting — e.g. a fully verified
 * sign-in refunds only its own unit, so failures from the same address stay
 * counted. The refund is skipped when the window has rolled over since
 * `spentAt`, because the unit being returned was never spent in the new window.
 * There is no clock tolerance: pass the complete charging result, or
 * a time recorded by the same store after the charge. A skewed clock can only
 * cause a refund to be skipped, never to reach a later window.
 */
export async function refundRateLimit(
  key: string,
  windowMs: number,
  reservation: RateLimitResult | Date
): Promise<void> {
  const spentAt = reservation instanceof Date ? reservation : reservation.windowStartedAt;
  if (!spentAt) return;
  const stored = rateLimitStorageKey(key);
  if (rateLimitBackend() === 'memory') {
    const bucket = buckets.get(stored);
    if (!bucket || bucket.count <= 0) return;
    if (bucket.resetAt <= Date.now()) return;
    if (bucket.resetAt - windowMs > spentAt.getTime()) return;
    bucket.count -= 1;
    return;
  }
  const query = rateLimitQuery.current ?? defaultQuery;
  try {
    const stamp =
      reservation instanceof Date
        ? spentAt.toISOString()
        : (reservation.exactWindowStart ?? spentAt.toISOString());
    await query(REFUND_SQL, [stored, windowMs, stamp]);
  } catch (error) {
    console.error('[rate-limit] refund failed', error instanceof Error ? error.name : 'error');
  }
}

export const RATE_LIMIT_UPSERT_SQL = UPSERT_SQL;

function ipv6Hextets(token: string): number[] | null {
  const dotted = token.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  let text = token;
  if (dotted?.[1] && dotted[2]) {
    const octets = dotted[2].split('.').map((part) => Number(part));
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n > 255)) return null;
    const hi = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const lo = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    text = `${dotted[1]}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const read = (side: string): number[] | null => {
    if (side === '') return [];
    const values: number[] = [];
    for (const part of side.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      values.push(Number.parseInt(part, 16));
    }
    return values;
  };
  const left = read(halves[0] ?? '');
  if (!left) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const right = read(halves[1] ?? '');
  if (!right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

/** RFC 5952: lowercase hex, longest leftmost zero run of two or more compressed. */
function compressIpv6(hextets: number[]): string {
  let bestStart = -1;
  let bestLen = 0;
  let start = -1;
  for (let i = 0; i <= hextets.length; i += 1) {
    const zero = i < hextets.length && hextets[i] === 0;
    if (zero && start < 0) start = i;
    if (!zero && start >= 0) {
      const len = i - start;
      if (len > bestLen) {
        bestLen = len;
        bestStart = start;
      }
      start = -1;
    }
  }
  const parts = hextets.map((n) => n.toString(16));
  if (bestLen < 2) return parts.join(':');
  const left = parts.slice(0, bestStart).join(':');
  const right = parts.slice(bestStart + bestLen).join(':');
  if (!left && !right) return '::';
  if (!left) return `::${right}`;
  if (!right) return `${left}::`;
  return `${left}::${right}`;
}

function canonicalAddress(token: string): string | null {
  const family = isIP(token);
  if (family === 4) return token;
  if (family !== 6) return null;
  const hextets = ipv6Hextets(token);
  if (!hextets) return null;
  const mapped = hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff;
  if (mapped) {
    const hi = hextets[6] ?? 0;
    const lo = hextets[7] ?? 0;
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return compressIpv6(hextets);
}

/** Rate-limit bucket for one client. IPv6 shares a key across its /64. */
function rateLimitAddress(address: string): string {
  if (isIP(address) !== 6) return address;
  const hextets = ipv6Hextets(address);
  if (!hextets) return address;
  return compressIpv6([
    hextets[0] ?? 0,
    hextets[1] ?? 0,
    hextets[2] ?? 0,
    hextets[3] ?? 0,
    0,
    0,
    0,
    0,
  ]);
}

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
  return canonicalAddress(token);
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
 * A multi-hop list stays ignored. Returned IPv6 keys are the /64 of the
 * canonical address; trust checks still use the full address. An IPv4-mapped
 * address (`::ffff:`) is stored as IPv4.
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
    const hop = hops.at(-1);
    return hop ? rateLimitAddress(hop) : 'unknown';
  }

  const forwarded = addresses(request.headers.get('x-forwarded-for'));
  if (env.TRUSTED_PROXY_CIDRS?.trim()) {
    const list = trustedList(env.TRUSTED_PROXY_CIDRS);
    if (!list || forwarded.length === 0) return 'unknown';
    let index = forwarded.length - 1;
    if (!isTrusted(forwarded[index]!, list)) return 'unknown';
    while (index >= 0 && isTrusted(forwarded[index]!, list)) index -= 1;
    return index >= 0 ? rateLimitAddress(forwarded[index]!) : 'unknown';
  }

  const hops = Number(env.TRUSTED_PROXY_HOPS);
  if (Number.isInteger(hops) && hops > 0) {
    if (forwarded.length < hops) return 'unknown';
    return rateLimitAddress(forwarded[forwarded.length - hops]!);
  }

  // Next copies socket.remoteAddress into X-Forwarded-For only when the header
  // is absent. A single value is that socket address on a proxy-less dev server.
  // Production still requires an explicit proxy setting, and a multi-hop list
  // without one stays untrusted.
  if (env.NODE_ENV !== 'production' && forwarded.length === 1) {
    return rateLimitAddress(forwarded[0]!);
  }

  return 'unknown';
}
