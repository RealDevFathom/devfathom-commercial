import type { CameraGatewayAdapter } from './camera-gateway';
import { createSimulatedCameraGateway } from './camera-gateway.simulated';

type CameraGatewayEnvironment = {
  CAMERA_GATEWAY_MODE?: string;
  NODE_ENV?: string;
};

export type CameraGatewayRuntime =
  | { available: true; mode: 'simulated'; adapter: CameraGatewayAdapter }
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

  throw new Error('Invalid camera gateway configuration.');
}

export const cameraGatewayRuntime = resolveCameraGatewayRuntime(process.env);

export function cameraGatewayPublicState(runtime: CameraGatewayRuntime) {
  return runtime.available
    ? { available: true as const, mode: runtime.mode }
    : { available: false as const, mode: runtime.mode, reason: 'not-configured' as const };
}
