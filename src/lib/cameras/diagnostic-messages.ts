import type { CameraTransportFailure } from './mediamtx';

/**
 * Operator copy for the configured-gateway connection check, shared by the
 * restaurant and pharmacy consoles. `ok` proves only readable supported
 * playlists; it never claims live frames, codec or device compatibility.
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
  'relay-unsupported':
    'The camera relay answered in a way this app does not support. Supported: MediaMTX v1.17.1 to v1.21.4 with the reference configuration in the camera setup document.',
  ok: 'Supported manifest received. Live frames and codec compatibility still require playback verification.',
};

/**
 * Plain note for a camera whose playlist names H.265 (HEVC) video. The app does not
 * convert video and never asks for recorder changes, so the browser decides.
 */
export const CAMERA_H265_NOTE =
  'This camera sends H.265 (HEVC) video, which the app does not convert. Safari on Mac, iPhone and iPad plays it. Chrome and Edge play it only on computers with H.265 hardware decoding. Other browsers may show no picture.';

/** Live view stopped on H.265 video this browser cannot decode. */
export const CAMERA_H265_PLAYER_MESSAGE =
  "This browser cannot play this camera's H.265 (HEVC) video. Use Safari on Mac, iPhone or iPad, or Chrome or Edge on a computer with H.265 hardware decoding. The app does not convert video.";

/** Live view stopped because the browser accepts none of the playlist's codecs. */
export const CAMERA_CODEC_UNSUPPORTED_MESSAGE =
  "This browser cannot play this camera's video format. H.265 (HEVC) cameras play in Safari on Mac, iPhone and iPad, and in Chrome or Edge only on computers with H.265 hardware decoding.";

/** True for an H.265 codec string from a playlist (`hvc1…` or `hev1…`). */
export function isH265Codec(codec: string | undefined): boolean {
  const value = codec?.trim().toLowerCase() ?? '';
  return value.startsWith('hvc1') || value.startsWith('hev1');
}
