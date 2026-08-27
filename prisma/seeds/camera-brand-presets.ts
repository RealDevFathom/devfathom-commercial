// Starting defaults, not verified facts. Firmware varies within every family;
// confirm these hints against real hardware during the hardware pilot.
export const CAMERA_BRAND_PRESETS = [
  {
    key: 'hikvision-ezviz',
    familyName: 'Hikvision / EZVIZ',
    aliases: ['Hikvision', 'EZVIZ'],
    iconKey: 'camera',
    rtspPort: 554,
    onvifPort: 80,
    mainStreamPathTemplate: '/Streaming/Channels/{channel}01',
    subStreamPathTemplate: '/Streaming/Channels/{channel}02',
    authSchemeHint: 'digest',
    defaultUsernameHint: 'admin',
    credentialNote: 'ONVIF usually needs its own user, separate from web admin.',
    setupNote: 'Enable ONVIF Profile S on-device.',
    active: true,
    sortOrder: 10,
  },
  {
    key: 'dahua-imou',
    familyName: 'Dahua / IMOU',
    aliases: ['Dahua', 'IMOU'],
    iconKey: 'camera',
    rtspPort: 554,
    onvifPort: 80,
    mainStreamPathTemplate: '/cam/realmonitor?channel={channel}&subtype=0',
    subStreamPathTemplate: '/cam/realmonitor?channel={channel}&subtype=1',
    authSchemeHint: 'digest',
    defaultUsernameHint: 'admin',
    credentialNote: 'Create the ONVIF user under Account → ONVIF.',
    setupNote: 'Enable ONVIF Profile S on-device.',
    active: true,
    sortOrder: 20,
  },
  {
    key: 'uniview-unv',
    familyName: 'Uniview (UNV)',
    aliases: ['Uniview', 'UNV'],
    iconKey: 'camera',
    rtspPort: 554,
    onvifPort: 80,
    mainStreamPathTemplate: '/media/video1',
    subStreamPathTemplate: '/media/video2',
    authSchemeHint: 'digest',
    defaultUsernameHint: 'admin',
    credentialNote: 'Use a dedicated ONVIF credential.',
    setupNote: 'Enable ONVIF under Network → Advanced.',
    active: true,
    sortOrder: 30,
  },
  {
    key: 'tplink-tapo-vigi',
    familyName: 'TP-Link Tapo / VIGI',
    aliases: ['TP-Link', 'Tapo', 'VIGI'],
    iconKey: 'camera',
    rtspPort: 554,
    onvifPort: 2020,
    mainStreamPathTemplate: '/stream1',
    subStreamPathTemplate: '/stream2',
    authSchemeHint: 'basic/digest',
    defaultUsernameHint: null,
    credentialNote:
      'Tapo needs a separate camera account; the cloud login does not authenticate RTSP.',
    setupNote: 'Enable local camera access before discovery.',
    active: true,
    sortOrder: 40,
  },
] as const;

type SeedDb = {
  platformCameraBrandPreset: {
    createMany(args: {
      data: readonly Record<string, unknown>[];
      skipDuplicates: true;
    }): Promise<unknown>;
  };
};

/** Insert missing defaults only. Existing operator edits are intentionally preserved. */
export function seedCameraBrandPresets(db: SeedDb) {
  return db.platformCameraBrandPreset.createMany({
    data: CAMERA_BRAND_PRESETS,
    skipDuplicates: true,
  });
}
