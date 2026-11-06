import type { CameraTransportFailure } from './mediamtx';

/**
 * Operator copy for the configured-gateway connection check, shared by the
 * restaurant and pharmacy consoles. `ok` proves only a readable supported
 * manifest; it never claims live frames, codec or device compatibility.
 */
export const CAMERA_DIAGNOSTIC_MESSAGES: Record<CameraTransportFailure | 'ok', string> = {
  'not-configured':
    'No server binding exists yet. Ask the gateway owner to bind this registered camera.',
  'credentials-missing':
    'Gateway reader credentials are missing. Ask the gateway owner to configure them.',
  'auth-failed':
    'Gateway reader authentication failed. Ask the gateway owner to check credentials.',
  'gateway-unreachable':
    'Gateway unreachable. Ask the gateway owner to check private routing and TLS.',
  'unsupported-stream':
    'Stream unavailable or unsupported. Ask the gateway owner to check the source and HLS format.',
  ok: 'Supported manifest received. Live frames and codec compatibility still require playback verification.',
};
