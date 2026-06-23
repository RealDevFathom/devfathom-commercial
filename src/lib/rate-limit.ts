/**
 * REST-04 — minimal in-process fixed-window rate limiter.
 *
 * No external dependency: a Map of fixed-window counters. This is PER server
 * instance (serverless caveat), so it is a structural mitigation, not a global
 * guarantee — swap the backing store for Upstash/Redis in production for a
 * cross-instance limit. It still meaningfully throttles a single client/IP and
 * caps bcrypt-amplifying auth floods.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
let calls = 0;

/** Drop expired windows occasionally so the map can't grow without bound. */
function maybeSweep(now: number) {
  if (++calls % 1000 !== 0) return;
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
}

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the window resets (when blocked). */
  retryAfter: number;
  remaining: number;
}

/**
 * Consume one unit against `key`. Returns ok:false (with retryAfter seconds)
 * once `limit` is exceeded within `windowMs`.
 */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  maybeSweep(now);
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0, remaining: limit - 1 };
  }
  if (b.count >= limit) {
    return { ok: false, retryAfter: Math.ceil((b.resetAt - now) / 1000), remaining: 0 };
  }
  b.count += 1;
  return { ok: true, retryAfter: 0, remaining: limit - b.count };
}

/** Best-effort client IP from standard proxy headers. */
export function clientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return request.headers.get('x-real-ip') || 'unknown';
}
