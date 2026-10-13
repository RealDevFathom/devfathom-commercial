// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { $queryRaw: mocks.queryRaw } }));
import { GET } from './route';

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('GET /api/health', () => {
  it('retains successful health response', async () => {
    mocks.queryRaw.mockResolvedValue([{ result: 1 }]);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(mocks.queryRaw.mock.calls[0][0]).toEqual(['SELECT 1']);
  });

  it.each([
    new Error('postgres://fake-user:fake-password@fake-host.invalid/db SELECT private_column'),
    {
      message: 'fake-password',
      meta: { query: 'SELECT private_column', host: 'fake-host.invalid' },
    },
    'fake-password fake-host.invalid SELECT private_column',
    null,
  ])('reports only stable reason codes for a rejected query', async (error) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.queryRaw.mockRejectedValue(error);
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ status: 'unhealthy', reason: 'database_unavailable' });
    expect(log).toHaveBeenCalledExactlyOnceWith('[health]', 'database_unavailable');
    const output = JSON.stringify({ body, logs: log.mock.calls });
    for (const detail of ['fake-password', 'fake-host.invalid', 'SELECT', 'private_column']) {
      expect(output).not.toContain(detail);
    }
  });
});
