import type { CameraGatewayAdapter, CameraProbeResult } from './camera-gateway';

const manifest = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2,\nsegment-1.ts\n#EXT-X-ENDLIST\n';

// One deterministic 1x1 PNG; every call returns independently owned bytes.
const snapshotPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';

// CAM-3 preset cameras take stills too; listCameras keeps its one CAM-1 entry.
const snapshotRefs = new Set(['sim-camera-1', 'sim-fridge-1', 'sim-kitchen-1', 'sim-counter-1']);

export function createSimulatedCameraGateway(): CameraGatewayAdapter {
  return {
    async listCameras() {
      return [{ id: 'sim-camera-1', name: 'Simulated entrance' }];
    },
    async getLiveManifest() {
      return manifest;
    },
    async getSnapshot(cameraId) {
      if (!snapshotRefs.has(cameraId)) {
        throw new Error('Camera snapshot unavailable.');
      }
      return new Uint8Array(Buffer.from(snapshotPng, 'base64'));
    },
    async listRecordings() {
      return [{ id: 'sim-recording-1', startedAt: '2026-08-27T00:00:00.000Z', durationSeconds: 4 }];
    },
    async getRecordingSegment() {
      return new TextEncoder().encode('simulated-mpeg-ts');
    },
    async getRetentionState() {
      return { days: 7, usedBytes: 17 };
    },
    async getGatewayHealth() {
      return { healthy: true };
    },
    async testConnection(input): Promise<CameraProbeResult> {
      if (input.outcome === 'auth-failed') return { outcome: 'auth-failed' };
      if (input.outcome === 'unreachable') return { outcome: 'unreachable' };
      return { outcome: 'ok', discoveredProfile: 'ONVIF Profile S' };
    },
  };
}
