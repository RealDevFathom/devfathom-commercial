// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  load: vi.fn(),
  pause: vi.fn(),
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
      return await fn({});
    } finally {
      mocks.scopes.pop();
    }
  },
}));
import { processStarterImports } from './starter-worker';
beforeEach(() => {
  vi.resetAllMocks();
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
