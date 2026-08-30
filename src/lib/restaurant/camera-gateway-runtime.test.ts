import { describe, expect, test } from 'vitest';
import { cameraGatewayPublicState, resolveCameraGatewayRuntime } from './camera-gateway-runtime';

describe('camera gateway runtime boundary', () => {
  test.each(['development', 'test'] as const)(
    'allows an explicitly configured simulator in %s',
    (nodeEnv) => {
      const runtime = resolveCameraGatewayRuntime({
        CAMERA_GATEWAY_MODE: 'simulated',
        NODE_ENV: nodeEnv,
      });

      expect(runtime.available).toBe(true);
      expect(runtime.mode).toBe('simulated');
    }
  );

  test('rejects the simulator in production', () => {
    expect(() =>
      resolveCameraGatewayRuntime({ CAMERA_GATEWAY_MODE: 'simulated', NODE_ENV: 'production' })
    ).toThrow('The simulated camera gateway is permitted only in development and test.');
  });

  test('rejects the simulator when the runtime environment is absent or unknown', () => {
    for (const nodeEnv of [undefined, 'staging']) {
      expect(() =>
        resolveCameraGatewayRuntime({ CAMERA_GATEWAY_MODE: 'simulated', NODE_ENV: nodeEnv })
      ).toThrow('The simulated camera gateway is permitted only in development and test.');
    }
  });

  test('fails closed without configuration and exposes no environment value or URL', () => {
    const state = cameraGatewayPublicState(
      resolveCameraGatewayRuntime({ CAMERA_GATEWAY_MODE: undefined, NODE_ENV: 'production' })
    );

    expect(state).toEqual({ available: false, mode: 'unavailable', reason: 'not-configured' });
    expect(JSON.stringify(state)).not.toMatch(/https?:|secret|credential/i);
  });

  test('rejects unknown configuration without reflecting its value', () => {
    expect(() =>
      resolveCameraGatewayRuntime({ CAMERA_GATEWAY_MODE: 'https://user:secret@example.test' })
    ).toThrow('Invalid camera gateway configuration.');
  });
});
