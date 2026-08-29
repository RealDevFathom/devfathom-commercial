import type { CameraGatewayAdapter, CameraProbeResult } from './camera-gateway';

const manifest = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2,\nsegment-1.ts\n#EXT-X-ENDLIST\n';

export function createSimulatedCameraGateway(): CameraGatewayAdapter {
  return {
    async listCameras() {
      return [{ id: 'sim-camera-1', name: 'Simulated entrance' }];
    },
    async getLiveManifest() {
      return manifest;
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
