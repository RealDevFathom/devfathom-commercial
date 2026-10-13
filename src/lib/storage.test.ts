// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const io = vi.hoisted(() => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
  credential: vi.fn(),
  service: vi.fn(),
  container: vi.fn(),
  blob: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock('node:fs/promises', () => io);
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {
    constructor() {
      io.credential();
    }
  },
}));
vi.mock('@azure/storage-blob', () => ({
  BlobServiceClient: class {
    constructor(...args: unknown[]) {
      io.service(...args);
    }
    getContainerClient = io.container;
  },
}));
import {
  assertStorageAvailable,
  getStorageAvailability,
  putUpload,
  getUpload,
  deleteUpload,
  StorageUnavailableError,
} from './storage';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', io.fetch);
  vi.stubEnv('STORAGE_ADAPTER', 'disabled');
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('AZURE_STORAGE_ACCOUNT_NAME', 'inertaccount');
  vi.stubEnv('AZURE_STORAGE_CONTAINER', 'inert-container');
  io.container.mockReturnValue({ getBlockBlobClient: io.blob });
  io.blob.mockReturnValue({
    uploadData: io.upload,
    downloadToBuffer: io.download,
    deleteIfExists: io.remove,
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const unavailable = [
  { STORAGE_ADAPTER: undefined },
  { STORAGE_ADAPTER: '' },
  { STORAGE_ADAPTER: '  ' },
  { STORAGE_ADAPTER: 'disabled' },
  { STORAGE_ADAPTER: 'unknown' },
  { STORAGE_ADAPTER: 'local', NODE_ENV: 'production' },
  { STORAGE_ADAPTER: 'local', NODE_ENV: undefined },
  { STORAGE_ADAPTER: 'local', NODE_ENV: 'staging' },
  { STORAGE_ADAPTER: 'azure', AZURE_STORAGE_ACCOUNT_NAME: '' },
  { STORAGE_ADAPTER: 'azure', AZURE_STORAGE_CONTAINER: ' ' },
];
test.each(unavailable)('unavailable %j performs zero I/O for all operations', async (env) => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  expect(getStorageAvailability().available).toBe(false);
  expect(() => assertStorageAvailable()).toThrow(StorageUnavailableError);
  const outcomes = await Promise.allSettled([
    putUpload('org-a', 'file.png', Buffer.from('bytes'), 'image/png'),
    getUpload('org-a', 'file.png'),
    deleteUpload('org-a', 'file.png'),
  ]);
  for (const outcome of outcomes) {
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected')
      expect(outcome.reason).toMatchObject({
        code: 'STORAGE_UNAVAILABLE',
        message: 'Storage is unavailable.',
      });
  }
  for (const operation of Object.values(io)) expect(operation).not.toHaveBeenCalled();
});
test('preflight is pure and returns stable reasons', () => {
  expect(getStorageAvailability({})).toEqual({ available: false, reason: 'disabled' });
  expect(getStorageAvailability({ STORAGE_ADAPTER: 'typo' })).toEqual({
    available: false,
    reason: 'invalid_configuration',
  });
  expect(
    assertStorageAvailable({
      STORAGE_ADAPTER: 'azure',
      AZURE_STORAGE_ACCOUNT_NAME: 'fake',
      AZURE_STORAGE_CONTAINER: 'fake',
    }).adapter
  ).toBe('azure');
  for (const operation of Object.values(io)) expect(operation).not.toHaveBeenCalled();
});
test.each(['test', 'development'])(
  'explicit local in %s uses only fake filesystem',
  async (mode) => {
    vi.stubEnv('STORAGE_ADAPTER', 'local');
    vi.stubEnv('NODE_ENV', mode);
    const bytes = Buffer.from('data');
    io.readFile.mockResolvedValue(bytes);
    await putUpload('org-a', 'file.png', bytes, 'image/png');
    expect(await getUpload('org-a', 'file.png')).toBe(bytes);
    await deleteUpload('org-a', 'file.png');
    expect(io.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('/private-uploads/org-a/file.png'),
      bytes
    );
    expect(io.rm).toHaveBeenCalledWith(expect.stringContaining('/private-uploads/org-a/file.png'), {
      force: true,
    });
    expect(io.service).not.toHaveBeenCalled();
    expect(io.credential).not.toHaveBeenCalled();
  }
);
test('configured Azure uses fake SDK and disabling afterward blocks cached client', async () => {
  vi.stubEnv('STORAGE_ADAPTER', 'azure');
  const bytes = Buffer.from('data');
  io.download.mockResolvedValue(bytes);
  await putUpload('org-a', 'file.png', bytes, 'image/png');
  expect(await getUpload('org-a', 'file.png')).toBe(bytes);
  await deleteUpload('org-a', 'file.png');
  expect(io.credential).toHaveBeenCalledOnce();
  expect(io.service).toHaveBeenCalledOnce();
  expect(io.blob).toHaveBeenCalledWith('org-a/file.png');
  expect(io.upload).toHaveBeenCalledWith(bytes, {
    blobHTTPHeaders: { blobContentType: 'image/png' },
  });
  expect(io.remove).toHaveBeenCalledOnce();
  for (const fn of [io.mkdir, io.readFile, io.rm, io.writeFile, io.fetch])
    expect(fn).not.toHaveBeenCalled();
  vi.clearAllMocks();
  vi.stubEnv('STORAGE_ADAPTER', 'disabled');
  await expect(deleteUpload('org-a', 'file.png')).rejects.toBeInstanceOf(StorageUnavailableError);
  for (const fn of Object.values(io)) expect(fn).not.toHaveBeenCalled();
});
test('local delete failure rejects rather than claiming retention cleanup', async () => {
  vi.stubEnv('STORAGE_ADAPTER', 'local');
  vi.stubEnv('NODE_ENV', 'test');
  const failure = new Error('fake filesystem denied');
  io.rm.mockRejectedValue(failure);
  await expect(deleteUpload('org-a', 'file.png')).rejects.toBe(failure);
});
