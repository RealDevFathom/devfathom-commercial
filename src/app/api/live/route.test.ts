// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

// If the probe ever reached for the database, importing it here would fail.
vi.mock('@/lib/db', () => {
  throw new Error('the liveness probe must not import the database client');
});

import { dynamic, GET } from './route';

describe('GET /api/live', () => {
  it('answers 200 without touching the database, and is never cached', async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(dynamic).toBe('force-dynamic');
  });
});
