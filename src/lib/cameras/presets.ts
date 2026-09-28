/**
 * CAM-L2A — adapter-side brand preset catalog.
 *
 * Starting defaults, not verified facts. Firmware varies within every family;
 * confirm these hints against real hardware during the hardware pilot.
 *
 * Keys are deliberately identical to CAM-L1's `prisma/seeds/camera-brand-presets.ts`
 * so an operator-edited `PlatformCameraBrandPreset` row joins straight onto the
 * adapter for the same family. CAM-L1 seeds four families; `cp-plus` is the
 * fifth required by this lane and has no seed row yet — the seed file is outside
 * this lane's owned scope, so the integrator must add that row.
 *
 * Presets only fill forms. ONVIF Profile S discovery plus RTSP remain the single
 * runtime path for every brand, including the manual fallback.
 */
import type { CameraBrandKey, CameraBrandPreset } from './contract';

const HIKVISION: CameraBrandPreset = {
  key: 'hikvision-ezviz',
  familyName: 'Hikvision / EZVIZ',
  aliases: ['Hikvision', 'EZVIZ'],
  rtspPort: 554,
  onvifPort: 80,
  mainStreamPathTemplate: '/Streaming/Channels/{channel}01',
  subStreamPathTemplate: '/Streaming/Channels/{channel}02',
  authSchemeHint: 'digest',
  defaultUsernameHint: 'admin',
  credentialNote: 'ONVIF usually needs its own user, separate from web admin.',
  setupNote: 'Enable ONVIF Profile S on-device.',
};

const DAHUA: CameraBrandPreset = {
  key: 'dahua-imou',
  familyName: 'Dahua / IMOU',
  aliases: ['Dahua', 'IMOU'],
  rtspPort: 554,
  onvifPort: 80,
  mainStreamPathTemplate: '/cam/realmonitor?channel={channel}&subtype=0',
  subStreamPathTemplate: '/cam/realmonitor?channel={channel}&subtype=1',
  authSchemeHint: 'digest',
  defaultUsernameHint: 'admin',
  credentialNote: 'Create the ONVIF user under Account → ONVIF.',
  setupNote: 'Enable ONVIF Profile S on-device.',
};

/**
 * CP Plus ships Dahua-derived firmware, so it takes the Dahua realmonitor path
 * shape. It stays a separate tile because operators buy it as its own brand and
 * its defaults may drift from Dahua's over time.
 */
const CP_PLUS: CameraBrandPreset = {
  key: 'cp-plus',
  familyName: 'CP Plus',
  aliases: ['CP Plus', 'CP-Plus', 'CPPlus'],
  rtspPort: 554,
  onvifPort: 80,
  mainStreamPathTemplate: '/cam/realmonitor?channel={channel}&subtype=0',
  subStreamPathTemplate: '/cam/realmonitor?channel={channel}&subtype=1',
  authSchemeHint: 'digest',
  defaultUsernameHint: 'admin',
  credentialNote: 'Dahua-derived firmware: add a dedicated ONVIF user on-device.',
  setupNote: 'Enable ONVIF Profile S under Network → Advanced.',
};

const UNIVIEW: CameraBrandPreset = {
  key: 'uniview-unv',
  familyName: 'Uniview (UNV)',
  aliases: ['Uniview', 'UNV'],
  rtspPort: 554,
  onvifPort: 80,
  mainStreamPathTemplate: '/media/video1',
  subStreamPathTemplate: '/media/video2',
  authSchemeHint: 'digest',
  defaultUsernameHint: 'admin',
  credentialNote: 'Use a dedicated ONVIF credential.',
  setupNote: 'Enable ONVIF under Network → Advanced.',
};

const TPLINK: CameraBrandPreset = {
  key: 'tplink-tapo-vigi',
  familyName: 'TP-Link Tapo / VIGI',
  aliases: ['TP-Link', 'Tapo', 'VIGI'],
  rtspPort: 554,
  onvifPort: 2020,
  mainStreamPathTemplate: '/stream1',
  subStreamPathTemplate: '/stream2',
  authSchemeHint: 'basic/digest',
  defaultUsernameHint: null,
  credentialNote:
    'Tapo needs a separate camera account; the cloud login does not authenticate RTSP.',
  setupNote: 'Enable local camera access before discovery.',
};

/**
 * The `Using another brand? Configure manually` path. It fills nothing, so the
 * operator supplies host, ports and stream path, or leaves the path empty and
 * lets ONVIF Profile S discovery resolve it. Same adapter, same runtime path.
 */
const MANUAL: CameraBrandPreset = {
  key: 'manual',
  familyName: 'Manual RTSP / ONVIF',
  aliases: ['Manual', 'Generic', 'ONVIF', 'RTSP'],
  rtspPort: 554,
  onvifPort: 80,
  mainStreamPathTemplate: null,
  subStreamPathTemplate: null,
  authSchemeHint: 'basic/digest',
  defaultUsernameHint: null,
  credentialNote: 'Use the camera account that authenticates RTSP, not a cloud login.',
  setupNote: 'Enable ONVIF Profile S, or supply the exact RTSP stream path.',
};

/** Wizard tile order. `manual` is last because it is the escape hatch. */
export const CAMERA_BRAND_PRESETS: readonly CameraBrandPreset[] = [
  HIKVISION,
  DAHUA,
  CP_PLUS,
  UNIVIEW,
  TPLINK,
  MANUAL,
];

const BY_KEY = new Map<string, CameraBrandPreset>(CAMERA_BRAND_PRESETS.map((p) => [p.key, p]));

export function isCameraBrandKey(value: string): value is CameraBrandKey {
  return BY_KEY.has(value);
}

/** Returns null for an unknown key so callers choose their own failure mode. */
export function findCameraBrandPreset(key: string): CameraBrandPreset | null {
  return BY_KEY.get(key) ?? null;
}
