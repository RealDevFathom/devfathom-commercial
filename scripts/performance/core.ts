export interface NumericSummary {
  samples: number;
  valuesMs: number[];
  minMs: number | null;
  maxMs: number | null;
  meanMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface SanitizedRequest {
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  durationMs?: number;
  failed?: boolean;
}

export interface DuplicateRequest {
  key: string;
  count: number;
}

export interface RevenueBlockingResult {
  status: 'blocking' | 'not-blocking' | 'not-requested' | 'indeterminate';
  requestFinishedMs: number | null;
  firstVisibleMs: number;
  gapMs: number | null;
  evidence: string;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentile(sorted: number[], quantile: number): number {
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

export function summarize(values: number[]): NumericSummary {
  const sorted = values
    .filter(Number.isFinite)
    .map(round)
    .sort((a, b) => a - b);
  if (!sorted.length) {
    return {
      samples: 0,
      valuesMs: [],
      minMs: null,
      maxMs: null,
      meanMs: null,
      p50Ms: null,
      p95Ms: null,
    };
  }

  return {
    samples: sorted.length,
    valuesMs: sorted,
    minMs: sorted[0]!,
    maxMs: sorted.at(-1)!,
    meanMs: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p50Ms: sorted.length >= 2 ? round(percentile(sorted, 0.5)) : null,
    p95Ms: sorted.length >= 5 ? round(percentile(sorted, 0.95)) : null,
  };
}

export function sanitizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'data:') return 'data:[redacted]';
    if (url.protocol === 'blob:') return `blob:${url.origin}/[redacted]`;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return `${url.protocol}[redacted]`;
    return `${url.origin}${url.pathname}`;
  } catch {
    return rawUrl.split(/[?#]/, 1)[0] || '[invalid-url]';
  }
}

export function sanitizeDiagnostic(input: string, secrets: string[] = []): string {
  let output = input;
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join('[REDACTED]');
  }

  output = output
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[JWT REDACTED]')
    .replace(
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"')]+/gi,
      '[DATABASE_URL REDACTED]'
    )
    .replace(
      /\b(authorization|cookie|set-cookie|password|database_url)\s*[:=]\s*([^\s,;]+)/gi,
      '$1=[REDACTED]'
    )
    .replace(/https?:\/\/[^\s"'<>]+/g, (url) => sanitizeUrl(url));

  return output.slice(0, 1_000);
}

export function duplicateRequests(requests: SanitizedRequest[]): DuplicateRequest[] {
  const counts = new Map<string, number>();
  for (const request of requests) {
    const key = `${request.method.toUpperCase()} ${request.url}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

export function detectRevenueBlocking(
  firstVisibleMs: number,
  revenueRequestFinishedMs: number | null,
  requested: boolean,
  failed = false
): RevenueBlockingResult {
  if (!requested) {
    return {
      status: 'not-requested',
      requestFinishedMs: null,
      firstVisibleMs: round(firstVisibleMs),
      gapMs: null,
      evidence: 'No revenue-chart request was observed for this dashboard sample.',
    };
  }
  if (failed || revenueRequestFinishedMs === null) {
    return {
      status: 'indeterminate',
      requestFinishedMs: revenueRequestFinishedMs,
      firstVisibleMs: round(firstVisibleMs),
      gapMs: null,
      evidence: 'The revenue-chart request did not complete successfully.',
    };
  }

  const gap = firstVisibleMs - revenueRequestFinishedMs;
  const blocking = gap >= -25;
  return {
    status: blocking ? 'blocking' : 'not-blocking',
    requestFinishedMs: round(revenueRequestFinishedMs),
    firstVisibleMs: round(firstVisibleMs),
    gapMs: round(gap),
    evidence: blocking
      ? 'First visible dashboard data appeared only after the revenue-chart request completed.'
      : 'First visible dashboard data appeared before the revenue-chart request completed.',
  };
}
