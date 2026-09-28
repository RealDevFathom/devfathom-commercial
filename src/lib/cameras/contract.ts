/**
 * CAM-L2A — vendor-neutral camera contract consumed by every brand adapter.
 *
 * The transport is HLS only: browsers cannot consume RTSP, so the local gateway
 * is the sole component that ever speaks RTSP/ONVIF. Adapters describe *how to
 * reach* a camera; they never return credentials and never return an assembled
 * RTSP URL. See `industry-specific-docs/restaurants/cameras/001-gateway-adapter-contract.md`
 * (CAM-L1) for the gateway-side half of this contract.
 *
 * `CameraStreamTransport` and `CameraProbeResult` are declared structurally
 * identical to CAM-L1's `src/lib/restaurant/camera-gateway.ts` so the two lanes
 * stay assignable in both directions when they are integrated.
 */

/** Browsers never consume RTSP. The gateway transcodes to HLS and nothing else. */
export type CameraStreamTransport = 'hls';

/**
 * The only three outcomes a connection test may expose. Anything more specific
 * would leak network topology or credential state to the operator console.
 */
export type CameraProbeOutcome = 'ok' | 'auth-failed' | 'unreachable';

export type CameraProbeResult =
  | { outcome: 'ok'; discoveredProfile: string }
  | { outcome: 'auth-failed' }
  | { outcome: 'unreachable' };

/** Brand families the wizard offers as tiles, plus the manual escape hatch. */
export type CameraBrandKey =
  'hikvision-ezviz' | 'dahua-imou' | 'cp-plus' | 'uniview-unv' | 'tplink-tapo-vigi' | 'manual';

export type CameraStreamQuality = 'main' | 'sub';

/**
 * Form-fill defaults for one brand family. Every field here is a *hint*: the
 * wizard pre-fills it and the operator may overwrite all of it. Firmware varies
 * within every family, so none of these are verified facts.
 */
export type CameraBrandPreset = {
  key: CameraBrandKey;
  familyName: string;
  aliases: readonly string[];
  rtspPort: number;
  onvifPort: number;
  /** `{channel}` is substituted with the operator's channel number. */
  mainStreamPathTemplate: string | null;
  subStreamPathTemplate: string | null;
  authSchemeHint: string;
  defaultUsernameHint: string | null;
  credentialNote: string;
  setupNote: string;
};

/** Write-only. Never appears on a resolved target, a probe result, or an error. */
export type CameraCredential = {
  username: string;
  password: string;
};

/**
 * Operator-supplied connection settings. Every preset-filled field is optional
 * and, when present, overrides the preset — that is what keeps preset-filled
 * fields editable.
 */
export type CameraConnectionInput = {
  brandKey: CameraBrandKey;
  host: string;
  channel?: number;
  quality?: CameraStreamQuality;
  rtspPort?: number;
  onvifPort?: number;
  /** Explicit stream path. Required for `manual` when ONVIF discovery is off. */
  streamPath?: string;
};

/** Where the resolved stream path came from. Presets only fill forms. */
export type CameraStreamPathSource = 'operator' | 'preset' | 'onvif-discovery';

/**
 * The vendor-neutral shape every brand — and the manual fallback — maps to.
 * Safe to return to a console: it carries no credential and no assembled URL.
 */
export type ResolvedCameraTarget = {
  brandKey: CameraBrandKey;
  familyName: string;
  transport: CameraStreamTransport;
  host: string;
  rtspPort: number;
  onvifPort: number;
  channel: number;
  quality: CameraStreamQuality;
  streamPath: string | null;
  streamPathSource: CameraStreamPathSource;
  authSchemeHint: string;
};

/**
 * The gateway-side probe an adapter delegates to. It is the only place that
 * receives a credential. Implementations run on the local gateway, never in the
 * browser and never in a tenant request path.
 */
export type CameraProbe = (
  target: ResolvedCameraTarget,
  credential: CameraCredential
) => Promise<CameraProbeResult>;

/** Configuration rejection codes. Deliberately coarse and credential-free. */
export type CameraConfigErrorCode =
  'unknown-brand' | 'invalid-host' | 'invalid-port' | 'invalid-channel' | 'stream-path-required';

/**
 * Raised before any connection is attempted. Carries a stable code and no
 * operator input, so it is safe to surface and safe to log.
 */
export class CameraConfigError extends Error {
  readonly code: CameraConfigErrorCode;

  constructor(code: CameraConfigErrorCode, message: string) {
    super(message);
    this.name = 'CameraConfigError';
    this.code = code;
  }
}

export type { CameraGatewayAdapter } from './camera-gateway';
