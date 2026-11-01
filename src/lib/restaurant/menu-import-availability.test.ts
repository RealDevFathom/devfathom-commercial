import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
const mocks = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock('@/lib/restaurant/scheduler', () => ({ enqueue: mocks.enqueue }));
import {
  defaultMenuImportRuntime,
  configuredAdapterName,
  createMenuImport,
  runMenuImportExtraction,
  discardMenuImport,
  purgeStaleMenuImports,
  commitMenuImport,
  getMenuImportAvailability,
} from './menu-import';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const input = { fileName: 'menu.png', content: PNG, createdById: 'user_1' };
function fake() {
  const record = {
    id: 'imp_1',
    organizationId: 'org_1',
    status: 'PENDING_EXTRACTION',
    adapter: 'FIXTURE',
    storageObjectName: 'menu.png',
    sourceDeletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    mimeType: 'image/png',
    pageCount: 1,
    defaultCurrency: null,
  };
  const table = {
    findFirst: vi.fn(async () => null),
    findUnique: vi.fn<
      (args: { where: { id: string; organizationId?: string } }) => Promise<typeof record | null>
    >(async () => record),
    findMany: vi.fn(async () => [record]),
    create: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(async ({ data }) => Object.assign(record, data)),
  };
  const db = {
    $queryRaw: vi.fn(async () => []),
    restaurantMenuImport: table,
    restaurantMenuImportLine: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn) => fn(db));
  const runtime = {
    resolveAdapter: vi.fn(),
    readSource: vi.fn(),
    putSource: vi.fn(),
    deleteSource: vi.fn(async () => {}),
  };
  return { db: db as unknown as ScopedDb, table, record, runtime };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('MENU_IMPORT_ADAPTER', 'FIXTURE');
  vi.stubEnv('AI_PROVIDER', 'disabled');
  vi.stubEnv('STORAGE_ADAPTER', 'local');
});
afterEach(() => vi.unstubAllEnvs());

describe('explicit extraction selection', () => {
  it('runs the configured fixture through the HTTP and worker runtime in a test sandbox', async () => {
    const adapter = defaultMenuImportRuntime.resolveAdapter('FIXTURE');
    const extracted = await adapter.extract({
      content: PNG,
      mimeType: 'image/png',
      pageCount: 1,
      defaultCurrency: 'PKR',
      importId: 'imp_1',
    });
    expect(extracted.pages[0].lines.map((line) => line.productName)).toContain(
      'Chicken Malai Boti'
    );
  });

  it('refuses the fixture runtime in production even if explicitly selected', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => defaultMenuImportRuntime.resolveAdapter('FIXTURE')).toThrow(
      expect.objectContaining({ reason: 'ADAPTER_UNAVAILABLE' })
    );
  });

  for (const node of [undefined, 'production', 'test', 'development', 'Development']) {
    for (const adapter of [undefined, '', ' ', 'typo', 'disabled', 'VISION', 'FIXTURE']) {
      for (const ai of ['disabled', 'google']) {
        it(`${String(node)} / ${String(adapter)} / ${ai}`, () => {
          const env = { NODE_ENV: node, MENU_IMPORT_ADAPTER: adapter, AI_PROVIDER: ai };
          const allowed =
            (adapter === 'FIXTURE' && ['test', 'development'].includes(node ?? '')) ||
            (adapter === 'VISION' && ai === 'google');
          if (allowed) expect(configuredAdapterName(env)).toBe(adapter);
          else
            expect(() => configuredAdapterName(env)).toThrow(
              expect.objectContaining({ reason: 'ADAPTER_UNAVAILABLE' })
            );
        });
      }
    }
  }
});

describe('write-free unavailable uploads', () => {
  it.each([undefined, '', ' ', 'typo', 'disabled', 'VISION'])(
    'blocks %s before row, object or job writes',
    async (adapter) => {
      vi.stubEnv('MENU_IMPORT_ADAPTER', adapter);
      const { db, table, runtime } = fake();
      await expect(createMenuImport(db, 'org_1', input, { runtime })).rejects.toMatchObject({
        reason: 'ADAPTER_UNAVAILABLE',
      });
      expect(table.create).not.toHaveBeenCalled();
      expect(table.update).not.toHaveBeenCalled();
      expect(runtime.putSource).not.toHaveBeenCalled();
      expect(runtime.resolveAdapter).not.toHaveBeenCalled();
      expect(runtime.readSource).not.toHaveBeenCalled();
      expect(mocks.enqueue).not.toHaveBeenCalled();
    }
  );
  it.each(['production', undefined])(
    'rejects input FIXTURE in %s even when configured',
    async (node) => {
      vi.stubEnv('NODE_ENV', node);
      const { db, table, runtime } = fake();
      await expect(
        createMenuImport(db, 'org_1', { ...input, adapter: 'FIXTURE' }, { runtime })
      ).rejects.toMatchObject({ reason: 'ADAPTER_UNAVAILABLE' });
      expect(table.create).not.toHaveBeenCalled();
      expect(runtime.putSource).not.toHaveBeenCalled();
      expect(mocks.enqueue).not.toHaveBeenCalled();
    }
  );
  it('does not let an input adapter override disabled configuration', async () => {
    vi.stubEnv('MENU_IMPORT_ADAPTER', 'disabled');
    const { db, table, runtime } = fake();
    await expect(
      createMenuImport(db, 'org_1', { ...input, adapter: 'FIXTURE' }, { runtime })
    ).rejects.toMatchObject({ reason: 'ADAPTER_UNAVAILABLE' });
    expect(table.create).not.toHaveBeenCalled();
    expect(runtime.putSource).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it.each([undefined, '', 'disabled', 'typo'])(
    'preflights storage %s before writes',
    async (storage) => {
      vi.stubEnv('STORAGE_ADAPTER', storage);
      const { db, table, runtime } = fake();
      await expect(createMenuImport(db, 'org_1', input, { runtime })).rejects.toMatchObject({
        code: 'STORAGE_UNAVAILABLE',
      });
      expect(table.create).not.toHaveBeenCalled();
      expect(table.update).not.toHaveBeenCalled();
      expect(runtime.putSource).not.toHaveBeenCalled();
      expect(mocks.enqueue).not.toHaveBeenCalled();
    }
  );
  it.each(['test', 'development'])(
    'allows explicitly configured FIXTURE upload in %s',
    async (node) => {
      vi.stubEnv('NODE_ENV', node);
      const { db, table, runtime, record } = fake();
      table.create.mockResolvedValue({ ...record, storageObjectName: null });
      mocks.enqueue.mockResolvedValue({ job: { id: 'job_1' } });
      await expect(createMenuImport(db, 'org_1', input, { runtime })).resolves.toMatchObject({
        importId: 'imp_1',
        deduplicated: false,
      });
      expect(table.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ adapter: 'FIXTURE' }) })
      );
      expect(runtime.putSource).toHaveBeenCalledOnce();
      expect(mocks.enqueue).toHaveBeenCalledOnce();
    }
  );
  it('rejects a mismatched explicit adapter even when global AI is available', async () => {
    vi.stubEnv('MENU_IMPORT_ADAPTER', 'VISION');
    vi.stubEnv('AI_PROVIDER', 'google');
    const { db, table, runtime } = fake();
    await expect(
      createMenuImport(db, 'org_1', { ...input, adapter: 'FIXTURE' }, { runtime })
    ).rejects.toMatchObject({ reason: 'ADAPTER_UNAVAILABLE' });
    expect(table.create).not.toHaveBeenCalled();
    expect(runtime.putSource).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('publishes only a boolean and safe explanation', () => {
    vi.stubEnv('STORAGE_ADAPTER', 'azure');
    vi.stubEnv('AZURE_STORAGE_ACCOUNT_NAME', 'fake-account');
    vi.stubEnv('AZURE_STORAGE_CONTAINER', 'fake-container');
    expect(getMenuImportAvailability()).toEqual({ available: true, explanation: null });
    vi.stubEnv('STORAGE_ADAPTER', 'disabled');
    expect(getMenuImportAvailability()).toEqual({
      available: false,
      explanation: expect.stringContaining('manually'),
    });
  });
});

describe('queued availability', () => {
  it.each(['production', undefined])(
    'fails stored FIXTURE in %s without source or selector calls or retries',
    async (node) => {
      vi.stubEnv('NODE_ENV', node);
      const { db, record, runtime } = fake();
      await expect(runMenuImportExtraction(db, record.id, { runtime })).resolves.toMatchObject({
        status: 'EXTRACTION_FAILED',
        lineCount: 0,
      });
      expect(record).toMatchObject({
        status: 'EXTRACTION_FAILED',
        storageObjectName: 'menu.png',
        failureReason: 'Menu extraction is unavailable.',
      });
      expect(runtime.readSource).not.toHaveBeenCalled();
      expect(runtime.resolveAdapter).not.toHaveBeenCalled();
      await expect(runMenuImportExtraction(db, record.id, { runtime })).resolves.toMatchObject({
        status: 'SKIPPED',
      });
    }
  );
  it('fails stored VISION when AI is disabled', async () => {
    vi.stubEnv('MENU_IMPORT_ADAPTER', 'VISION');
    const { db, record, runtime } = fake();
    record.adapter = 'VISION';
    await expect(runMenuImportExtraction(db, record.id, { runtime })).resolves.toMatchObject({
      status: 'EXTRACTION_FAILED',
    });
    expect(runtime.readSource).not.toHaveBeenCalled();
    expect(runtime.resolveAdapter).not.toHaveBeenCalled();
  });
  it('fails unavailable storage without retry churn', async () => {
    vi.stubEnv('STORAGE_ADAPTER', 'disabled');
    const { db, record, runtime } = fake();
    await expect(runMenuImportExtraction(db, record.id, { runtime })).resolves.toMatchObject({
      status: 'EXTRACTION_FAILED',
    });
    expect(runtime.readSource).not.toHaveBeenCalled();
    expect(runtime.resolveAdapter).not.toHaveBeenCalled();
  });
});

describe('retention survives failed deletion', () => {
  it('purges an eligible import only within its snapshotted organization', async () => {
    const { db, record, table, runtime } = fake();
    table.findMany.mockResolvedValueOnce([record]).mockResolvedValueOnce([]);

    await expect(purgeStaleMenuImports(db, { runtime })).resolves.toEqual({
      purgedDrafts: 1,
      deletedSources: 1,
    });

    expect(runtime.deleteSource).toHaveBeenCalledWith(
      record.organizationId,
      record.storageObjectName
    );
    expect(table.delete).toHaveBeenCalledWith({
      where: { id: record.id, organizationId: record.organizationId },
    });
  });

  it('rechecks a stale import under the commit lock before deleting it', async () => {
    const { db, record, table, runtime } = fake();
    table.findMany.mockResolvedValueOnce([record]).mockResolvedValueOnce([]);
    table.findUnique.mockImplementation(async () => ({
      ...record,
      status: 'COMMITTED',
    }));

    await expect(purgeStaleMenuImports(db, { runtime })).resolves.toEqual({
      purgedDrafts: 0,
      deletedSources: 0,
    });

    expect(db.$queryRaw).toHaveBeenCalledOnce();
    expect(vi.mocked(db.$queryRaw).mock.invocationCallOrder[0]).toBeLessThan(
      table.findUnique.mock.invocationCallOrder[0]!
    );
    expect(table.findUnique).toHaveBeenCalledWith({
      where: { id: record.id, organizationId: record.organizationId },
      select: {
        organizationId: true,
        status: true,
        storageObjectName: true,
        createdAt: true,
      },
    });
    expect(runtime.deleteSource).not.toHaveBeenCalled();
    expect(table.delete).not.toHaveBeenCalled();
  });

  it('rechecks the retention cutoff under the commit lock before deleting it', async () => {
    const { db, record, table, runtime } = fake();
    table.findMany.mockResolvedValueOnce([record]).mockResolvedValueOnce([]);
    table.findUnique.mockResolvedValue({
      ...record,
      createdAt: new Date('2026-10-26T00:00:00.000Z'),
    });

    await expect(
      purgeStaleMenuImports(db, { runtime, now: new Date('2026-10-26T12:00:00.000Z') })
    ).resolves.toEqual({ purgedDrafts: 0, deletedSources: 0 });

    expect(runtime.deleteSource).not.toHaveBeenCalled();
    expect(table.delete).not.toHaveBeenCalled();
  });

  it('does not cross the stale snapshot organization boundary', async () => {
    const { db, record, table, runtime } = fake();
    record.organizationId = 'org_snapshot';
    table.findMany.mockResolvedValueOnce([record]).mockResolvedValueOnce([]);
    table.findUnique.mockImplementation(async ({ where }) =>
      where.organizationId === 'org_actual'
        ? {
            ...record,
            organizationId: 'org_actual',
          }
        : null
    );

    await expect(purgeStaleMenuImports(db, { runtime })).resolves.toEqual({
      purgedDrafts: 0,
      deletedSources: 0,
    });

    expect(db.$queryRaw).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining('"organizationId" = ')]),
      record.id,
      record.organizationId
    );
    expect(table.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: record.id, organizationId: record.organizationId },
      })
    );
    expect(runtime.deleteSource).not.toHaveBeenCalled();
    expect(table.delete).not.toHaveBeenCalled();
  });

  it('discard keeps the persisted source obligation on deletion failure', async () => {
    const { db, record, runtime } = fake();
    runtime.deleteSource.mockRejectedValue(new Error('storage unavailable'));
    await expect(discardMenuImport(db, record.id, 'user_1', { runtime })).rejects.toThrow(
      'storage unavailable'
    );
    expect(record).toMatchObject({
      status: 'DISCARDED',
      storageObjectName: 'menu.png',
      sourceDeletedAt: null,
    });
  });
  it('purge does not delete the row when storage deletion fails', async () => {
    const { db, record, table, runtime } = fake();
    runtime.deleteSource.mockRejectedValue(new Error('storage unavailable'));
    await expect(purgeStaleMenuImports(db, { runtime })).rejects.toThrow('storage unavailable');
    expect(table.delete).not.toHaveBeenCalled();
    expect(record.storageObjectName).toBe('menu.png');
  });
  it('committed replay retries cleanup without catalog writes', async () => {
    const { db, record, table, runtime } = fake();
    record.status = 'COMMITTED';
    runtime.deleteSource.mockRejectedValueOnce(new Error('storage unavailable'));
    const commit = () =>
      commitMenuImport(db, { importId: record.id, committedById: 'user_1' }, { runtime });
    await expect(commit()).rejects.toThrow('storage unavailable');
    expect(record).toMatchObject({
      status: 'COMMITTED',
      storageObjectName: 'menu.png',
      sourceDeletedAt: null,
    });
    await expect(commit()).resolves.toMatchObject({
      alreadyCommitted: true,
      createdProductIds: [],
    });
    expect(record.storageObjectName).toBeNull();
    expect(record.sourceDeletedAt).toBeInstanceOf(Date);
    expect(table.create).not.toHaveBeenCalled();
    expect(runtime.deleteSource).toHaveBeenCalledTimes(2);
  });
});
