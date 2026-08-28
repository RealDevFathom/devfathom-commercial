/**
 * CAM-L2A — brand adapters, manual fallback, and credential containment.
 *
 * Pure logic: no database, no network, no Prisma. The simulated gateway stands
 * in for the local gateway everywhere a probe is needed.
 */
import { describe, expect, it } from 'vitest';

import { cameraFormDefaults, resolveCameraTarget, testCameraConnection } from './adapters';
import {
  CameraConfigError,
  type CameraBrandKey,
  type CameraCredential,
  type CameraProbe,
} from './contract';
import { CAMERA_BRAND_PRESETS, findCameraBrandPreset, isCameraBrandKey } from './presets';
import { assembleRtspUrl, formatCameraTargetForLog, onvifDeviceServiceUrl } from './rtsp';
import { createSimulatedCameraNetwork } from './simulated-gateway';

/** Deliberately full of URL-structural characters. */
const PASSWORD = 'p@ss:w/rd#1';
const CREDENTIAL: CameraCredential = { username: 'onvif_user', password: PASSWORD };

/** The five brands this lane must support, plus the manual escape hatch. */
const REQUIRED_BRANDS: readonly CameraBrandKey[] = [
  'hikvision-ezviz',
  'dahua-imou',
  'cp-plus',
  'uniview-unv',
  'tplink-tapo-vigi',
];

function assertNoSecrets(label: string, blob: string): void {
  expect(blob, `${label} leaked the password`).not.toContain(PASSWORD);
  expect(blob, `${label} leaked an encoded password`).not.toContain(encodeURIComponent(PASSWORD));
  expect(blob, `${label} leaked an assembled RTSP URL`).not.toContain('rtsp://');
}

describe('camera brand presets', () => {
  it('covers every required brand plus the manual fallback', () => {
    const keys = CAMERA_BRAND_PRESETS.map((preset) => preset.key);
    for (const brand of REQUIRED_BRANDS) expect(keys).toContain(brand);
    expect(keys).toContain('manual');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('offers manual last so the branded tiles come first', () => {
    expect(CAMERA_BRAND_PRESETS.at(-1)?.key).toBe('manual');
  });

  it('recognises only known keys', () => {
    expect(isCameraBrandKey('cp-plus')).toBe(true);
    expect(isCameraBrandKey('axis')).toBe(false);
    expect(findCameraBrandPreset('axis')).toBeNull();
  });

  it('leaves the manual family without stream templates so ONVIF resolves the path', () => {
    const manual = findCameraBrandPreset('manual');
    expect(manual?.mainStreamPathTemplate).toBeNull();
    expect(manual?.subStreamPathTemplate).toBeNull();
  });
});

describe('resolveCameraTarget maps every brand onto the shared contract', () => {
  it.each([...REQUIRED_BRANDS, 'manual' as const])(
    'maps %s to the vendor-neutral target',
    (brandKey) => {
      const target = resolveCameraTarget({ brandKey, host: '10.20.0.7' });

      expect(target.brandKey).toBe(brandKey);
      expect(target.transport).toBe('hls');
      expect(target.host).toBe('10.20.0.7');
      expect(target.channel).toBe(1);
      expect(target.quality).toBe('main');
      expect(target.rtspPort).toBeGreaterThan(0);
      expect(target.onvifPort).toBeGreaterThan(0);
      expect(Object.keys(target).sort()).toEqual([
        'authSchemeHint',
        'brandKey',
        'channel',
        'familyName',
        'host',
        'onvifPort',
        'quality',
        'rtspPort',
        'streamPath',
        'streamPathSource',
        'transport',
      ]);
    }
  );

  it.each([
    ['hikvision-ezviz', 2, '/Streaming/Channels/201'],
    ['dahua-imou', 3, '/cam/realmonitor?channel=3&subtype=0'],
    ['cp-plus', 3, '/cam/realmonitor?channel=3&subtype=0'],
    ['uniview-unv', 1, '/media/video1'],
    ['tplink-tapo-vigi', 1, '/stream1'],
  ] as const)('fills the %s main stream path for channel %i', (brandKey, channel, expected) => {
    const target = resolveCameraTarget({ brandKey, host: 'cam.local', channel });
    expect(target.streamPath).toBe(expected);
    expect(target.streamPathSource).toBe('preset');
  });

  it('uses the sub-stream template when sub quality is requested', () => {
    const target = resolveCameraTarget({
      brandKey: 'hikvision-ezviz',
      host: 'cam.local',
      channel: 2,
      quality: 'sub',
    });
    expect(target.streamPath).toBe('/Streaming/Channels/202');
  });

  it('keeps TP-Link on its non-standard ONVIF port by default', () => {
    expect(resolveCameraTarget({ brandKey: 'tplink-tapo-vigi', host: 'cam.local' }).onvifPort).toBe(
      2020
    );
  });

  it('normalises host casing and surrounding whitespace', () => {
    expect(resolveCameraTarget({ brandKey: 'manual', host: '  CAM.Local  ' }).host).toBe(
      'cam.local'
    );
  });

  it('accepts a bracketed IPv6 host', () => {
    expect(resolveCameraTarget({ brandKey: 'manual', host: '[2001:db8::1]' }).host).toBe(
      '[2001:db8::1]'
    );
  });
});

describe('preset-filled fields stay editable', () => {
  it('lets operator values override every preset default', () => {
    const target = resolveCameraTarget({
      brandKey: 'hikvision-ezviz',
      host: 'cam.local',
      rtspPort: 8554,
      onvifPort: 8080,
      streamPath: 'custom/path',
    });

    expect(target.rtspPort).toBe(8554);
    expect(target.onvifPort).toBe(8080);
    expect(target.streamPath).toBe('/custom/path');
    expect(target.streamPathSource).toBe('operator');
  });

  it('publishes pre-filled defaults and marks them editable', () => {
    const defaults = cameraFormDefaults('dahua-imou', { channel: 2 });

    expect(defaults.familyName).toBe('Dahua / IMOU');
    expect(defaults.rtspPort).toBe(554);
    expect(defaults.streamPath).toBe('/cam/realmonitor?channel=2&subtype=0');
    expect(defaults.editableFields).toContain('rtspPort');
    expect(defaults.editableFields).toContain('streamPath');
  });

  it('pre-fills no stream path for the manual tile', () => {
    expect(cameraFormDefaults('manual').streamPath).toBeNull();
  });

  it('rejects an unknown brand tile', () => {
    expect(() => cameraFormDefaults('axis')).toThrow(CameraConfigError);
  });
});

describe('configuration is rejected before any connection is attempted', () => {
  const cases: ReadonlyArray<[string, Parameters<typeof resolveCameraTarget>[0], string]> = [
    [
      'an unknown brand',
      { brandKey: 'axis' as CameraBrandKey, host: 'cam.local' },
      'unknown-brand',
    ],
    ['an empty host', { brandKey: 'manual', host: '   ' }, 'invalid-host'],
    ['a host carrying a scheme', { brandKey: 'manual', host: 'rtsp://cam.local' }, 'invalid-host'],
    [
      'a host carrying credentials',
      { brandKey: 'manual', host: `admin:${PASSWORD}@cam.local` },
      'invalid-host',
    ],
    ['a host carrying a port', { brandKey: 'manual', host: 'cam.local:554' }, 'invalid-host'],
    ['a host carrying a path', { brandKey: 'manual', host: 'cam.local/stream1' }, 'invalid-host'],
    ['a zero port', { brandKey: 'manual', host: 'cam.local', rtspPort: 0 }, 'invalid-port'],
    [
      'an out-of-range port',
      { brandKey: 'manual', host: 'cam.local', onvifPort: 70000 },
      'invalid-port',
    ],
    [
      'a fractional port',
      { brandKey: 'manual', host: 'cam.local', rtspPort: 554.5 },
      'invalid-port',
    ],
    ['a zero channel', { brandKey: 'manual', host: 'cam.local', channel: 0 }, 'invalid-channel'],
    [
      'an oversized channel',
      { brandKey: 'manual', host: 'cam.local', channel: 999 },
      'invalid-channel',
    ],
  ];

  it.each(cases)('rejects %s with code %s', (_label, input, code) => {
    try {
      resolveCameraTarget(input);
      expect.unreachable('expected a CameraConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(CameraConfigError);
      expect((error as CameraConfigError).code).toBe(code);
      assertNoSecrets('config error', String((error as Error).message));
    }
  });
});

describe('manual RTSP/ONVIF fallback rides the same adapter path', () => {
  it('defers to ONVIF discovery when the operator gives no path', () => {
    const target = resolveCameraTarget({ brandKey: 'manual', host: 'cam.local' });
    expect(target.streamPath).toBeNull();
    expect(target.streamPathSource).toBe('onvif-discovery');
  });

  it('honours an explicit manual stream path', () => {
    const target = resolveCameraTarget({
      brandKey: 'manual',
      host: 'cam.local',
      streamPath: '/live/ch0',
    });
    expect(target.streamPath).toBe('/live/ch0');
    expect(target.streamPathSource).toBe('operator');
  });

  it('produces the same target shape as a branded camera', () => {
    const manual = resolveCameraTarget({
      brandKey: 'manual',
      host: 'cam.local',
      streamPath: '/stream1',
    });
    const branded = resolveCameraTarget({ brandKey: 'tplink-tapo-vigi', host: 'cam.local' });

    expect(Object.keys(manual).sort()).toEqual(Object.keys(branded).sort());
    expect(manual.streamPath).toBe(branded.streamPath);
    expect(manual.transport).toBe(branded.transport);
  });

  it('connects an unbranded camera through ONVIF discovery', async () => {
    const network = createSimulatedCameraNetwork([
      {
        host: 'cam.local',
        username: CREDENTIAL.username,
        password: PASSWORD,
        streamPaths: ['/live/ch0'],
        discoveredProfile: 'ONVIF Profile S',
      },
    ]);

    const result = await testCameraConnection(
      { brandKey: 'manual', host: 'cam.local' },
      CREDENTIAL,
      network.probe
    );

    expect(result).toEqual({ outcome: 'ok', discoveredProfile: 'ONVIF Profile S' });
    expect(network.attempts[0]?.streamPathSource).toBe('onvif-discovery');
  });
});

describe('testCameraConnection returns only ok, auth-failed or unreachable', () => {
  const network = createSimulatedCameraNetwork([
    {
      host: 'cam.local',
      username: CREDENTIAL.username,
      password: PASSWORD,
      streamPaths: ['/stream1'],
    },
    {
      host: 'leaky.local',
      username: CREDENTIAL.username,
      password: PASSWORD,
      throwsLeakyError: true,
    },
  ]);

  const scenarios: ReadonlyArray<
    [string, Parameters<typeof testCameraConnection>[0], CameraCredential]
  > = [
    ['a healthy camera', { brandKey: 'tplink-tapo-vigi', host: 'cam.local' }, CREDENTIAL],
    [
      'a wrong password',
      { brandKey: 'tplink-tapo-vigi', host: 'cam.local' },
      { username: CREDENTIAL.username, password: 'wrong' },
    ],
    ['an absent host', { brandKey: 'manual', host: 'ghost.local', streamPath: '/x' }, CREDENTIAL],
    ['a leaky transport error', { brandKey: 'manual', host: 'leaky.local' }, CREDENTIAL],
    ['an invalid host', { brandKey: 'manual', host: 'rtsp://cam.local' }, CREDENTIAL],
    ['an unknown brand', { brandKey: 'axis' as CameraBrandKey, host: 'cam.local' }, CREDENTIAL],
  ];

  it.each(scenarios)('collapses %s to a permitted outcome', async (_label, input, credential) => {
    const result = await testCameraConnection(input, credential, network.probe);
    expect(['ok', 'auth-failed', 'unreachable']).toContain(result.outcome);
    assertNoSecrets('probe result', JSON.stringify(result));
  });

  it('reports auth-failed for a reachable camera with the wrong password', async () => {
    const result = await testCameraConnection(
      { brandKey: 'tplink-tapo-vigi', host: 'cam.local' },
      { username: CREDENTIAL.username, password: 'wrong' },
      network.probe
    );
    expect(result).toEqual({ outcome: 'auth-failed' });
  });

  it('swallows a transport error that embeds the authenticated URL', async () => {
    const result = await testCameraConnection(
      { brandKey: 'manual', host: 'leaky.local', streamPath: '/stream1' },
      CREDENTIAL,
      network.probe
    );
    expect(result).toEqual({ outcome: 'unreachable' });
    assertNoSecrets('swallowed transport error', JSON.stringify(result));
  });

  it('never rethrows, whatever the probe does', async () => {
    const hostile: CameraProbe = async () => {
      throw new Error(`boom rtsp://admin:${PASSWORD}@cam.local:554/stream1`);
    };
    await expect(
      testCameraConnection({ brandKey: 'manual', host: 'cam.local' }, CREDENTIAL, hostile)
    ).resolves.toEqual({ outcome: 'unreachable' });
  });

  it('scrubs a device-reported profile label that carries a URL', async () => {
    const hostile: CameraProbe = async () => ({
      outcome: 'ok',
      discoveredProfile: `rtsp://admin:${PASSWORD}@cam.local/stream1`,
    });

    const result = await testCameraConnection(
      { brandKey: 'manual', host: 'cam.local' },
      CREDENTIAL,
      hostile
    );

    expect(result).toEqual({ outcome: 'ok', discoveredProfile: 'ONVIF Profile S' });
    assertNoSecrets('scrubbed profile', JSON.stringify(result));
  });

  it('caps and strips control characters from a device-reported profile label', async () => {
    const hostile: CameraProbe = async () => ({
      outcome: 'ok',
      discoveredProfile: `Profile S\u001b[31m ${'x'.repeat(500)}`,
    });

    const result = await testCameraConnection(
      { brandKey: 'manual', host: 'cam.local' },
      CREDENTIAL,
      hostile
    );

    expect(result.outcome).toBe('ok');
    const profile = (result as { discoveredProfile: string }).discoveredProfile;
    expect(profile.length).toBeLessThanOrEqual(120);
    expect(profile.startsWith('Profile S')).toBe(true);
    expect(/[\u0000-\u001f\u007f]/.test(profile)).toBe(false);
  });

  it('falls back to unreachable for an unrecognised probe outcome', async () => {
    const rogue = (async () => ({
      outcome: 'exploded',
      detail: PASSWORD,
    })) as unknown as CameraProbe;
    const result = await testCameraConnection(
      { brandKey: 'manual', host: 'cam.local' },
      CREDENTIAL,
      rogue
    );
    expect(result).toEqual({ outcome: 'unreachable' });
    assertNoSecrets('rogue probe outcome', JSON.stringify(result));
  });
});

describe('credentials and assembled URLs never reach an operator surface', () => {
  it('keeps the resolved target credential-free for every brand', () => {
    for (const preset of CAMERA_BRAND_PRESETS) {
      const target = resolveCameraTarget({
        brandKey: preset.key,
        host: 'cam.local',
        streamPath: '/stream1',
      });
      assertNoSecrets(`resolved ${preset.key}`, JSON.stringify(target));
    }
  });

  it('keeps the log line free of credentials and URLs', () => {
    const target = resolveCameraTarget({ brandKey: 'hikvision-ezviz', host: 'cam.local' });
    const line = formatCameraTargetForLog(target);

    expect(line).toContain('cam.local');
    expect(line).toContain('hikvision-ezviz');
    assertNoSecrets('log line', line);
  });

  it('keeps the simulated network attempt log credential-free', async () => {
    const network = createSimulatedCameraNetwork([
      { host: 'cam.local', username: CREDENTIAL.username, password: PASSWORD },
    ]);
    await testCameraConnection(
      { brandKey: 'hikvision-ezviz', host: 'cam.local' },
      CREDENTIAL,
      network.probe
    );
    assertNoSecrets('attempt log', JSON.stringify(network.attempts));
  });

  it('percent-encodes credentials when assembling a URL for the gateway', () => {
    const target = resolveCameraTarget({
      brandKey: 'hikvision-ezviz',
      host: 'cam.local',
      channel: 1,
    });
    const url = assembleRtspUrl(target, CREDENTIAL);

    expect(url).toBe(
      `rtsp://onvif_user:${encodeURIComponent(PASSWORD)}@cam.local:554/Streaming/Channels/101`
    );
    // The raw password must not survive: ':' '@' '/' would restructure the URL.
    expect(url).not.toContain(PASSWORD);
    expect(new URL(url).hostname).toBe('cam.local');
  });

  it('refuses to assemble a URL before ONVIF discovery resolves the path', () => {
    const target = resolveCameraTarget({ brandKey: 'manual', host: 'cam.local' });
    try {
      assembleRtspUrl(target, CREDENTIAL);
      expect.unreachable('expected a CameraConfigError');
    } catch (error) {
      expect((error as CameraConfigError).code).toBe('stream-path-required');
      assertNoSecrets('assembly error', String((error as Error).message));
    }
  });

  it('builds a credential-free ONVIF device service URL', () => {
    const target = resolveCameraTarget({ brandKey: 'tplink-tapo-vigi', host: 'cam.local' });
    const url = onvifDeviceServiceUrl(target);

    expect(url).toBe('http://cam.local:2020/onvif/device_service');
    expect(url).not.toContain(PASSWORD);
  });
});
