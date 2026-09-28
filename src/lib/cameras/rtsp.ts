/**
 * CAM-L2A — RTSP URL assembly. Gateway provisioning use only.
 *
 * This is the single module in the lane that touches a credential. Its output
 * is a fully-authenticated RTSP URL and must never be returned to a console,
 * embedded in an error, or written to a log. Hand it straight to the local
 * gateway and let it go out of scope.
 *
 * Everything an operator surface needs is on `ResolvedCameraTarget`, which is
 * credential-free by construction.
 */
import { CameraConfigError, type CameraCredential, type ResolvedCameraTarget } from './contract';

/**
 * Builds `rtsp://user:pass@host:port/path`.
 *
 * The caller must have a concrete stream path. A target still awaiting ONVIF
 * discovery has none, and assembling a URL for it would silently invent one.
 *
 * @internal Gateway provisioning only — never expose the return value.
 */
export function assembleRtspUrl(
  target: ResolvedCameraTarget,
  credential: CameraCredential
): string {
  if (!target.streamPath) {
    throw new CameraConfigError(
      'stream-path-required',
      'Cannot assemble an RTSP URL before the stream path is known.'
    );
  }

  // Percent-encode so ':' '@' or '/' inside a password cannot restructure the URL.
  const user = encodeURIComponent(credential.username);
  const secret = encodeURIComponent(credential.password);
  const path = target.streamPath.startsWith('/') ? target.streamPath : `/${target.streamPath}`;

  return `rtsp://${user}:${secret}@${target.host}:${target.rtspPort}${path}`;
}

/** ONVIF device-service endpoint used for Profile S discovery. Credential-free. */
export function onvifDeviceServiceUrl(target: ResolvedCameraTarget): string {
  return `http://${target.host}:${target.onvifPort}/onvif/device_service`;
}

/**
 * The only camera identity that may reach a log sink: brand and network
 * coordinates, never a credential and never an assembled URL.
 */
export function formatCameraTargetForLog(target: ResolvedCameraTarget): string {
  return `camera brand=${target.brandKey} host=${target.host} rtspPort=${target.rtspPort} onvifPort=${target.onvifPort} transport=${target.transport}`;
}
