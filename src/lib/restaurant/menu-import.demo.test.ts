import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ isDemoTenant: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/demo-isolation', () => ({ isDemoTenant: mocks.isDemoTenant }));

import { createMenuImportExtractHandler } from './menu-import';

describe('demo menu import worker isolation', () => {
  beforeEach(() => mocks.isDemoTenant.mockReset().mockResolvedValue(true));

  it('stops before reading an upload or invoking an extraction adapter', async () => {
    const runtime = {
      resolveAdapter: vi.fn(),
      putSource: vi.fn(),
      readSource: vi.fn(),
      deleteSource: vi.fn(),
    };
    const db = {};

    await createMenuImportExtractHandler(runtime as never)({
      db: db as never,
      job: { payload: { importId: 'import_demo' } } as never,
    });

    expect(mocks.isDemoTenant).toHaveBeenCalledWith(db);
    expect(runtime.resolveAdapter).not.toHaveBeenCalled();
    expect(runtime.readSource).not.toHaveBeenCalled();
  });
});
