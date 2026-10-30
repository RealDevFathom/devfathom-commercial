// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { assertProductionClientIpConfig, clientIp } from '@/lib/rate-limit';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn(), query: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  mkdirSync: vi.fn(),
  openSync: vi.fn(() => 1),
  readFileSync: vi.fn(() => 'fixture-source'),
  writeFileSync: vi.fn(),
}));
vi.mock('pg', () => ({
  default: {
    Client: class {
      connect = vi.fn();
      query = mocks.query;
      end = vi.fn();
    },
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('starts the catering server with loopback proxy trust and reaches the browser suite', async () => {
  vi.stubEnv('CI_RESERVED_ADMIN_DATABASE_URL', 'postgresql://fixture@127.0.0.1:55683/postgres');
  vi.stubEnv('CI_CATERING_TEMPLATE_PREPARED', '1');
  vi.stubEnv('CLIENT_IP_HEADER', '');
  vi.stubEnv('TRUSTED_PROXY_CIDRS', '');
  vi.stubEnv('TRUSTED_PROXY_HOPS', '');
  const server = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    pid: 123,
    kill: vi.fn(() => {
      server.exitCode = 0;
      server.emit('exit', 0);
      return true;
    }),
  });
  mocks.spawn.mockReturnValue(server);
  mocks.spawnSync.mockImplementation((command: string) => ({
    status: 0,
    stdout: command === 'git' ? 'scripts/ci-restaurant-catering-e2e.ts\n' : '',
  }));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  vi.spyOn(console, 'log').mockImplementation(() => {});

  await import('../scripts/ci-restaurant-catering-e2e');
  await vi.waitFor(() => expect(server.kill).toHaveBeenCalledWith('SIGTERM'));
  const options = mocks.spawn.mock.calls[0]![2];
  expect(options.env).toMatchObject({
    HOSTNAME: '127.0.0.1',
    PORT: '4483',
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
    CLIENT_IP_HEADER: '',
  });
  // Next standalone enforces production configuration even though fixture seeding uses test mode.
  const productionEnv = { ...options.env, NODE_ENV: 'production' };
  expect(() => assertProductionClientIpConfig(productionEnv)).not.toThrow();
  expect(() => assertProductionClientIpConfig({ NODE_ENV: 'production' })).toThrow();
  expect(
    clientIp(
      new Request('http://localhost', {
        headers: { 'x-forwarded-for': '203.0.113.9, 127.0.0.1' },
      }),
      productionEnv
    )
  ).toBe('203.0.113.9');
  expect(mocks.spawnSync).toHaveBeenCalledWith(
    'bunx',
    expect.arrayContaining(['playwright', 'test', 'tests/e2e/restaurant-catering.spec.ts']),
    expect.any(Object)
  );
});
