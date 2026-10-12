/**
 * CAM-L2A — brand adapters and the manual RTSP/ONVIF fallback.
 *
 * Every supported family, and the manual escape hatch, collapses to one
 * `ResolvedCameraTarget`. There is no per-brand runtime branch: presets fill
 * form fields, then ONVIF Profile S discovery plus RTSP carry every camera.
 * That is what keeps the manual fallback on exactly the same code path as a
 * recognised brand.
 */
import {
  CameraConfigError,
  type CameraBrandKey,
  type CameraBrandPreset,
  type CameraConnectionInput,
  type CameraCredential,
  type CameraProbe,
  type CameraProbeResult,
  type CameraStreamQuality,
  type ResolvedCameraTarget,
} from './contract';
import { findCameraBrandPreset } from './presets';

const DEFAULT_CHANNEL = 1;
const MAX_CHANNEL = 255;
const MAX_PROFILE_LABEL = 120;
const GENERIC_PROFILE = 'ONVIF Profile S';

/** Hostname or bare IPv4. No scheme, no port, no userinfo, no path. */
const HOSTNAME = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;
/** Bracketed IPv6, e.g. `[2001:db8::1]`. */
const IPV6 = /^\[[0-9a-f:]+\]$/;

function normalizeHost(raw: string): string {
  const host = raw.trim().toLowerCase();
  if (!host) {
    throw new CameraConfigError('invalid-host', 'Camera host is required.');
  }
  // Reject anything that could smuggle credentials, a port or a path into the
  // host segment and restructure the assembled RTSP URL.
  if (!HOSTNAME.test(host) && !IPV6.test(host)) {
    throw new CameraConfigError(
      'invalid-host',
      'Camera host must be a bare hostname or IP address, without scheme, port, credentials or path.'
    );
  }
  return host;
}

function normalizePort(value: number | undefined, fallback: number): number {
  const port = value ?? fallback;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CameraConfigError('invalid-port', 'Camera port must be an integer from 1 to 65535.');
  }
  return port;
}

function normalizeChannel(value: number | undefined): number {
  const channel = value ?? DEFAULT_CHANNEL;
  if (!Number.isInteger(channel) || channel < 1 || channel > MAX_CHANNEL) {
    throw new CameraConfigError(
      'invalid-channel',
      `Camera channel must be an integer from 1 to ${MAX_CHANNEL}.`
    );
  }
  return channel;
}

function renderTemplate(template: string, channel: number): string {
  return template.replaceAll('{channel}', String(channel));
}

function normalizePath(raw: string): string {
  const path = raw.trim();
  return path.startsWith('/') ? path : `/${path}`;
}

function templateFor(preset: CameraBrandPreset, quality: CameraStreamQuality): string | null {
  return quality === 'main' ? preset.mainStreamPathTemplate : preset.subStreamPathTemplate;
}

function requirePreset(key: string): CameraBrandPreset {
  const preset = findCameraBrandPreset(key);
  if (!preset) {
    throw new CameraConfigError('unknown-brand', 'Unknown camera brand.');
  }
  return preset;
}

/**
 * Maps operator input onto the vendor-neutral contract.
 *
 * Operator values always beat preset values, which is what keeps preset-filled
 * fields editable. When neither the operator nor the preset supplies a stream
 * path — the usual manual case — the target is left for ONVIF discovery rather
 * than guessing a path.
 *
 * Throws `CameraConfigError` so the wizard can attach a precise field error.
 */
export function resolveCameraTarget(input: CameraConnectionInput): ResolvedCameraTarget {
  const preset = requirePreset(input.brandKey);
  const host = normalizeHost(input.host);
  const channel = normalizeChannel(input.channel);
  const quality: CameraStreamQuality = input.quality ?? 'main';

  const override = input.streamPath?.trim();
  const template = templateFor(preset, quality);

  let streamPath: string | null;
  let streamPathSource: ResolvedCameraTarget['streamPathSource'];
  if (override) {
    streamPath = normalizePath(override);
    streamPathSource = 'operator';
  } else if (template) {
    streamPath = normalizePath(renderTemplate(template, channel));
    streamPathSource = 'preset';
  } else {
    streamPath = null;
    streamPathSource = 'onvif-discovery';
  }

  return {
    brandKey: preset.key,
    familyName: preset.familyName,
    transport: 'hls',
    host,
    rtspPort: normalizePort(input.rtspPort, preset.rtspPort),
    onvifPort: normalizePort(input.onvifPort, preset.onvifPort),
    channel,
    quality,
    streamPath,
    streamPathSource,
    authSchemeHint: preset.authSchemeHint,
  };
}

/** Wizard form state for one brand tile. Every field is operator-editable. */
export type CameraFormDefaults = {
  brandKey: CameraBrandKey;
  familyName: string;
  rtspPort: number;
  onvifPort: number;
  streamPath: string | null;
  usernameHint: string | null;
  authSchemeHint: string;
  credentialNote: string;
  setupNote: string;
  /** Pre-filled fields the operator may overwrite. Advisory, not enforced. */
  editableFields: readonly string[];
};

const EDITABLE_FIELDS = ['host', 'rtspPort', 'onvifPort', 'streamPath', 'channel', 'quality'];

/**
 * Produces the pre-filled, fully editable form values for a brand tile.
 * Selecting a tile fills the form; it never locks it.
 */
export function cameraFormDefaults(
  brandKey: string,
  options: { channel?: number; quality?: CameraStreamQuality } = {}
): CameraFormDefaults {
  const preset = requirePreset(brandKey);
  const channel = normalizeChannel(options.channel);
  const template = templateFor(preset, options.quality ?? 'main');

  return {
    brandKey: preset.key,
    familyName: preset.familyName,
    rtspPort: preset.rtspPort,
    onvifPort: preset.onvifPort,
    streamPath: template ? normalizePath(renderTemplate(template, channel)) : null,
    usernameHint: preset.defaultUsernameHint,
    authSchemeHint: preset.authSchemeHint,
    credentialNote: preset.credentialNote,
    setupNote: preset.setupNote,
    editableFields: EDITABLE_FIELDS,
  };
}

/**
 * Scrubs the device-reported profile label before it reaches an operator.
 * A camera controls this string, so it is treated as untrusted: control
 * characters are dropped, length is capped, and anything URL- or
 * credential-shaped is replaced with the generic label.
 */
function safeProfileLabel(value: unknown): string {
  if (typeof value !== 'string') return GENERIC_PROFILE;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!cleaned) return GENERIC_PROFILE;
  if (cleaned.includes('://') || cleaned.includes('@')) return GENERIC_PROFILE;
  return cleaned.slice(0, MAX_PROFILE_LABEL);
}

function normalizeProbeResult(result: unknown): CameraProbeResult {
  if (!result || typeof result !== 'object') return { outcome: 'unreachable' };
  const outcome = (result as { outcome?: unknown }).outcome;
  if (outcome === 'ok') {
    return {
      outcome: 'ok',
      discoveredProfile: safeProfileLabel(
        (result as { discoveredProfile?: unknown }).discoveredProfile
      ),
    };
  }
  if (outcome === 'auth-failed') return { outcome: 'auth-failed' };
  return { outcome: 'unreachable' };
}

/**
 * Tests a camera through the gateway probe and returns one of exactly three
 * outcomes — for every brand and for the manual fallback alike.
 *
 * The probe is the only component handed the credential. Whatever it returns or
 * throws is collapsed here: a thrown error is never rethrown and never logged,
 * because transport errors routinely embed the assembled RTSP URL, and that URL
 * contains the password. Losing the underlying detail is the point.
 *
 * Invalid configuration also reports `unreachable` rather than throwing, so the
 * three-outcome contract holds. Call `resolveCameraTarget` first when the caller
 * needs a precise field-level validation error.
 */
export async function testCameraConnection(
  input: CameraConnectionInput,
  credential: CameraCredential,
  probe: CameraProbe
): Promise<CameraProbeResult> {
  let target: ResolvedCameraTarget;
  try {
    target = resolveCameraTarget(input);
  } catch {
    return { outcome: 'unreachable' };
  }

  try {
    return normalizeProbeResult(await probe(target, credential));
  } catch {
    return { outcome: 'unreachable' };
  }
}
