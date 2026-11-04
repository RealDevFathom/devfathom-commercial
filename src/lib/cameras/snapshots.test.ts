// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createSimulatedCameraGateway } from './simulated-gateway';
import { resolveCameraGatewayRuntime } from './camera-gateway-runtime';

const files = vi.hoisted(() => new Map<string, Buffer>());
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(async (name: string, bytes: Buffer) => {
    files.set(name, Buffer.from(bytes));
  }),
  readFile: vi.fn(async (name: string) => {
    if (!files.has(name)) throw Object.assign(new Error('Missing'), { code: 'ENOENT' });
    return files.get(name);
  }),
  rm: vi.fn(async (name: string) => {
    files.delete(name);
  }),
}));
vi.mock('@azure/identity', () => ({ DefaultAzureCredential: vi.fn() }));
vi.mock('@azure/storage-blob', () => ({ BlobServiceClient: vi.fn() }));
import * as storage from '@/lib/storage';
import {
  CAMERA_SNAPSHOT_MAX_BYTES,
  isAcceptableCameraSnapshot,
  storeCameraSnapshot,
} from './snapshots';

beforeEach(() => {
  files.clear();
  vi.stubEnv('STORAGE_ADAPTER', 'local');
  vi.stubEnv('NODE_ENV', 'test');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test('simulated PNG bytes are stored and retrieved through private storage with fake filesystem', async () => {
  const gateway = createSimulatedCameraGateway();
  const bytes = await gateway.getSnapshot('sim-camera-1');
  expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const saved = await storeCameraSnapshot(gateway, {
    organizationId: 'tenant-a',
    cameraId: 'sim-camera-1',
  });
  expect(saved).toEqual({
    filename: expect.stringMatching(/^camera-snapshot-[a-f0-9-]+\.png$/),
    contentType: 'image/png',
    byteLength: bytes.byteLength,
  });
  expect(await storage.getUpload('tenant-a', saved.filename)).toEqual(Buffer.from(bytes));
  await expect(storage.getUpload('tenant-b', saved.filename)).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

test('concurrent captures keep unique keys and independently owned snapshot bytes', async () => {
  const gateway = createSimulatedCameraGateway();
  const bytes = await gateway.getSnapshot('sim-camera-1');
  bytes.fill(0);
  const saved = await Promise.all(
    Array.from({ length: 4 }, () =>
      storeCameraSnapshot(gateway, { organizationId: 'tenant-a', cameraId: 'sim-camera-1' })
    )
  );
  expect(new Set(saved.map((value) => value.filename)).size).toBe(4);
  const expected = Buffer.from(await gateway.getSnapshot('sim-camera-1'));
  expect(expected[0]).toBe(137);
  for (const value of saved) {
    expect(await storage.getUpload('tenant-a', value.filename)).toEqual(expected);
  }
});

test('unknown camera fails without writing storage or reflecting supplied input', async () => {
  const write = vi.spyOn(storage, 'putUpload');
  await expect(
    storeCameraSnapshot(createSimulatedCameraGateway(), {
      organizationId: 'tenant-a',
      cameraId: 'rtsp://user:secret@private-host',
    })
  ).rejects.toThrow('Camera snapshot unavailable.');
  expect(write).not.toHaveBeenCalled();
});

test.each(['', '..', '../tenant-b', '/tenant-b', 'tenant/b', 'tenant\\b'])(
  'rejects unsafe organization %j before camera access',
  async (organizationId) => {
    const getSnapshot = vi.fn();
    await expect(
      storeCameraSnapshot({ getSnapshot }, { organizationId, cameraId: 'sim-camera-1' })
    ).rejects.toThrow('Invalid snapshot organization.');
    expect(getSnapshot).not.toHaveBeenCalled();
  }
);

test('empty snapshots fail before storage', async () => {
  const write = vi.spyOn(storage, 'putUpload');
  await expect(
    storeCameraSnapshot(
      { getSnapshot: async () => new Uint8Array() },
      { organizationId: 'tenant-a', cameraId: 'sim-camera-1' }
    )
  ).rejects.toThrow('Camera snapshot unavailable.');
  expect(write).not.toHaveBeenCalled();
});

const png = (size: number) => {
  const bytes = new Uint8Array(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  return bytes;
};

test.each([
  ['JPEG bytes', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])],
  ['HTML error page', new TextEncoder().encode('<html>401 rtsp://user:secret@cam</html>')],
  ['HLS manifest', new TextEncoder().encode('#EXTM3U\n#EXTINF:2,\nsegment-1.ts\n')],
  ['signature only', png(8)],
  ['oversized PNG', png(CAMERA_SNAPSHOT_MAX_BYTES + 1)],
  ['non-byte value', 'iVBORw0KGgo=' as unknown as Uint8Array],
])('%s is refused before storage with a fixed message', async (_label, bytes) => {
  const write = vi.spyOn(storage, 'putUpload');
  const failure = storeCameraSnapshot(
    { getSnapshot: async () => bytes },
    { organizationId: 'tenant-a', cameraId: 'sim-camera-1' }
  );
  await expect(failure).rejects.toThrow(/^Camera snapshot unavailable\.$/);
  await failure.catch((error: Error) => expect(error.message).not.toContain('secret'));
  expect(write).not.toHaveBeenCalled();
  expect(files.size).toBe(0);
});

test('a PNG at the size bound is accepted', async () => {
  const bytes = png(CAMERA_SNAPSHOT_MAX_BYTES);
  expect(isAcceptableCameraSnapshot(bytes)).toBe(true);
  const saved = await storeCameraSnapshot(
    { getSnapshot: async () => bytes },
    { organizationId: 'tenant-a', cameraId: 'sim-camera-1' }
  );
  expect(saved.byteLength).toBe(CAMERA_SNAPSHOT_MAX_BYTES);
});

test('storage errors propagate without reporting a successful capture', async () => {
  const failure = new Error('Storage unavailable');
  vi.spyOn(storage, 'putUpload').mockRejectedValueOnce(failure);
  await expect(
    storeCameraSnapshot(createSimulatedCameraGateway(), {
      organizationId: 'tenant-a',
      cameraId: 'sim-camera-1',
    })
  ).rejects.toBe(failure);
});

test('production MediaMTX rejects snapshots by bare camera ID', async () => {
  const runtime = resolveCameraGatewayRuntime({
    NODE_ENV: 'production',
    CAMERA_GATEWAY_MODE: 'mediamtx',
    CAMERA_MEDIAMTX_BINDINGS: JSON.stringify([
      {
        organizationId: 'tenant-a',
        branchId: 'branch-a',
        gatewayId: 'gateway-a',
        cameraId: 'camera-a',
        baseUrl: 'https://gateway.example.test/',
        address: '10.20.30.40',
        path: 'tenant-a/camera-a',
        username: 'fixture-reader',
        password: 'fixture-only',
      },
    ]),
  });
  expect(runtime.mode).toBe('mediamtx');
  if (!runtime.available) throw new Error('Expected configured runtime');
  await expect(runtime.adapter.getSnapshot('camera-a')).rejects.toThrow(
    'Operation unsupported by the configured live camera gateway.'
  );
});

test.each(['disabled', '', 'unknown', 'azure'])(
  'unavailable %j skips camera capture and writes',
  async (adapter) => {
    vi.stubEnv('STORAGE_ADAPTER', adapter);
    vi.stubEnv('AZURE_STORAGE_ACCOUNT_NAME', '');
    const getSnapshot = vi.fn();
    await expect(
      storeCameraSnapshot({ getSnapshot }, { organizationId: 'tenant-a', cameraId: 'camera-a' })
    ).rejects.toBeInstanceOf(storage.StorageUnavailableError);
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
  }
);
test('production local skips camera capture', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  const getSnapshot = vi.fn();
  await expect(
    storeCameraSnapshot({ getSnapshot }, { organizationId: 'tenant-a', cameraId: 'camera-a' })
  ).rejects.toBeInstanceOf(storage.StorageUnavailableError);
  expect(getSnapshot).not.toHaveBeenCalled();
});
