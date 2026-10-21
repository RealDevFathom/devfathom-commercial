/**
 * CAM-L2A — simulated gateway coverage for the three probe outcomes.
 *
 * The simulator must derive outcomes from real matching rules; if it simply
 * echoed a caller-supplied answer, the adapter tests built on it would prove
 * nothing.
 */
import { describe, expect, it } from 'vitest';

import { testCameraConnection } from './adapters';
import type { CameraCredential } from './contract';
import { createSimulatedCameraNetwork } from './simulated-gateway';

const PASSWORD = 'p@ss:w/rd#1';
const CREDENTIAL: CameraCredential = { username: 'onvif_user', password: PASSWORD };

function networkWithOneCamera() {
  return createSimulatedCameraNetwork([
    {
      host: 'cam.local',
      username: CREDENTIAL.username,
      password: PASSWORD,
      rtspPort: 554,
      onvifPort: 2020,
      streamPaths: ['/stream1', '/stream2'],
      discoveredProfile: 'ONVIF Profile S',
    },
  ]);
}

describe('simulated gateway — success', () => {
  it('returns ok with the discovered profile for a full match', async () => {
    const network = networkWithOneCamera();
    const result = await testCameraConnection(
      { brandKey: 'tplink-tapo-vigi', host: 'cam.local' },
      CREDENTIAL,
      network.probe
    );

    expect(result).toEqual({ outcome: 'ok', discoveredProfile: 'ONVIF Profile S' });
    expect(network.attempts).toHaveLength(1);
    expect(network.attempts[0]).toMatchObject({
      brandKey: 'tplink-tapo-vigi',
      host: 'cam.local',
      streamPath: '/stream1',
      outcome: 'ok',
    });
  });

  it('resolves the path through ONVIF discovery when none was supplied', async () => {
    const network = networkWithOneCamera();
    const result = await testCameraConnection(
      { brandKey: 'manual', host: 'cam.local', onvifPort: 2020 },
      CREDENTIAL,
      network.probe
    );

    expect(result.outcome).toBe('ok');
    expect(network.attempts[0]?.streamPathSource).toBe('onvif-discovery');
  });

  it('accepts the camera sub-stream path', async () => {
    const network = networkWithOneCamera();
    const result = await testCameraConnection(
      { brandKey: 'tplink-tapo-vigi', host: 'cam.local', quality: 'sub' },
      CREDENTIAL,
      network.probe
    );

    expect(result.outcome).toBe('ok');
    expect(network.attempts[0]?.streamPath).toBe('/stream2');
  });
});

describe('simulated gateway — authentication failure', () => {
  it('rejects a wrong password on a reachable camera', async () => {
    const network = networkWithOneCamera();
    const result = await testCameraConnection(
      { brandKey: 'tplink-tapo-vigi', host: 'cam.local' },
      { username: CREDENTIAL.username, password: 'wrong' },
      network.probe
    );

    expect(result).toEqual({ outcome: 'auth-failed' });
    expect(network.attempts[0]?.outcome).toBe('auth-failed');
  });

  it('rejects a wrong username on a reachable camera', async () => {
    const network = networkWithOneCamera();
    const result = await testCameraConnection(
      { brandKey: 'tplink-tapo-vigi', host: 'cam.local' },
      { username: 'admin', password: PASSWORD },
      network.probe
    );

    expect(result).toEqual({ outcome: 'auth-failed' });
  });

  it('distinguishes auth failure from unreachability', async () => {
    const network = networkWithOneCamera();
    const authFailed = await testCameraConnection(
      { brandKey: 'tplink-tapo-vigi', host: 'cam.local' },
      { username: CREDENTIAL.username, password: 'wrong' },
      network.probe
    );
    const unreachable = await testCameraConnection(
      { brandKey: 'tplink-tapo-vigi', host: 'absent.local' },
      CREDENTIAL,
      network.probe
    );

    expect(authFailed.outcome).toBe('auth-failed');
    expect(unreachable.outcome).toBe('unreachable');
  });
});

describe('simulated gateway — unreachable', () => {
  it('reports an unknown host as unreachable', async () => {
    const network = networkWithOneCamera();
    const result = await testCameraConnection(
      { brandKey: 'manual', host: 'absent.local', streamPath: '/stream1' },
      CREDENTIAL,
      network.probe
    );

    expect(result).toEqual({ outcome: 'unreachable' });
  });

  it('reports a wrong RTSP port as unreachable, not auth-failed', async () => {
    const network = networkWithOneCamera();
    const result = await testCameraConnection(
      { brandKey: 'tplink-tapo-vigi', host: 'cam.local', rtspPort: 8554 },
      CREDENTIAL,
      network.probe
    );

    expect(result).toEqual({ outcome: 'unreachable' });
  });

  it('reports a wrong ONVIF port as unreachable', async () => {
    const network = networkWithOneCamera();
    // Hikvision's preset ONVIF port is 80; this camera answers on 2020.
    const result = await testCameraConnection(
      { brandKey: 'hikvision-ezviz', host: 'cam.local' },
      CREDENTIAL,
      network.probe
    );

    expect(result).toEqual({ outcome: 'unreachable' });
  });

  it('reports a stream path the camera does not serve as unreachable', async () => {
    const network = networkWithOneCamera();
    const result = await testCameraConnection(
      { brandKey: 'manual', host: 'cam.local', onvifPort: 2020, streamPath: '/nope' },
      CREDENTIAL,
      network.probe
    );

    expect(result).toEqual({ outcome: 'unreachable' });
  });

  it('reports unreachable when discovery finds no path at all', async () => {
    const network = createSimulatedCameraNetwork([
      { host: 'silent.local', username: CREDENTIAL.username, password: PASSWORD, streamPaths: [] },
    ]);
    const result = await testCameraConnection(
      { brandKey: 'manual', host: 'silent.local' },
      CREDENTIAL,
      network.probe
    );

    expect(result).toEqual({ outcome: 'unreachable' });
  });
});

describe('simulated gateway — containment', () => {
  it('performs no network access and needs no environment flag', async () => {
    const network = createSimulatedCameraNetwork([]);
    const result = await testCameraConnection(
      { brandKey: 'manual', host: 'cam.local', streamPath: '/s' },
      CREDENTIAL,
      network.probe
    );

    expect(result).toEqual({ outcome: 'unreachable' });
  });

  it('records attempts without credentials or assembled URLs', async () => {
    const network = networkWithOneCamera();
    await testCameraConnection(
      { brandKey: 'tplink-tapo-vigi', host: 'cam.local' },
      CREDENTIAL,
      network.probe
    );
    await testCameraConnection(
      { brandKey: 'tplink-tapo-vigi', host: 'cam.local' },
      { username: 'admin', password: 'hunter2' },
      network.probe
    );

    const serialized = JSON.stringify(network.attempts);
    expect(network.attempts).toHaveLength(2);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('onvif_user');
    expect(serialized).not.toContain('rtsp://');
  });
});
