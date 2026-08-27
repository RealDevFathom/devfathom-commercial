import { describe, expect, test } from 'vitest';

import { cameraGatewayCapabilities } from './camera-gateway';
import { createSimulatedCameraGateway } from './camera-gateway.simulated';

describe('camera gateway contract', () => {
  test('is HLS-only and the simulator requires no network', async () => {
    expect(cameraGatewayCapabilities.transport).toBe('hls');
    const gateway = createSimulatedCameraGateway();
    expect(await gateway.listCameras()).toHaveLength(1);
    expect(await gateway.getLiveManifest('sim-camera-1')).toContain('#EXTM3U');
    expect(await gateway.listRecordings('sim-camera-1')).toHaveLength(1);
  });

  test('returns exactly three coarse connection outcomes without secrets or URLs', async () => {
    const gateway = createSimulatedCameraGateway();
    const results = await Promise.all([
      gateway.testConnection({ outcome: 'ok' }),
      gateway.testConnection({ outcome: 'auth-failed' }),
      gateway.testConnection({ outcome: 'unreachable' }),
    ]);
    expect(results.map((result) => result.outcome)).toEqual(['ok', 'auth-failed', 'unreachable']);
    expect(JSON.stringify(results)).not.toContain('rtsp://');
    expect(JSON.stringify(results)).not.toContain('password');
  });
});
