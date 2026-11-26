// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  load: vi.fn(),
  pause: vi.fn(),
  available: vi.fn(),
  scopes: [] as string[],
}));
vi.mock('node:timers/promises', () => ({ setTimeout: mocks.pause }));
vi.mock('./starter-loader', () => ({ loadStarterBatch: mocks.load, starterProductCount: 251 }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: (fn: (db: unknown) => unknown) =>
    fn({ pharmacyStarterImport: { findFirst: mocks.find } }),
  withTenantDb: async (id: string, fn: (db: unknown) => unknown) => {
    mocks.scopes.push(id);
    try {
      return await fn({ $queryRaw: mocks.available });
    } finally {
      mocks.scopes.pop();
    }
  },
}));
import { processStarterImports } from './starter-worker';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.available.mockResolvedValue([{ available: true }]);
});
it('releases the tenant transaction before pacing the next background batch', async () => {
  mocks.find
    .mockResolvedValueOnce({ organizationId: 'qa-a' })
    .mockResolvedValueOnce({ organizationId: 'qa-a' })
    .mockResolvedValue(null);
  mocks.load.mockResolvedValueOnce(250).mockResolvedValueOnce(1);
  mocks.pause.mockImplementation(async () => expect(mocks.scopes).toEqual([]));
  expect(await processStarterImports()).toEqual({ processed: 251, failed: 0 });
  expect(mocks.pause.mock.calls).toEqual([[500], [500]]);
});

it('gives an active foreground transaction priority without checking out a connection while waiting', async () => {
  mocks.find
    .mockResolvedValueOnce({ organizationId: 'qa-b' })
    .mockResolvedValueOnce({ organizationId: 'qa-b' })
    .mockResolvedValue(null);
  mocks.available.mockResolvedValueOnce([{ available: false }]);
  mocks.load.mockResolvedValueOnce(250);
  mocks.pause.mockImplementation(async () => expect(mocks.scopes).toEqual([]));
  expect(await processStarterImports()).toEqual({ processed: 250, failed: 0 });
  expect(mocks.load).toHaveBeenCalledTimes(1);
  expect(mocks.pause.mock.calls).toEqual([[100], [500]]);
});

it('makes bounded progress even when every foreground check is busy', async () => {
  let attempts = 0;
  mocks.find.mockImplementation(async () =>
    !mocks.load.mock.calls.length && ++attempts <= 25 ? { organizationId: 'qa-c' } : null
  );
  mocks.available.mockImplementation(async (_sql, graceExpired) => [
    { available: graceExpired === true },
  ]);
  mocks.load.mockResolvedValue(250);
  expect(await processStarterImports()).toEqual({ processed: 250, failed: 0 });
  expect(attempts).toBeGreaterThan(1);
});

it('gives foreground work more time after a costly write transaction', async () => {
  mocks.find.mockResolvedValueOnce({ organizationId: 'qa-d' }).mockResolvedValue(null);
  let now = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    mocks.load.mockImplementation(async () => {
      now += 200;
      return 250;
    });
    expect(await processStarterImports()).toEqual({ processed: 250, failed: 0 });
    expect(mocks.pause.mock.calls[0]![0]).toBeGreaterThanOrEqual(2000);
  } finally {
    clock.mockRestore();
  }
});
