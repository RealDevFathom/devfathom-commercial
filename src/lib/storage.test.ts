// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { resolve } from 'node:path';
const io = vi.hoisted(() => ({
  realpath: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
  stat: vi.fn(),
  copyFile: vi.fn(),
  createReadStream: vi.fn(),
  fetch: vi.fn(),
  s3client: vi.fn(),
  s3send: vi.fn(),
}));
vi.mock('node:fs/promises', () => io);
vi.mock('node:fs', () => ({ realpathSync: io.realpath, createReadStream: io.createReadStream }));
vi.mock('@aws-sdk/client-s3', () => {
  const command = (name: string) =>
    class {
      readonly command = name;
      constructor(readonly input: Record<string, unknown>) {}
    };
  return {
    S3Client: class {
      constructor(...args: unknown[]) {
        io.s3client(...args);
      }
      send = io.s3send;
    },
    PutObjectCommand: command('PutObject'),
    GetObjectCommand: command('GetObject'),
    DeleteObjectCommand: command('DeleteObject'),
  };
});
import {
  assertStorageAvailable,
  getStorageAvailability,
  putUpload,
  getUpload,
  getUploadStream,
  putUploadFile,
  deleteUpload,
  StorageUnavailableError,
  StoredObjectMissingError,
} from './storage';

beforeEach(() => {
  vi.resetAllMocks();
  io.realpath.mockImplementation((path: string) => path);
  vi.stubEnv('LOCAL_UPLOADS_DIR', undefined);
  vi.stubGlobal('fetch', io.fetch);
  vi.stubEnv('STORAGE_ADAPTER', 'disabled');
  vi.stubEnv('NODE_ENV', 'production');
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
  // The removed Azure adapter fails closed even with its former settings present.
  { STORAGE_ADAPTER: 'azure', AZURE_STORAGE_ACCOUNT_NAME: 'fake', AZURE_STORAGE_CONTAINER: 'fake' },
  { STORAGE_ADAPTER: 's3', S3_UPLOADS_BUCKET: undefined, AWS_REGION: 'me-central-1' },
  { STORAGE_ADAPTER: 's3', S3_UPLOADS_BUCKET: ' ', AWS_REGION: 'me-central-1' },
  { STORAGE_ADAPTER: 's3', S3_UPLOADS_BUCKET: 'inert-bucket', AWS_REGION: undefined },
  { STORAGE_ADAPTER: 's3', S3_UPLOADS_BUCKET: 'inert-bucket', AWS_REGION: ' ' },
];
test.each(unavailable)('unavailable %j performs zero I/O for all operations', async (env) => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  expect(getStorageAvailability().available).toBe(false);
  expect(() => assertStorageAvailable()).toThrow(StorageUnavailableError);
  const outcomes = await Promise.allSettled([
    putUpload('org-a', 'file.png', Buffer.from('bytes'), 'image/png'),
    getUpload('org-a', 'file.png'),
    deleteUpload('org-a', 'file.png'),
    putUploadFile('org-a', 'file.zip', '/tmp/file.zip', 'application/zip'),
    getUploadStream('org-a', 'file.zip'),
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
      STORAGE_ADAPTER: 's3',
      S3_UPLOADS_BUCKET: 'fake',
      AWS_REGION: 'me-central-1',
    }).adapter
  ).toBe('s3');
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
    expect(io.s3client).not.toHaveBeenCalled();
    expect(io.s3send).not.toHaveBeenCalled();
  }
);
test.each(['test', 'development'])(
  'configured local root in %s is dynamic for every operation',
  async (mode) => {
    vi.stubEnv('STORAGE_ADAPTER', 'local');
    vi.stubEnv('NODE_ENV', mode);
    const bytes = Buffer.from('shared upload');
    io.readFile.mockResolvedValue(bytes);
    for (const root of ['/srv/shared/private-uploads', '/srv/other/private-uploads']) {
      vi.stubEnv('LOCAL_UPLOADS_DIR', root);
      expect(getStorageAvailability()).toEqual({ available: true, adapter: 'local', root });
      await putUpload('org-a', 'file.png', bytes, 'image/png');
      expect(await getUpload('org-a', 'file.png')).toBe(bytes);
      await deleteUpload('org-a', 'file.png');
      expect(io.mkdir).toHaveBeenLastCalledWith(`${root}/org-a`, { recursive: true });
      expect(io.writeFile).toHaveBeenLastCalledWith(`${root}/org-a/file.png`, bytes);
      expect(io.readFile).toHaveBeenLastCalledWith(`${root}/org-a/file.png`);
      expect(io.rm).toHaveBeenLastCalledWith(`${root}/org-a/file.png`, { force: true });
    }
    expect(io.s3client).not.toHaveBeenCalled();
    expect(io.s3send).not.toHaveBeenCalled();
  }
);

test.each([
  '',
  ' ',
  'relative/uploads',
  '/',
  '/srv/public',
  '/srv/public/uploads',
  resolve('public/uploads'),
  resolve('.next/standalone/public/private-uploads'),
  '/srv/public/../private-uploads',
  '/srv/private-uploads\nbad',
])('rejects unsafe local root %j before file or provider access', async (root) => {
  vi.stubEnv('STORAGE_ADAPTER', 'local');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('LOCAL_UPLOADS_DIR', root);
  expect(getStorageAvailability()).toEqual({ available: false, reason: 'invalid_configuration' });
  for (const operation of [
    () => putUpload('org-a', 'file.png', Buffer.from('data'), 'image/png'),
    () => getUpload('org-a', 'file.png'),
    () => deleteUpload('org-a', 'file.png'),
  ])
    await expect(operation()).rejects.toBeInstanceOf(StorageUnavailableError);
  for (const [name, fn] of Object.entries(io)) {
    if (name !== 'realpath') expect(fn).not.toHaveBeenCalled();
  }
});

test('rejects a NUL in a supplied configuration record before filesystem access', () => {
  // process.env itself truncates NULs, so exercise the preflight record directly.
  expect(
    getStorageAvailability({
      STORAGE_ADAPTER: 'local',
      NODE_ENV: 'test',
      LOCAL_UPLOADS_DIR: '/srv/shared\0bad',
    })
  ).toEqual({ available: false, reason: 'invalid_configuration' });
  for (const operation of Object.values(io)) expect(operation).not.toHaveBeenCalled();
});

test('rejects symlinked roots and public aliases, including not-yet-created children', () => {
  const env = {
    STORAGE_ADAPTER: 'local',
    NODE_ENV: 'development',
    LOCAL_UPLOADS_DIR: '/srv/shared/new',
  };
  io.realpath.mockImplementation((path: string) => {
    if (path === '/srv/shared/new') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return path === '/srv/shared' ? '/srv/public' : path;
  });
  expect(getStorageAvailability(env)).toEqual({
    available: false,
    reason: 'invalid_configuration',
  });
  io.realpath.mockImplementation((path: string) =>
    path === resolve('public') ? '/srv/shared' : path
  );
  expect(getStorageAvailability(env)).toEqual({
    available: false,
    reason: 'invalid_configuration',
  });
});

test('configured local root never enables production local storage', () => {
  expect(
    getStorageAvailability({
      STORAGE_ADAPTER: 'local',
      NODE_ENV: 'production',
      LOCAL_UPLOADS_DIR: '/srv/shared/private-uploads',
    })
  ).toEqual({ available: false, reason: 'invalid_configuration' });
  expect(io.realpath).not.toHaveBeenCalled();
});

test('local delete failure rejects rather than claiming retention cleanup', async () => {
  vi.stubEnv('STORAGE_ADAPTER', 'local');
  vi.stubEnv('NODE_ENV', 'test');
  const failure = new Error('fake filesystem denied');
  io.rm.mockRejectedValue(failure);
  await expect(deleteUpload('org-a', 'file.png')).rejects.toBe(failure);
});
test('preflight names the S3 bucket and region', () => {
  expect(
    getStorageAvailability({
      STORAGE_ADAPTER: 's3',
      S3_UPLOADS_BUCKET: ' uploads-bucket ',
      AWS_REGION: 'me-central-1',
    })
  ).toEqual({ available: true, adapter: 's3', bucket: 'uploads-bucket', region: 'me-central-1' });
  for (const operation of Object.values(io)) expect(operation).not.toHaveBeenCalled();
});
test('configured S3 uses fake SDK, keys by organization, and disabling afterward blocks it', async () => {
  vi.stubEnv('STORAGE_ADAPTER', 's3');
  vi.stubEnv('S3_UPLOADS_BUCKET', 'uploads-bucket');
  vi.stubEnv('AWS_REGION', 'me-central-1');
  const bytes = Buffer.from('data');
  io.s3send.mockImplementation(async (command: { command: string }) =>
    command.command === 'GetObject'
      ? { Body: { transformToByteArray: async () => new Uint8Array(bytes) } }
      : {}
  );
  await putUpload('org-a', 'file.png', bytes, 'image/png');
  const read = await getUpload('org-a', 'file.png');
  await deleteUpload('org-a', 'file.png');
  expect(Buffer.isBuffer(read)).toBe(true);
  expect(read.equals(bytes)).toBe(true);
  expect(io.s3client).toHaveBeenCalledOnce();
  expect(io.s3client).toHaveBeenCalledWith({ region: 'me-central-1' });
  expect(io.s3send.mock.calls.map(([command]) => command)).toEqual([
    {
      command: 'PutObject',
      input: {
        Bucket: 'uploads-bucket',
        Key: 'org-a/file.png',
        Body: bytes,
        ContentType: 'image/png',
      },
    },
    { command: 'GetObject', input: { Bucket: 'uploads-bucket', Key: 'org-a/file.png' } },
    { command: 'DeleteObject', input: { Bucket: 'uploads-bucket', Key: 'org-a/file.png' } },
  ]);
  for (const fn of [io.mkdir, io.readFile, io.rm, io.writeFile, io.fetch])
    expect(fn).not.toHaveBeenCalled();
  vi.clearAllMocks();
  vi.stubEnv('STORAGE_ADAPTER', 'disabled');
  await expect(getUpload('org-a', 'file.png')).rejects.toBeInstanceOf(StorageUnavailableError);
  for (const fn of Object.values(io)) expect(fn).not.toHaveBeenCalled();
});
test('an S3 object without a body is an error, not an empty file', async () => {
  vi.stubEnv('STORAGE_ADAPTER', 's3');
  vi.stubEnv('S3_UPLOADS_BUCKET', 'uploads-bucket');
  vi.stubEnv('AWS_REGION', 'me-central-1');
  io.s3send.mockResolvedValue({});
  await expect(getUpload('org-a', 'file.png')).rejects.toThrow('Stored object has no body.');
});
test('a missing S3 object reads as missing, in the shape the readers test for', async () => {
  vi.stubEnv('STORAGE_ADAPTER', 's3');
  vi.stubEnv('S3_UPLOADS_BUCKET', 'uploads-bucket');
  vi.stubEnv('AWS_REGION', 'me-central-1');
  // The SDK's errors carry only a name and $metadata.httpStatusCode: no code, no statusCode.
  const noSuchKey = Object.assign(new Error('The specified key does not exist.'), {
    name: 'NoSuchKey',
    $metadata: { httpStatusCode: 404 },
  });
  const bare404 = Object.assign(new Error('UnknownError'), {
    name: 'Unknown',
    $metadata: { httpStatusCode: 404 },
  });
  for (const failure of [noSuchKey, bare404]) {
    io.s3send.mockRejectedValueOnce(failure);
    const error = await getUpload('org-a', 'gone.json').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StoredObjectMissingError);
    expect(error).toMatchObject({ statusCode: 404, code: 'NoSuchKey', cause: failure });
  }
});
test('an S3 refusal stays a failure rather than reading as a missing object', async () => {
  vi.stubEnv('STORAGE_ADAPTER', 's3');
  vi.stubEnv('S3_UPLOADS_BUCKET', 'uploads-bucket');
  vi.stubEnv('AWS_REGION', 'me-central-1');
  const denied = Object.assign(new Error('Access Denied'), {
    name: 'AccessDenied',
    $metadata: { httpStatusCode: 403 },
  });
  io.s3send.mockRejectedValue(denied);
  await expect(getUpload('org-a', 'file.png')).rejects.toBe(denied);
});
test('an S3 delete failure rejects rather than claiming retention cleanup', async () => {
  vi.stubEnv('STORAGE_ADAPTER', 's3');
  vi.stubEnv('S3_UPLOADS_BUCKET', 'uploads-bucket');
  vi.stubEnv('AWS_REGION', 'me-central-1');
  const failure = new Error('fake S3 denied');
  io.s3send.mockRejectedValue(failure);
  await expect(deleteUpload('org-a', 'file.png')).rejects.toBe(failure);
});

test('S3 uploads a file from disk as a sized stream and reads it back as a stream', async () => {
  vi.stubEnv('STORAGE_ADAPTER', 's3');
  vi.stubEnv('S3_UPLOADS_BUCKET', 'uploads-bucket');
  vi.stubEnv('AWS_REGION', 'me-central-1');
  const fileStream = { kind: 'file-stream' };
  const webStream = new ReadableStream<Uint8Array>();
  io.stat.mockResolvedValue({ size: 1234 });
  io.createReadStream.mockReturnValue(fileStream);
  io.s3send.mockImplementation(async (command: { command: string }) =>
    command.command === 'GetObject'
      ? { Body: { transformToWebStream: () => webStream }, ContentLength: 1234 }
      : {}
  );
  await putUploadFile('org-a', 'a.zip', '/tmp/x/a.zip', 'application/zip');
  expect(await getUploadStream('org-a', 'a.zip')).toEqual({ body: webStream, size: 1234 });
  expect(io.createReadStream).toHaveBeenCalledWith('/tmp/x/a.zip');
  expect(io.s3send.mock.calls.map(([command]) => command)).toEqual([
    {
      command: 'PutObject',
      input: {
        Bucket: 'uploads-bucket',
        Key: 'org-a/a.zip',
        Body: fileStream,
        ContentLength: 1234,
        ContentType: 'application/zip',
      },
    },
    { command: 'GetObject', input: { Bucket: 'uploads-bucket', Key: 'org-a/a.zip' } },
  ]);
  for (const fn of [io.readFile, io.writeFile, io.copyFile]) expect(fn).not.toHaveBeenCalled();

  const noSuchKey = Object.assign(new Error('gone'), {
    name: 'NoSuchKey',
    $metadata: { httpStatusCode: 404 },
  });
  io.s3send.mockRejectedValueOnce(noSuchKey);
  await expect(getUploadStream('org-a', 'gone.zip')).rejects.toBeInstanceOf(
    StoredObjectMissingError
  );
});

test('local storage copies an uploaded file and refuses a stream for a missing one', async () => {
  vi.stubEnv('STORAGE_ADAPTER', 'local');
  vi.stubEnv('NODE_ENV', 'test');
  await putUploadFile('org-a', 'a.zip', '/tmp/x/a.zip', 'application/zip');
  expect(io.copyFile).toHaveBeenCalledWith(
    '/tmp/x/a.zip',
    expect.stringContaining('/private-uploads/org-a/a.zip')
  );
  io.stat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  await expect(getUploadStream('org-a', 'a.zip')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(io.createReadStream).not.toHaveBeenCalled();
  expect(io.s3send).not.toHaveBeenCalled();
});
