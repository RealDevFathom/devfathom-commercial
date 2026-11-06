import { APICallError } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';

import {
  FAILURE_POLICY,
  classifyProviderError,
  retryAfterMs,
  retryDelayMs,
  type ProviderFailureKind,
} from './provider-errors';

const apiError = (
  statusCode: number | undefined,
  extra: {
    body?: string;
    headers?: Record<string, string>;
    data?: unknown;
    isRetryable?: boolean;
    message?: string;
  } = {}
) =>
  new APICallError({
    message: extra.message ?? `HTTP ${statusCode ?? 'none'}`,
    url: 'https://provider.invalid/v1',
    requestBodyValues: {},
    statusCode,
    responseHeaders: extra.headers,
    responseBody: extra.body,
    isRetryable: extra.isRetryable,
    data: extra.data,
  });

const kind = (error: unknown, callerAborted = false) =>
  classifyProviderError(error, { callerAborted, now: 0 }).kind;

describe('failover classification, row by row', () => {
  it('row 1: connection errors, retryable fetch errors and per-attempt timeouts retry and fail over', () => {
    // provider-utils wraps "Cannot connect to API" as a retryable APICallError with no status.
    expect(kind(apiError(undefined, { isRetryable: true, message: 'Cannot connect to API' }))).toBe(
      'retryable'
    );
    expect(kind(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(
      'retryable'
    );
    expect(
      kind(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } }))
    ).toBe('retryable');
    expect(kind(new DOMException('Step timeout of 30000ms exceeded', 'TimeoutError'))).toBe(
      'retryable'
    );
    expect(FAILURE_POLICY.retryable).toEqual({
      retry: 'yes',
      failover: true,
      circuit: 'count',
      alert: 'none',
    });
  });

  it.each([408, 500, 502, 503, 504, 529])('row 2: HTTP %i retries and fails over', (status) => {
    expect(kind(apiError(status))).toBe('retryable');
  });

  it.each([
    'ThrottlingException',
    'ModelNotReadyException',
    'ServiceUnavailableException',
    'InternalServerException',
  ])('row 2: Bedrock %s (x-amzn-ErrorType) retries and fails over', (type) => {
    const status = type === 'ThrottlingException' || type === 'ModelNotReadyException' ? 429 : 503;
    expect(
      kind(
        apiError(status, { headers: { 'x-amzn-errortype': `${type}:http://internal.amazon.com/` } })
      )
    ).toBe('retryable');
    // The same name in the body message, as the Bedrock provider formats it.
    expect(kind(apiError(status, { message: `${type}: Too many requests` }))).toBe('retryable');
  });

  it('row 3: a 429 rate limit retries only when retry-after is at most 3 s', () => {
    const quick = classifyProviderError(apiError(429, { headers: { 'retry-after': '2' } }), {
      now: 0,
    });
    expect(quick).toEqual({ kind: 'rate-limit', status: 429, retryAfterMs: 2000 });
    expect(retryDelayMs(quick, () => 0.5)).toBe(2000);
    const slow = classifyProviderError(apiError(429, { headers: { 'retry-after': '30' } }), {
      now: 0,
    });
    expect(retryDelayMs(slow, () => 0.5)).toBeNull();
    const silent = classifyProviderError(apiError(429), { now: 0 });
    expect(retryDelayMs(silent, () => 0.5)).toBeNull();
    expect(FAILURE_POLICY['rate-limit'].failover).toBe(true);
    expect(FAILURE_POLICY['rate-limit'].circuit).toBe('count');
  });

  it('row 4: billing and quota stops fail over without retry and open the circuit for 10 min', () => {
    expect(kind(apiError(402))).toBe('billing');
    expect(
      kind(
        apiError(429, {
          data: {
            error: { code: 'insufficient_quota', message: 'You exceeded your current quota' },
          },
        })
      )
    ).toBe('billing');
    expect(
      kind(
        apiError(400, {
          body: '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
        })
      )
    ).toBe('billing');
    expect(kind(apiError(400, { body: 'You have reached your specified API usage limits.' }))).toBe(
      'billing'
    );
    expect(
      kind(
        apiError(403, {
          headers: { 'x-amzn-errortype': 'AccessDeniedException:http://internal.amazon.com/' },
          message:
            'Model access is denied due to IAM user or service role is not authorized to perform the required AWS Marketplace actions',
        })
      )
    ).toBe('billing');
    expect(
      kind(
        apiError(404, {
          message: 'Model use case details have not been submitted for this account.',
        })
      )
    ).toBe('billing');
    expect(FAILURE_POLICY.billing).toEqual({
      retry: 'no',
      failover: true,
      circuit: 'open-long',
      alert: 'log',
    });
  });

  it('row 5: 401 fails over, opens the circuit for 10 min and notifies SuperAdmins', () => {
    expect(kind(apiError(401))).toBe('auth');
    expect(FAILURE_POLICY.auth).toEqual({
      retry: 'no',
      failover: true,
      circuit: 'open-long',
      alert: 'notify',
    });
  });

  it('row 6: 403 and 404 from the provider fail over and open the circuit for 10 min', () => {
    expect(kind(apiError(403, { message: 'permission_error' }))).toBe('permission');
    expect(kind(apiError(404, { message: 'model: devfathom-smoke-missing-model' }))).toBe(
      'permission'
    );
    expect(
      kind(
        apiError(403, {
          headers: { 'x-amzn-errortype': 'AccessDeniedException' },
          message: 'User is not authorized to perform: bedrock:InvokeModelWithResponseStream',
        })
      )
    ).toBe('permission');
    expect(FAILURE_POLICY.permission.circuit).toBe('open-long');
    expect(FAILURE_POLICY.permission.failover).toBe(true);
  });

  it.each([
    ['other 400', apiError(400, { body: 'messages: text content blocks must be non-empty' })],
    ['413', apiError(413)],
    ['422', apiError(422)],
    ['Bedrock ValidationException', apiError(400, { message: 'ValidationException: bad input' })],
    [
      'a 2xx APICallError (OpenAI refusal it cannot parse)',
      apiError(200, { message: 'Invalid JSON response' }),
    ],
  ])('row 7: %s is surfaced as is: no retry, no failover, no circuit', (_label, error) => {
    expect(kind(error)).toBe('surface');
    expect(FAILURE_POLICY.surface).toEqual({
      retry: 'no',
      failover: false,
      circuit: 'none',
      alert: 'none',
    });
  });

  it("row 8: the caller's abort and the turn deadline are never retried or failed over", () => {
    expect(kind(apiError(529), true)).toBe('abort');
    expect(kind(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe('abort');
    expect(FAILURE_POLICY.abort).toEqual({
      retry: 'no',
      failover: false,
      circuit: 'none',
      alert: 'none',
    });
  });

  it('treats an error with no HTTP status as an availability failure without a retry', () => {
    expect(kind(new Error('Could not load credentials from any providers'))).toBe('unknown');
    expect(FAILURE_POLICY.unknown).toEqual({
      retry: 'no',
      failover: true,
      circuit: 'count',
      alert: 'none',
    });
  });

  it('covers every kind in the policy table', () => {
    const kinds: ProviderFailureKind[] = [
      'retryable',
      'rate-limit',
      'billing',
      'auth',
      'permission',
      'unknown',
      'surface',
      'abort',
    ];
    expect(Object.keys(FAILURE_POLICY).sort()).toEqual([...kinds].sort());
  });
});

describe('retry delay', () => {
  it('uses full jitter between 0.5 and 2 s', () => {
    const failure = { kind: 'retryable' as const };
    expect(retryDelayMs(failure, () => 0)).toBe(500);
    expect(retryDelayMs(failure, () => 0.999999)).toBe(1999);
    expect(retryDelayMs(failure, () => 0.5)).toBe(1250);
  });

  it('honours retry-after up to 3 s and fails over now beyond it', () => {
    expect(retryDelayMs({ kind: 'retryable', retryAfterMs: 3000 }, () => 0)).toBe(3000);
    expect(retryDelayMs({ kind: 'retryable', retryAfterMs: 3001 }, () => 0)).toBeNull();
    expect(retryDelayMs({ kind: 'auth' }, () => 0)).toBeNull();
  });

  it('reads retry-after-ms, retry-after seconds and an HTTP date', () => {
    expect(retryAfterMs({ 'retry-after-ms': '750' })).toBe(750);
    expect(retryAfterMs({ 'Retry-After': '2' })).toBe(2000);
    const now = Date.parse('2026-11-02T12:00:00Z');
    expect(retryAfterMs({ 'retry-after': 'Mon, 02 Nov 2026 12:00:02 GMT' }, now)).toBe(2000);
    expect(retryAfterMs({})).toBeUndefined();
  });
});
