import { describe, expect, test } from 'bun:test';
import {
  classifyHealthResponse,
  detectRevenueBlocking,
  duplicateRequests,
  sanitizeDiagnostic,
  sanitizeUrl,
  summarize,
} from '../../scripts/performance/core';

describe('FastAPI health classification', () => {
  test('accepts a connected database as an eligible database benchmark', () => {
    expect(
      classifyHealthResponse(200, { status: 'ok', database: 'connected' }, 'local')
    ).toMatchObject({
      serviceStatus: 'ok',
      databaseStatus: 'connected',
      contractValid: true,
      healthGateStatus: 'passed',
      databaseBenchmarkStatus: 'eligible',
    });
  });

  test('distinguishes degraded database states and fails the remote health gate', () => {
    expect(
      classifyHealthResponse(200, { status: 'degraded', database: 'not configured' }, 'local')
    ).toMatchObject({
      serviceStatus: 'degraded',
      databaseStatus: 'not configured',
      healthGateStatus: 'warning',
      databaseBenchmarkStatus: 'skipped',
    });
    expect(
      classifyHealthResponse(200, { status: 'degraded', database: 'unavailable' }, 'remote')
    ).toMatchObject({
      serviceStatus: 'degraded',
      databaseStatus: 'unavailable',
      healthGateStatus: 'failed',
      databaseBenchmarkStatus: 'skipped',
    });
  });

  test('fails malformed health JSON without inventing a database benchmark', () => {
    expect(classifyHealthResponse(200, undefined, 'local')).toMatchObject({
      serviceStatus: 'unknown',
      databaseStatus: 'unknown',
      contractValid: false,
      healthGateStatus: 'failed',
      databaseBenchmarkStatus: 'failed',
    });
  });

  test('fails non-200 health responses even when their JSON looks connected', () => {
    expect(
      classifyHealthResponse(503, { status: 'ok', database: 'connected' }, 'remote')
    ).toMatchObject({
      httpStatus: 503,
      serviceStatus: 'ok',
      databaseStatus: 'connected',
      healthGateStatus: 'failed',
      databaseBenchmarkStatus: 'failed',
    });
  });
});

describe('performance statistics', () => {
  test('keeps cold samples distinct and reports warm percentiles when enough samples exist', () => {
    expect(summarize([11])).toMatchObject({ samples: 1, p50Ms: null, p95Ms: null });
    expect(summarize([1, 2, 3, 4, 5])).toMatchObject({
      samples: 5,
      p50Ms: 3,
      p95Ms: 4.8,
    });
  });
});

describe('secret-safe output', () => {
  test('removes credentials, tokens, database URLs, cookies, and URL queries', () => {
    const password = 'correct horse battery staple';
    const diagnostic = sanitizeDiagnostic(
      `password=${password} Authorization: Bearer abc.def.ghi Cookie: session=secret DATABASE_URL=postgresql://user:pass@db.example/app https://example.com/path?token=secret`,
      [password]
    );

    expect(diagnostic).not.toContain(password);
    expect(diagnostic).not.toContain('abc.def.ghi');
    expect(diagnostic).not.toContain('session=secret');
    expect(diagnostic).not.toContain('user:pass');
    expect(diagnostic).not.toContain('token=secret');
    expect(diagnostic).toContain('https://example.com/path');
  });

  test('normalizes trace URLs without query strings or fragments', () => {
    expect(sanitizeUrl('https://example.com/api/items?token=sensitive#result')).toBe(
      'https://example.com/api/items'
    );
  });
});

describe('dashboard request analysis', () => {
  test('identifies duplicate requests within one navigation', () => {
    expect(
      duplicateRequests([
        { method: 'GET', url: 'http://localhost:8000/api/dashboard/stats' },
        { method: 'GET', url: 'http://localhost:8000/api/dashboard/stats' },
        { method: 'GET', url: 'http://localhost:8000/api/dashboard/activity' },
      ])
    ).toEqual([{ key: 'GET http://localhost:8000/api/dashboard/stats', count: 2 }]);
  });

  test('uses the revenue completion timeline to classify first-visible blocking', () => {
    expect(detectRevenueBlocking(900, 850, true).status).toBe('blocking');
    expect(detectRevenueBlocking(700, 850, true).status).toBe('not-blocking');
    expect(detectRevenueBlocking(700, null, false).status).toBe('not-requested');
  });
});
