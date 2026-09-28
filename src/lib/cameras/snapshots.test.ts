// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { createSimulatedCameraGateway } from './simulated-gateway';
import { resolveCameraGatewayRuntime } from './camera-gateway-runtime';

let directory: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;
let storage: typeof import('@/lib/storage');
let storeCameraSnapshot: typeof import('./snapshots').storeCameraSnapshot;

beforeAll(async () => {
  directory = await mkdtemp(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), 'camera-snapshots-')
  );
  vi.stubEnv('AZURE_STORAGE_ACCOUNT_NAME', '');
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(directory);
  storage = await import('@/lib/storage');
  ({ storeCameraSnapshot } = await import('./snapshots'));
});

afterEach(() => {
  vi.mocked(storage.putUpload).mockRestore?.();
});

afterAll(async () => {
  cwdSpy.mockRestore();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

test('simulated PNG bytes are stored and retrieved through real private storage', async () => {
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
