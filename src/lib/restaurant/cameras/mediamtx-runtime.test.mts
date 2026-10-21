import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCameraGatewayRuntime, cameraGatewayPublicState } from '../camera-gateway-runtime';

test('configured production runtime exposes no addresses or secrets', () => {
  const runtime = resolveCameraGatewayRuntime({
    NODE_ENV: 'production',
    CAMERA_GATEWAY_MODE: 'mediamtx',
    CAMERA_MEDIAMTX_BINDINGS: JSON.stringify([
      {
        organizationId: 'a',
        branchId: 'b',
        gatewayId: 'g',
        cameraId: 'c',
        baseUrl: 'https://gateway.test/',
        address: '10.0.0.2',
        path: 'camera',
        username: 'reader',
        password: 'fixture-only',
      },
    ]),
  });
  assert.deepEqual(cameraGatewayPublicState(runtime), { available: true, mode: 'mediamtx' });
});

test('production cannot simulate and incomplete real configuration fails closed', () => {
  assert.throws(
    () => resolveCameraGatewayRuntime({ NODE_ENV: 'production', CAMERA_GATEWAY_MODE: 'simulated' }),
    /permitted only/
  );
  assert.throws(
    () => resolveCameraGatewayRuntime({ NODE_ENV: 'production', CAMERA_GATEWAY_MODE: 'mediamtx' }),
    /not-configured/
  );
  assert.deepEqual(
    cameraGatewayPublicState(resolveCameraGatewayRuntime({ NODE_ENV: 'production' })),
    { available: false, mode: 'unavailable', reason: 'not-configured' }
  );
});
