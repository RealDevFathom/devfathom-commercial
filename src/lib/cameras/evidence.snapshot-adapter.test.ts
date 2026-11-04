/**
 * DEV-745: the configured-gateway evidence still path. The database is a
 * recorder with scripted rows and the snapshot transport is a fake; storage and
 * PNG validation run for real against an in-memory filesystem.
 */
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => new Map<string, Buffer>());
vi.mock('server-only', () => ({}));
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(async (name: string, bytes: Buffer) => {
    files.set(name, Buffer.from(bytes));
  }),
  readFile: vi.fn(async (name: string) => files.get(name)),
  rm: vi.fn(async (name: string) => {
    files.delete(name);
  }),
}));
vi.mock('@azure/identity', () => ({ DefaultAzureCredential: vi.fn() }));
vi.mock('@azure/storage-blob', () => ({ BlobServiceClient: vi.fn() }));

import type { CameraGatewayRuntime } from './camera-gateway-runtime';
import { createSimulatedCameraGateway } from './camera-gateway.simulated';
import {
  captureCameraEvidence,
  evidenceSnapshotAdapter,
  evidenceSnapshotSupported,
} from './evidence';
import { makePng } from './png-still.fixtures';
import { CameraSnapshotError, type CameraSnapshotScope } from './snapshot-transport';

const now = new Date('2026-11-04T08:00:00.000Z');
const scope: CameraSnapshotScope = {
  vertical: 'pharmacy',
  organizationId: 'org_a',
  branchId: 'branch_a',
  gatewayId: 'gw_a',
  cameraId: 'cam_a',
  baseUrl: 'https://gateway.pharmacy.test/',
};
const sameScope = (a: CameraSnapshotScope) => JSON.stringify(a) === JSON.stringify(scope);

function runtime(read: (scope: CameraSnapshotScope) => Promise<Uint8Array>) {
  const snapshots = {
    supports: vi.fn(sameScope),
    readSnapshot: vi.fn(read),
  };
  return {
    snapshots,
    runtime: {
      available: true,
      mode: 'mediamtx',
      adapter: {} as never,
      transport: {} as never,
      snapshots,
    } as unknown as CameraGatewayRuntime,
  };
}

function row(overrides: { camera?: object; gateway?: object } = {}) {
  return {
    id: 'ev_1',
    organizationId: 'org_a',
    branchId: 'branch_a',
    status: 'PENDING',
    requestedAt: new Date(now.getTime() - 60_000),
    camera: {
      id: 'cam_a',
      enabled: true,
      branchId: 'branch_a',
      gatewayId: 'gw_a',
      sourceRef: 'pharmacy/branch-a/counter-1',
      ...overrides.camera,
      gateway: {
        status: 'ACTIVE',
        revokedAt: null,
        branchId: 'branch_a',
        baseUrl: 'https://gateway.pharmacy.test/',
        ...overrides.gateway,
      },
    },
  };
}

function db(evidence = row()) {
  return {
    cameraEvidence: {
      findFirst: vi.fn(async () => evidence),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
}

const capture = (
  database: ReturnType<typeof db>,
  adapter: ReturnType<typeof evidenceSnapshotAdapter>,
  finalAttempt = true
) =>
  captureCameraEvidence(database as never, {
    organizationId: 'org_a',
    evidenceId: 'ev_1',
    adapter,
    now,
    finalAttempt,
  });

beforeEach(() => {
  files.clear();
  vi.stubEnv('STORAGE_ADAPTER', 'local');
  vi.stubEnv('NODE_ENV', 'test');
});

describe('evidenceSnapshotAdapter for a configured gateway', () => {
  it('exists only for pharmacy evidence with provisioned snapshot bindings', () => {
    const { runtime: configured } = runtime(async () => makePng());
    expect(evidenceSnapshotAdapter(configured)).toBeNull();
    expect(evidenceSnapshotAdapter(configured, { vertical: 'pharmacy' })).not.toBeNull();
    expect(
      evidenceSnapshotAdapter({ ...configured, snapshots: null } as CameraGatewayRuntime, {
        vertical: 'pharmacy',
      })
    ).toBeNull();
    expect(
      evidenceSnapshotAdapter(
        { available: false, mode: 'unavailable', adapter: null },
        {
          vertical: 'pharmacy',
        }
      )
    ).toBeNull();
    const simulator = createSimulatedCameraGateway();
    expect(
      evidenceSnapshotAdapter(
        { available: true, mode: 'simulated', adapter: simulator },
        {
          vertical: 'pharmacy',
        }
      )
    ).toBe(simulator);
  });

  it('never resolves a bare camera reference against the real gateway', async () => {
    const { runtime: configured, snapshots } = runtime(async () => makePng());
    const adapter = evidenceSnapshotAdapter(configured, { vertical: 'pharmacy' })!;
    await expect(adapter.getSnapshot('pharmacy/branch-a/counter-1')).rejects.toThrow(
      'Camera snapshot unavailable.'
    );
    expect(snapshots.readSnapshot).not.toHaveBeenCalled();
  });

  it('reports support honestly for consoles', () => {
    const { runtime: configured } = runtime(async () => makePng());
    const target = {
      organizationId: 'org_a',
      branchId: 'branch_a',
      gatewayId: 'gw_a',
      gatewayBranchId: 'branch_a',
      gatewayBaseUrl: 'https://gateway.pharmacy.test/',
      cameraId: 'cam_a',
    };
    expect(evidenceSnapshotSupported(configured, target)).toBe(true);
    expect(evidenceSnapshotSupported(configured, { ...target, cameraId: 'cam_b' })).toBe(false);
    expect(evidenceSnapshotSupported(configured, { ...target, gatewayBranchId: 'branch_b' })).toBe(
      false
    );
    expect(
      evidenceSnapshotSupported({ available: false, mode: 'unavailable', adapter: null }, target)
    ).toBe(false);
  });
});

describe('captureCameraEvidence through a configured gateway', () => {
  it('captures a real PNG for the exact authorized scope and stores it privately', async () => {
    const png = makePng({ width: 64, height: 36 });
    const { runtime: configured, snapshots } = runtime(async () => new Uint8Array(png));
    const database = db();
    const result = await capture(
      database,
      evidenceSnapshotAdapter(configured, { vertical: 'pharmacy' })
    );
    expect(result).toEqual({ evidenceId: 'ev_1', outcome: 'CAPTURED', byteLength: png.length });
    expect(snapshots.readSnapshot).toHaveBeenCalledWith(scope);
    const update = (
      database.cameraEvidence.updateMany.mock.calls as unknown as Array<
        [{ data: { storageKey: string } }]
      >
    )[0][0];
    expect(update.data).toMatchObject({
      status: 'CAPTURED',
      byteLength: png.length,
      capturedAt: now,
    });
    expect(update.data.storageKey).toMatch(/^camera-snapshot-[a-f0-9-]+\.png$/);
    expect([...files.values()].some((bytes) => bytes.equals(png))).toBe(true);
  });

  it.each([
    ['a camera that was never provisioned', { camera: { id: 'cam_unbound' } }],
    [
      'a gateway URL that no longer matches',
      { gateway: { baseUrl: 'https://moved.pharmacy.test/' } },
    ],
    ['a gateway registered to another branch', { gateway: { branchId: 'branch_b' } }],
  ])('%s fails as SNAPSHOT_UNSUPPORTED without any read', async (_label, overrides) => {
    const { runtime: configured, snapshots } = runtime(async () => makePng());
    const database = db(row(overrides));
    await expect(
      capture(database, evidenceSnapshotAdapter(configured, { vertical: 'pharmacy' }))
    ).resolves.toEqual({ evidenceId: 'ev_1', outcome: 'FAILED', reason: 'SNAPSHOT_UNSUPPORTED' });
    expect(snapshots.readSnapshot).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
  });

  it('revoked gateways and disabled cameras fail before any read', async () => {
    for (const overrides of [{ gateway: { revokedAt: now } }, { camera: { enabled: false } }]) {
      const { runtime: configured, snapshots } = runtime(async () => makePng());
      await expect(
        capture(db(row(overrides)), evidenceSnapshotAdapter(configured, { vertical: 'pharmacy' }))
      ).resolves.toMatchObject({ outcome: 'FAILED', reason: 'CAMERA_UNAVAILABLE' });
      expect(snapshots.readSnapshot).not.toHaveBeenCalled();
    }
  });

  it('gateway failures retry, then settle as SNAPSHOT_UNAVAILABLE with no detail stored', async () => {
    const { runtime: configured } = runtime(async () => {
      throw new CameraSnapshotError('gateway-unreachable');
    });
    const adapter = evidenceSnapshotAdapter(configured, { vertical: 'pharmacy' });
    await expect(capture(db(), adapter, false)).rejects.toBeInstanceOf(CameraSnapshotError);
    const database = db();
    await expect(capture(database, adapter, true)).resolves.toMatchObject({
      outcome: 'FAILED',
      reason: 'SNAPSHOT_UNAVAILABLE',
    });
    expect(JSON.stringify(database.cameraEvidence.updateMany.mock.calls)).not.toContain(
      'gateway.pharmacy.test'
    );
  });

  it('a 200 that is not a real PNG is never stored', async () => {
    const { runtime: configured } = runtime(async () =>
      new TextEncoder().encode('<html>login required</html>')
    );
    await expect(
      capture(db(), evidenceSnapshotAdapter(configured, { vertical: 'pharmacy' }))
    ).resolves.toMatchObject({ outcome: 'FAILED', reason: 'SNAPSHOT_UNAVAILABLE' });
    expect(files.size).toBe(0);
  });
});
