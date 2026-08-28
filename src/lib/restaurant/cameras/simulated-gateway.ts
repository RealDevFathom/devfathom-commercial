/**
 * CAM-L2A — simulated camera gateway for the adapter path.
 *
 * Lets the whole brand-adapter flow be exercised without hardware. It is
 * selected explicitly by tests and development callers; there is no environment
 * variable that turns it on in production, and it performs no network access.
 *
 * It derives the three probe outcomes from real matching rules — host, ports,
 * credential, stream path — rather than echoing a caller-supplied answer, so a
 * passing test says something about the adapter.
 *
 * It proves no vendor authentication, VLAN routing, firmware-specific stream
 * paths, or hardware retention behavior. Those remain hardware-pilot checks.
 */
import type { CameraProbe, CameraProbeResult, ResolvedCameraTarget } from './contract';
import { assembleRtspUrl } from './rtsp';

export type SimulatedCamera = {
  host: string;
  username: string;
  password: string;
  /** Defaults to accepting whatever port the target resolved to. */
  rtspPort?: number;
  onvifPort?: number;
  /**
   * Paths this device actually serves. The first entry is what ONVIF Profile S
   * discovery returns when the operator supplied no path. When omitted, any
   * path is accepted.
   */
  streamPaths?: readonly string[];
  discoveredProfile?: string;
  /**
   * Simulates an RTSP client library that embeds the authenticated URL in its
   * error message — the exact leak the adapter must swallow.
   */
  throwsLeakyError?: boolean;
};

/** Credential-free record of one probe, safe to assert on and safe to print. */
export type SimulatedProbeAttempt = {
  brandKey: string;
  host: string;
  rtspPort: number;
  onvifPort: number;
  streamPath: string | null;
  streamPathSource: ResolvedCameraTarget['streamPathSource'];
  outcome: CameraProbeResult['outcome'] | 'threw';
};

export type SimulatedCameraNetwork = {
  probe: CameraProbe;
  /** Every probe seen, in order. Never contains a credential or an RTSP URL. */
  attempts: readonly SimulatedProbeAttempt[];
};

const DEFAULT_PROFILE = 'ONVIF Profile S';

function portsMatch(device: SimulatedCamera, target: ResolvedCameraTarget): boolean {
  if (device.rtspPort !== undefined && device.rtspPort !== target.rtspPort) return false;
  if (device.onvifPort !== undefined && device.onvifPort !== target.onvifPort) return false;
  return true;
}

/**
 * Builds a probe over a fixed set of simulated devices.
 *
 * A host that is not present is `unreachable`; a present host with the wrong
 * username or password is `auth-failed`; a full match is `ok`.
 */
export function createSimulatedCameraNetwork(
  cameras: readonly SimulatedCamera[]
): SimulatedCameraNetwork {
  const byHost = new Map(cameras.map((camera) => [camera.host.toLowerCase(), camera]));
  const attempts: SimulatedProbeAttempt[] = [];

  const record = (
    target: ResolvedCameraTarget,
    outcome: SimulatedProbeAttempt['outcome']
  ): void => {
    attempts.push({
      brandKey: target.brandKey,
      host: target.host,
      rtspPort: target.rtspPort,
      onvifPort: target.onvifPort,
      streamPath: target.streamPath,
      streamPathSource: target.streamPathSource,
      outcome,
    });
  };

  const probe: CameraProbe = async (target, credential) => {
    const device = byHost.get(target.host);

    if (!device || !portsMatch(device, target)) {
      record(target, 'unreachable');
      return { outcome: 'unreachable' };
    }

    if (device.username !== credential.username || device.password !== credential.password) {
      record(target, 'auth-failed');
      return { outcome: 'auth-failed' };
    }

    if (device.throwsLeakyError) {
      record(target, 'threw');
      // Deliberately leaks the password so the adapter's swallow is load-bearing.
      const leaked = target.streamPath
        ? assembleRtspUrl(target, credential)
        : `rtsp://${credential.username}:${credential.password}@${target.host}`;
      throw new Error(`RTSP transport failed for ${leaked}`);
    }

    // ONVIF Profile S discovery when the operator supplied no path.
    const resolvedPath = target.streamPath ?? device.streamPaths?.[0] ?? null;
    if (!resolvedPath) {
      record(target, 'unreachable');
      return { outcome: 'unreachable' };
    }

    if (device.streamPaths && !device.streamPaths.includes(resolvedPath)) {
      record(target, 'unreachable');
      return { outcome: 'unreachable' };
    }

    record(target, 'ok');
    return { outcome: 'ok', discoveredProfile: device.discoveredProfile ?? DEFAULT_PROFILE };
  };

  return { probe, attempts };
}
