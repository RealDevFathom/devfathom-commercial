import type { CameraGatewayAdapter } from './camera-gateway';
import { createSimulatedCameraGateway } from './camera-gateway.simulated';
import { createMediaMtxTransport } from './mediamtx';
import { createCameraSnapshotTransport, type CameraSnapshotTransport } from './snapshot-transport';

type CameraGatewayEnvironment = {
  CAMERA_GATEWAY_MODE?: string;
  NODE_ENV?: string;
  CAMERA_MEDIAMTX_BINDINGS?: string;
  /** DEV-745: optional pharmacy still allowlist; read only in mediamtx mode. */
  CAMERA_SNAPSHOT_BINDINGS?: string;
};

export type CameraGatewayRuntime =
  | { available: true; mode: 'simulated'; adapter: CameraGatewayAdapter }
  | {
      available: true;
      mode: 'mediamtx';
      adapter: CameraGatewayAdapter;
      transport: ReturnType<typeof createMediaMtxTransport>;
      /** Null unless stills were explicitly provisioned; then scope-bound reads only. */
      snapshots: CameraSnapshotTransport | null;
    }
  | { available: false; mode: 'unavailable'; adapter: null };

export function resolveCameraGatewayRuntime(env: CameraGatewayEnvironment): CameraGatewayRuntime {
  const configuredMode = env.CAMERA_GATEWAY_MODE?.trim().toLowerCase();

  if (!configuredMode || configuredMode === 'unavailable') {
    return { available: false, mode: 'unavailable', adapter: null };
  }

  if (configuredMode === 'simulated') {
    if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
      throw new Error('The simulated camera gateway is permitted only in development and test.');
    }
    return { available: true, mode: 'simulated', adapter: createSimulatedCameraGateway() };
  }

  if (configuredMode === 'mediamtx') {
    const transport = createMediaMtxTransport(env.CAMERA_MEDIAMTX_BINDINGS ?? '');
    const snapshotBindings = env.CAMERA_SNAPSHOT_BINDINGS?.trim();
    const snapshots = snapshotBindings ? createCameraSnapshotTransport(snapshotBindings) : null;
    const unsupported = async (): Promise<never> => {
      throw new Error('Operation unsupported by the configured live camera gateway.');
    };
    // Legacy methods lack tenant/branch scope. Real reads must use transport
    // after fresh authorization; never resolve a camera by a bare ID here.
    return {
      available: true,
      mode: 'mediamtx',
      transport,
      snapshots,
      adapter: {
        listCameras: unsupported,
        getLiveManifest: unsupported,
        getSnapshot: unsupported,
        listRecordings: unsupported,
        getRecordingSegment: unsupported,
        getRetentionState: unsupported,
        getGatewayHealth: unsupported,
        testConnection: unsupported,
      },
    };
  }

  throw new Error('Invalid camera gateway configuration.');
}

export const cameraGatewayRuntime = resolveCameraGatewayRuntime(process.env);

export function cameraGatewayPublicState(runtime: CameraGatewayRuntime) {
  return runtime.available
    ? { available: true as const, mode: runtime.mode }
    : { available: false as const, mode: runtime.mode, reason: 'not-configured' as const };
}
