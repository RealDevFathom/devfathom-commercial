import { APICallError } from '@ai-sdk/provider';

/**
 * How the router treats a failed provider attempt. Only availability failures move
 * to the next provider; a refusal, a bad request or a permission decision about the
 * request itself is surfaced as is.
 *
 * | kind       | example                                             | retry once        | fail over | circuit       | alert        |
 * | ---------- | --------------------------------------------------- | ----------------- | --------- | ------------- | ------------ |
 * | retryable  | connection, per-attempt timeout, 408, 5xx, 529,      | yes               | yes       | counts        | -            |
 * |            | Bedrock Throttling / ModelNotReady / ServiceUnavail. |                   |           |               |              |
 * | rate-limit | 429                                                 | if retry-after<=3s | yes      | counts        | -            |
 * | billing    | 402, quota / credit / spend stops, Marketplace      | no                | yes       | open 10 min   | log          |
 * | auth       | 401                                                 | no                | yes       | open 10 min   | notification |
 * | permission | 403, 404 (key lacks access, model not found)        | no                | yes       | open 10 min   | log          |
 * | unknown    | an error with no HTTP status (SDK or credentials)   | no                | yes       | counts        | -            |
 * | surface    | other 4xx, any 2xx APICallError, refusals            | no                | no        | -             | -            |
 * | abort      | the caller's abort or the turn deadline             | no                | no        | -             | -            |
 */
export type ProviderFailureKind =
  'retryable' | 'rate-limit' | 'billing' | 'auth' | 'permission' | 'unknown' | 'surface' | 'abort';

export type ProviderFailure = {
  kind: ProviderFailureKind;
  status?: number;
  /** Server-requested wait (retry-after-ms or retry-after), in milliseconds. */
  retryAfterMs?: number;
};

export type FailurePolicy = {
  retry: 'yes' | 'if-retry-after' | 'no';
  failover: boolean;
  circuit: 'count' | 'open-long' | 'none';
  alert: 'none' | 'log' | 'notify';
};

export const FAILURE_POLICY: Readonly<Record<ProviderFailureKind, FailurePolicy>> = {
  retryable: { retry: 'yes', failover: true, circuit: 'count', alert: 'none' },
  'rate-limit': { retry: 'if-retry-after', failover: true, circuit: 'count', alert: 'none' },
  billing: { retry: 'no', failover: true, circuit: 'open-long', alert: 'log' },
  auth: { retry: 'no', failover: true, circuit: 'open-long', alert: 'notify' },
  permission: { retry: 'no', failover: true, circuit: 'open-long', alert: 'log' },
  unknown: { retry: 'no', failover: true, circuit: 'count', alert: 'none' },
  surface: { retry: 'no', failover: false, circuit: 'none', alert: 'none' },
  abort: { retry: 'no', failover: false, circuit: 'none', alert: 'none' },
};

/** The longest server-requested wait the router honours before one retry. */
export const MAX_RETRY_AFTER_MS = 3_000;

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'ConnectionRefused',
  'ConnectionClosed',
  'FailedToOpenSocket',
]);

const BEDROCK_RETRYABLE = new Set([
  'ThrottlingException',
  'ModelNotReadyException',
  'ServiceUnavailableException',
  'InternalServerException',
  'ModelTimeoutException',
  'ModelStreamErrorException',
]);

const BILLING_TEXT =
  /insufficient_quota|exceeded your current quota|credit balance|credits?\b.*\b(?:exhausted|low|remaining)|usage limit|spend(?:ing)? limit|billing/i;
const MARKETPLACE_TEXT =
  /marketplace|subscription|not available for this account|use case details|not authorized to (?:use|invoke) this model/i;

type ErrorLike = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
  statusCode?: unknown;
  status?: unknown;
  isRetryable?: unknown;
  responseBody?: unknown;
  responseHeaders?: unknown;
  data?: unknown;
};

function asObject(value: unknown): ErrorLike | null {
  return value && typeof value === 'object' ? (value as ErrorLike) : null;
}

function isApiCallError(error: ErrorLike): boolean {
  return APICallError.isInstance(error) || error.name === 'AI_APICallError';
}

function header(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === name && typeof value === 'string') return value;
  }
  return undefined;
}

/** retry-after-ms, then retry-after (seconds or an HTTP date). */
export function retryAfterMs(headers: unknown, now = Date.now()): number | undefined {
  const ms = header(headers, 'retry-after-ms');
  if (ms !== undefined && ms.trim() && Number.isFinite(Number(ms))) {
    return Math.max(0, Number(ms));
  }
  const value = header(headers, 'retry-after')?.trim();
  if (!value) return undefined;
  if (Number.isFinite(Number(value))) return Math.max(0, Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function text(error: ErrorLike): string {
  const parts: string[] = [];
  if (typeof error.message === 'string') parts.push(error.message);
  if (typeof error.responseBody === 'string') parts.push(error.responseBody);
  if (error.data !== undefined) {
    try {
      parts.push(JSON.stringify(error.data));
    } catch {
      // Unserialisable data adds nothing to classify.
    }
  }
  return parts.join('\n');
}

/** The AWS exception name: the x-amzn-ErrorType header, the body's type, or the message prefix. */
function awsErrorType(error: ErrorLike): string | undefined {
  const fromHeader = header(error.responseHeaders, 'x-amzn-errortype');
  if (fromHeader) return fromHeader.split(':')[0].trim();
  const data = asObject(error.data) as { type?: unknown; __type?: unknown } | null;
  for (const candidate of [data?.type, data?.__type]) {
    if (typeof candidate === 'string' && candidate) return candidate.split('#').at(-1);
  }
  const body = typeof error.responseBody === 'string' ? error.responseBody : '';
  const match = /"__type"\s*:\s*"(?:[^"#]*#)?(\w+Exception)"/.exec(body);
  if (match) return match[1];
  const message = typeof error.message === 'string' ? error.message : '';
  return /^(\w+Exception)\b/.exec(message)?.[1];
}

function isNetworkError(error: ErrorLike): boolean {
  for (let current: ErrorLike | null = error, depth = 0; current && depth < 4; depth++) {
    if (typeof current.code === 'string' && NETWORK_CODES.has(current.code)) return true;
    current = asObject(current.cause);
  }
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  return error.name === 'TypeError' && /fetch failed|failed to fetch|network/.test(message);
}

/** Classify a thrown provider error. `callerAborted` covers the request signal and the turn deadline. */
export function classifyProviderError(
  error: unknown,
  input: { callerAborted?: boolean; now?: number } = {}
): ProviderFailure {
  if (input.callerAborted) return { kind: 'abort' };
  const candidate = asObject(error);
  if (!candidate) return { kind: 'unknown' };
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  if (name === 'AbortError' || name === 'ResponseAborted') return { kind: 'abort' };
  // A timeout that is not the caller's: the attempt's own fetch or socket timed out.
  if (name === 'TimeoutError') return { kind: 'retryable' };

  const rawStatus = candidate.statusCode ?? candidate.status;
  const status = typeof rawStatus === 'number' ? rawStatus : undefined;
  const apiCall = isApiCallError(candidate);
  if (status === undefined) {
    if (apiCall && candidate.isRetryable === true) return { kind: 'retryable' };
    if (isNetworkError(candidate)) return { kind: 'retryable' };
    return { kind: 'unknown' };
  }

  const retryAfter = retryAfterMs(candidate.responseHeaders, input.now);
  const failure = (kind: ProviderFailureKind): ProviderFailure =>
    retryAfter === undefined ? { kind, status } : { kind, status, retryAfterMs: retryAfter };

  // A 2xx APICallError is a response the SDK could not use (an OpenAI refusal it
  // cannot parse, for example). The provider is up; the answer is the problem.
  if (status >= 200 && status < 300) return failure('surface');

  const body = text(candidate);
  const awsType = awsErrorType(candidate);
  if (awsType && BEDROCK_RETRYABLE.has(awsType)) return failure('retryable');
  if (awsType === 'AccessDeniedException') {
    return failure(MARKETPLACE_TEXT.test(body) ? 'billing' : 'permission');
  }
  if (awsType === 'ServiceQuotaExceededException') return failure('rate-limit');

  if (status === 402) return failure('billing');
  if (status === 401) return failure('auth');
  if (status === 403) return failure(MARKETPLACE_TEXT.test(body) ? 'billing' : 'permission');
  if (status === 404) return failure(MARKETPLACE_TEXT.test(body) ? 'billing' : 'permission');
  if (status === 429) return failure(BILLING_TEXT.test(body) ? 'billing' : 'rate-limit');
  if (status === 408 || status >= 500) return failure('retryable');
  if (status === 400 && BILLING_TEXT.test(body)) return failure('billing');
  return failure('surface');
}

/**
 * Milliseconds to wait before the one retry, or null for no retry. Full jitter
 * between 0.5 and 2 s; a server-requested wait up to 3 s is honoured instead, and a
 * longer one means fail over now.
 */
export function retryDelayMs(failure: ProviderFailure, random: () => number): number | null {
  const policy = FAILURE_POLICY[failure.kind].retry;
  if (policy === 'no') return null;
  if (failure.retryAfterMs !== undefined) {
    return failure.retryAfterMs <= MAX_RETRY_AFTER_MS ? failure.retryAfterMs : null;
  }
  if (policy === 'if-retry-after') return null;
  return 500 + Math.floor(Math.min(1, Math.max(0, random())) * 1500);
}
